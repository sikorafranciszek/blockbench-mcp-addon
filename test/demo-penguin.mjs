// Builds, paints and animates a small penguin the way an AI client would.
// usage: node test/demo-penguin.mjs [output directory]
import { resolve } from 'node:path';
import { call, saveImage } from './client.mjs';

const outDir = resolve(process.argv[2] || 'test/output');

await call('new_project', { format: 'bedrock', name: 'penguin', texture_width: 64 });

await call('add_elements', { elements: [{
	name: 'root', origin: [0, 0, 0], children: [
		{ name: 'body', origin: [0, 3, 0], children: [
			{ name: 'torso', from: [-4, 3, -3], to: [4, 13, 3] },
			{ name: 'head', origin: [0, 13, 0], children: [
				{ name: 'skull', from: [-3, 13, -3], to: [3, 19, 3] },
				{ name: 'beak', from: [-1, 15, -5], to: [1, 16, -3] },
			] },
			{ name: 'wing_left', origin: [4, 12, 0], children: [{ name: 'wing_left_cube', from: [4, 5, -2], to: [5, 12, 2] }] },
		] },
		{ name: 'foot_left', origin: [2, 3, 0], children: [{ name: 'foot_left_cube', from: [1, 0, -3], to: [3, 3, 1] }] },
	],
}] });
await call('duplicate_elements', { targets: ['wing_left', 'foot_left'], mirror_axis: 'x' });
await call('generate_texture_template', { name: 'penguin', resolution: 16 });

const BLACK = ['#23262e', '#2b2f39', '#1d2027'];
const ORANGE = ['#f09a2a', '#e48a1c', '#f5ab45'];
await call('paint_faces', { paints: [
	{ target: 'torso', ops: [{ op: 'noise', colors: BLACK }] },
	{ target: 'torso', faces: ['north'], ops: [{ op: 'rect', x: 1, y: 1, w: 6, h: 9, color: '#eef1f4' }, { op: 'noise', x: 1, y: 1, w: 6, h: 9, colors: ['#dfe4ea'], density: 0.15 }] },
	{ target: 'skull', ops: [{ op: 'noise', colors: BLACK }] },
	{ target: 'skull', faces: ['north'], ops: [{ op: 'pixels', x: 0, y: 1, rows: ['.wwww.', '.ewwe.', '.wwww.'], palette: { w: '#eef1f4', e: '#101114' } }] },
	{ target: 'beak', ops: [{ op: 'noise', colors: ORANGE }] },
	{ target: 'wing_left_cube', ops: [{ op: 'noise', colors: BLACK }] },
	{ target: 'wing_right_cube', ops: [{ op: 'noise', colors: BLACK }] },
	{ target: 'foot_left_cube', ops: [{ op: 'noise', colors: ORANGE }] },
	{ target: 'foot_right_cube', ops: [{ op: 'noise', colors: ORANGE }] },
] });

await call('create_animation', { name: 'animation.penguin.waddle', length: 1 });
const sway = (bone, axis, amount, phases = [0, 0.25, 0.5, 0.75, 1]) => phases.map((time, i) => {
	const value = [0, 0, 0];
	value[axis] = [0, amount, 0, -amount, 0][i];
	return { bone, channel: 'rotation', time, value };
});
await call('add_keyframes', { keyframes: [
	...sway('body', 2, 8),
	...sway('wing_left', 2, -35),
	...sway('wing_right', 2, 35),
	...sway('foot_left', 0, 25),
	...sway('foot_right', 0, -25),
] });

saveImage(outDir, 'penguin.png', (await call('capture_preview', { views: ['north', 'iso_nw', 'iso_se', 'east'] })).images[0]);
saveImage(outDir, 'penguin_pose.png', (await call('capture_preview', { views: ['north'], animation: 'animation.penguin.waddle', time: 0.25 })).images[0]);
saveImage(outDir, 'penguin_texture.png', (await call('get_texture', { show_uv: true })).images[0]);
console.log(JSON.stringify((await call('validate_model')).data));
await call('save_project', { path: resolve(outDir, 'penguin.bbmodel'), overwrite: true });
console.log('saved', resolve(outDir, 'penguin.bbmodel'));
