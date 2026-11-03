// End-to-end test against a running Blockbench with the plugin loaded.
// usage: node test/smoke.mjs [output directory]
// Creates its own project tabs and closes them at the end; writes files only inside the output directory.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { call, expectError, rpc, saveImage, URL_MCP } from './client.mjs';

const outDir = resolve(process.argv[2] || 'test/output');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const projectsBefore = (await call('get_state')).data.open_projects.map((p) => p.id);
const results = [];
async function step(name, work) {
	try {
		await work();
		results.push(['ok', name]);
		console.log(`  ok    ${name}`);
	} catch (err) {
		results.push(['FAIL', name]);
		console.log(`  FAIL  ${name}\n        ${err.message}`);
	}
}
const out = (file) => resolve(outDir, file);
const shot = async (file, args) => {
	const { images } = await call('capture_preview', args);
	assert.equal(images.length, 1);
	assert.ok(images[0].data.length > 500, 'image is too small to be real');
	return saveImage(outDir, file, images[0]);
};

await step('initialize negotiates protocol and sends instructions', async () => {
	const result = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
	assert.equal(result.protocolVersion, '2025-06-18');
	assert.equal(result.serverInfo.name, 'blockbench');
	assert.match(result.instructions, /16 units/);
});

await step('notifications get 202 with no body', async () => {
	const response = await fetch(URL_MCP, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
	assert.equal(response.status, 202);
	assert.equal(await response.text(), '');
});

await step('browser origins and wrong methods are refused', async () => {
	const evil = await fetch(URL_MCP, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
	assert.equal(evil.status, 403);
	assert.equal((await fetch(URL_MCP)).status, 405);
});

await step('tools/list hides run_script by default', async () => {
	const { tools } = await rpc('tools/list');
	assert.ok(tools.length >= 25, `only ${tools.length} tools`);
	assert.ok(!tools.some((t) => t.name === 'run_script'));
	await expectError('run_script', { code: 'return 1' }, /Unknown tool/);
});

await step('list_formats and get_state', async () => {
	const { data } = await call('list_formats');
	for (const id of ['java_block', 'bedrock', 'free', 'skin', 'image']) assert.ok(data.formats.some((f) => f.id === id), id);
	assert.ok(data.skin_models.includes('creeper'));
	assert.ok(data.export_codecs.some((c) => c.id === 'gltf'));
	assert.ok((await call('get_state')).data.blockbench_version);
});

await step('bad arguments give useful errors', async () => {
	await expectError('new_project', { format: 'nope' }, /Available/);
	await expectError('new_project', {}, /format is required/);
	await expectError('new_project', { format: 'free', colour: 1 }, /not a known field/);
});

// --- Java block with per-face painting
await step('java_block: build, template, paint faces, capture', async () => {
	await call('new_project', { format: 'java_block', name: 'smoke_block', texture_width: 16 });
	const { data } = await call('add_elements', { elements: [
		{ name: 'base', from: [0, 0, 0], to: [16, 8, 16] },
		{ name: 'post', center: [8, 12, 8], size: [4, 8, 4] },
		{ name: 'tilted', from: [2, 8, 2], to: [4, 12, 4], rotation: [22.5, 0, 0] },
	] });
	assert.equal(data.created.length, 3);
	assert.equal(data.warnings, undefined);
	assert.deepEqual(data.created[1].from, [6, 8, 6]);
	const template = await call('generate_texture_template', { name: 'block' });
	assert.equal(template.data.texture.name, 'block');
	assert.ok(template.data.texture.width >= 16);
	const painted = await call('paint_faces', { paints: [
		{ target: 'base', faces: ['all'], ops: [{ op: 'fill', color: '#7a5230' }, { op: 'rect', x: 0, y: 0, w: 2, h: 2, color: '#ff0000' }] },
		{ target: 'base', faces: ['north'], ops: [{ op: 'rect', y: 7, h: 1, color: '#00ff00' }] },
		{ target: 'post', ops: [{ op: 'noise', colors: ['#c0c0c0', '#a8a8a8', '#909090'] }] },
		{ target: 'tilted', ops: [{ op: 'fill', color: '#3060ff' }] },
	] });
	assert.deepEqual(painted.data.painted[0].faces.up, [16, 16]);
	assert.deepEqual(painted.data.painted[0].faces.north, [16, 8]);
	await shot('java_block.png', { views: ['iso_nw', 'iso_se', 'north', 'top'] });
	saveImage(outDir, 'java_block_texture.png', (await call('get_texture', { show_uv: true, grid: true })).images[0]);
	const pixels = (await call('get_texture', { as_text: true, region: { x: 0, y: 0, w: 4, h: 4 } })).data.pixels;
	assert.equal(pixels.rows.length, 4);
});

await step('java_block: mesh refused, validator runs', async () => {
	await expectError('add_elements', { elements: [{ type: 'mesh', primitive: { type: 'sphere' } }] }, /does not support meshes/);
	const validation = await call('validate_model');
	assert.ok(Array.isArray(validation.data.warnings));
});

await step('undo and redo cover add, update and delete', async () => {
	const count = async () => (await call('get_state')).data.project.counts.cubes;
	const start = await count();
	await call('add_elements', { elements: [{ name: 'temp', from: [0, 0, 0], to: [1, 1, 1] }] });
	assert.equal(await count(), start + 1);
	await call('undo');
	assert.equal(await count(), start);
	await call('redo');
	assert.equal(await count(), start + 1);
	await call('update_elements', { updates: [{ target: 'temp', to: [2, 2, 2], name: 'temp2' }] });
	assert.deepEqual((await call('get_outliner', { target: 'temp2' })).data.to, [2, 2, 2]);
	await call('undo');
	assert.deepEqual((await call('get_outliner', { target: 'temp' })).data.to, [1, 1, 1]);
	await call('delete_elements', { targets: ['temp'] });
	assert.equal(await count(), start);
	await call('undo');
	assert.equal(await count(), start + 1);
	await call('delete_elements', { targets: ['temp'] });
	assert.equal(await count(), start);
});

await step('java_block: save and export, refusing to overwrite', async () => {
	const bbmodel = out('block.bbmodel');
	const json = out('block.json');
	const png = out('block.png');
	await call('save_project', { path: bbmodel });
	assert.equal(JSON.parse(readFileSync(bbmodel, 'utf8')).meta.model_format, 'java_block');
	await call('export_model', { codec: 'java_block', path: json });
	assert.ok(JSON.parse(readFileSync(json, 'utf8')).elements.length >= 3);
	await expectError('export_model', { codec: 'java_block', path: json }, /already exists/);
	await call('export_model', { codec: 'java_block', path: json, overwrite: true });
	await call('save_texture', { path: png });
	assert.ok(existsSync(png));
	await expectError('save_texture', { path: 'relative/path.png' }, /absolute/);
});

await step('open_file reloads a saved project', async () => {
	await call('open_file', { path: out('block.bbmodel') });
	const { data } = await call('get_state');
	assert.equal(data.project.format, 'java_block');
	assert.ok(data.project.counts.cubes >= 3);
	assert.equal(data.textures.length, 1);
	await call('close_project');
});

// --- Bedrock entity with bones, box UV, mirror and animation
await step('bedrock: nested bones, mirror, box UV painting', async () => {
	await call('new_project', { format: 'bedrock', name: 'smoke_entity', texture_width: 64 });
	await call('add_elements', { elements: [{
		name: 'body', origin: [0, 12, 0], children: [
			{ name: 'torso', from: [-4, 12, -2], to: [4, 24, 2] },
			{ name: 'head', origin: [0, 24, 0], children: [{ name: 'skull', from: [-4, 24, -4], to: [4, 32, 4] }] },
			{ name: 'arm_left', origin: [5, 22, 0], children: [{ name: 'arm_left_cube', from: [4, 12, -2], to: [8, 24, 2] }] },
		],
	}] });
	const mirrored = await call('duplicate_elements', { targets: ['arm_left'], mirror_axis: 'x' });
	assert.equal(mirrored.data.created[0].name, 'arm_right');
	assert.deepEqual(mirrored.data.created[0].origin, [-5, 22, 0]);
	assert.deepEqual(mirrored.data.created[0].children[0].from, [-8, 12, -2]);
	assert.equal(mirrored.data.created[0].children[0].name, 'arm_right_cube');
	await call('generate_texture_template', { name: 'entity' });
	const faces = await call('paint_faces', { paints: [
		{ target: 'torso', ops: [{ op: 'fill', color: '#2e7d32' }] },
		{ target: 'arm_left', ops: [{ op: 'fill', color: '#c68642' }] },
		{ target: 'arm_right', ops: [{ op: 'fill', color: '#c68642' }] },
		{ target: 'skull', ops: [{ op: 'fill', color: '#c68642' }] },
		{ target: 'skull', faces: ['north'], ops: [{ op: 'pixels', x: 1, y: 3, rows: ['aa..aa', '......', '..bb..'], palette: { a: '#ffffff', b: '#7a3b12' } }] },
	] });
	assert.deepEqual(faces.data.painted[3].faces.north, [8, 8]);
	await shot('bedrock.png', { views: ['north', 'iso_nw', 'iso_se', 'east'] });
	saveImage(outDir, 'bedrock_texture.png', (await call('get_texture', { show_uv: true })).images[0]);
	await call('export_model', { codec: 'bedrock', path: out('entity.geo.json') });
	const geo = JSON.parse(readFileSync(out('entity.geo.json'), 'utf8'));
	assert.ok(geo['minecraft:geometry'][0].bones.length >= 4);
});

await step('bedrock: animation with pose preview', async () => {
	await call('create_animation', { name: 'animation.smoke.wave', length: 1 });
	const added = await call('add_keyframes', { keyframes: [
		{ bone: 'arm_left', channel: 'rotation', time: 0, value: [0, 0, 0] },
		{ bone: 'arm_left', channel: 'rotation', time: 0.5, value: [0, 0, -120] },
		{ bone: 'arm_left', channel: 'rotation', time: 1, value: [0, 0, 0] },
		{ bone: 'head', channel: 'rotation', time: 0, value: ['math.sin(query.anim_time*360)*10', 0, 0] },
	] });
	assert.equal(added.data.added, 4);
	const listed = (await call('list_animations')).data;
	assert.equal(listed[0].name, 'animation.smoke.wave');
	assert.equal(listed[0].bones.find((b) => b.bone === 'arm_left').keyframes.length, 3);
	await shot('bedrock_pose_rest.png', { views: ['north'], animation: 'animation.smoke.wave', time: 0 });
	await shot('bedrock_pose_wave.png', { views: ['north'], animation: 'animation.smoke.wave', time: 0.5 });
	assert.equal((await call('get_state')).data.project.mode, 'edit');
});

// --- Free format with meshes
await step('free: mesh primitives and raw geometry', async () => {
	await call('new_project', { format: 'free', name: 'smoke_mesh' });
	const { data } = await call('add_elements', { elements: [
		{ name: 'ball', position: [-14, 6, 0], primitive: { type: 'sphere', radius: 6, sides: 16, rings: 10 } },
		{ name: 'can', position: [0, 0, 0], primitive: { type: 'cylinder', radius: 4, height: 12, sides: 12 } },
		{ name: 'spike', position: [12, 0, 0], primitive: { type: 'cone', radius: 4, height: 12, sides: 8 } },
		{ name: 'ring', position: [26, 4, 0], primitive: { type: 'torus', radius: 6, tube_radius: 2, sides: 16, rings: 8 } },
		{ name: 'quad', vertices: [[-8, 0, 12], [8, 0, 12], [8, 0, 28], [-8, 0, 28]], polygons: [[0, 3, 2, 1]] },
		{ name: 'marker', type: 'locator', position: [0, 16, 0] },
	] });
	assert.equal(data.created.length, 6);
	assert.equal(data.created[0].type, 'mesh');
	await shot('meshes.png', { views: ['iso_nw', 'iso_se'], projection: 'perspective' });
	await shot('meshes_wire.png', { views: ['iso_nw'], view_mode: 'wireframe' });
	const template = await call('generate_texture_template', { name: 'mesh_atlas', color: '#c08040' });
	assert.ok(template.data.texture.width >= 16);
	await shot('meshes_textured.png', { views: ['iso_nw'] });
	await call('export_model', { codec: 'obj', path: out('meshes.obj') });
	assert.ok(existsSync(out('meshes.obj')));
	await call('export_model', { codec: 'gltf', path: out('meshes.gltf') });
	assert.ok(existsSync(out('meshes.gltf')));
});

// --- 2D art
await step('image: pixel art', async () => {
	await call('new_project', { format: 'image', name: 'smoke_sword', texture_width: 16, texture_height: 16 });
	await call('paint_texture', { ops: [
		{ op: 'line', x1: 2, y1: 13, x2: 12, y2: 3, color: '#cfd8dc' },
		{ op: 'line', x1: 3, y1: 13, x2: 13, y2: 3, color: '#90a4ae' },
		{ op: 'rect', x: 1, y: 11, w: 4, h: 1, color: '#6d4c41' },
		{ op: 'ellipse', x: 11, y: 1, w: 4, h: 4, color: '#ffd54f' },
		{ op: 'replace_color', from: '#90a4ae', to: '#78909c' },
	] });
	await shot('image.png', {});
	await call('save_texture', { path: out('sword.png') });
	assert.ok(readFileSync(out('sword.png')).length > 50);
	const { data } = await call('get_state');
	assert.equal(data.project.format, 'image');
	assert.equal(data.textures[0].width, 16);
});

await step('texture in a model project: create, import, apply', async () => {
	await call('new_project', { format: 'java_block', name: 'smoke_tex' });
	await call('add_elements', { elements: [{ name: 'cube', from: [0, 0, 0], to: [16, 16, 16] }] });
	const created = await call('create_texture', { name: 'stone', width: 16, fill: '#808080', apply_to: ['*'], ops: [{ op: 'noise', colors: ['#707070', '#909090'], density: 0.5 }] });
	assert.equal(created.data.name, 'stone.png');
	await call('import_texture', { source: out('sword.png'), name: 'sword.png' });
	await call('apply_texture', { texture: 'sword.png', targets: ['cube'], faces: ['north'] });
	const faces = (await call('get_outliner', { target: 'cube', detail: true })).data.faces;
	assert.equal(faces.north.texture, 'sword.png');
	assert.equal(faces.up.texture, 'stone.png');
	await shot('textured_cube.png', { views: ['iso_nw'] });
});

// Face coordinates must follow the view from outside whatever the UV layout says.
await step('paint_faces follows flipped and rotated UVs', async () => {
	await call('new_project', { format: 'free', name: 'smoke_faces' });
	assert.equal((await call('create_texture', { name: 'atlas', width: 64 })).data.uv_width, 64);
	const cube = (name, x, north) => ({ name, from: [x, 0, 0], to: [x + 8, 8, 8], box_uv: false, faces: { north } });
	await call('add_elements', { elements: [
		cube('r0', 0, { uv: [0, 0, 8, 8], texture: 'atlas' }),
		cube('r90', 10, { uv: [8, 0, 16, 8], texture: 'atlas', rotation: 90 }),
		cube('r180', 20, { uv: [16, 0, 24, 8], texture: 'atlas', rotation: 180 }),
		cube('r270', 30, { uv: [24, 0, 32, 8], texture: 'atlas', rotation: 270 }),
		cube('flipx', 40, { uv: [40, 0, 32, 8], texture: 'atlas' }),
		cube('flipy', 50, { uv: [40, 8, 48, 0], texture: 'atlas' }),
	] });
	const marker = [{ op: 'fill', color: '#ffffff' }, { op: 'rect', x: 0, y: 0, w: 3, h: 3, color: '#ff0000' }, { op: 'rect', x: 5, y: 0, w: 3, h: 1, color: '#0000ff' }];
	await call('paint_faces', { paints: ['r0', 'r90', 'r180', 'r270', 'flipx', 'flipy'].map((target) => ({ target, faces: ['north'], ops: marker })) });
	await shot('face_orientation.png', { views: ['north'], width: 900, height: 300 });
	saveImage(outDir, 'face_orientation_texture.png', (await call('get_texture')).images[0]);
});

await step('skin: player and vanilla mob models', async () => {
	await call('new_project', { format: 'skin', skin_model: 'creeper', name: 'smoke_creeper' });
	assert.ok((await call('get_state')).data.project.counts.cubes >= 6);
	await shot('skin_creeper.png', { views: ['iso_nw'] });
	await call('new_project', { format: 'skin', name: 'smoke_skin' });
	await expectError('new_project', { format: 'skin', skin_model: 'nope' }, /Unknown skin_model/);
	assert.equal((await call('get_state')).data.project.format, 'skin', 'a refused skin_model must leave the open project working');
	const { data } = await call('get_state');
	assert.ok(data.project.counts.cubes >= 6, `${data.project.counts.cubes} cubes`);
	await call('paint_faces', { paints: [{ target: 'Head', faces: ['north'], ops: [{ op: 'fill', color: '#e0ac69' }, { op: 'rect', x: 1, y: 3, w: 2, h: 1, color: '#2244aa' }, { op: 'rect', x: 5, y: 3, w: 2, h: 1, color: '#2244aa' }] }] });
	await shot('skin.png', { views: ['north', 'iso_nw'] });
	saveImage(outDir, 'skin_texture.png', (await call('get_texture', { show_uv: true })).images[0]);
});

await step('dialogs are reported and can be dismissed', async () => {
	const none = await rpc('tools/call', { name: 'dismiss_dialog', arguments: {} });
	assert.match(none.content[0].text, /No dialog/);
});

await step('capture_window returns the app window', async () => {
	const { images } = await call('capture_window');
	assert.ok(images[0].data.length > 1000);
	saveImage(outDir, 'window.png', images[0]);
});

await step('cleanup: closing a dirty project needs consent', async () => {
	await expectError('close_project', {}, /unsaved/);
	const { data } = await call('get_state');
	for (const project of data.open_projects.filter((p) => !projectsBefore.includes(p.id))) {
		await call('switch_project', { project: project.id });
		await call('close_project', { discard_changes: true });
	}
});

const failed = results.filter(([state]) => state !== 'ok');
console.log(`\n${results.length - failed.length}/${results.length} passed. Images: ${outDir}`);
process.exit(failed.length ? 1 : 0);
