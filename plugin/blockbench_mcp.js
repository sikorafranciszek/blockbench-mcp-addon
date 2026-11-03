/*
 * Blockbench MCP - lets AI assistants model, paint and animate inside Blockbench.
 *
 * The plugin runs a Model Context Protocol server (Streamable HTTP, JSON responses)
 * on 127.0.0.1. Blockbench does not let plugins use the "http" module, so the small
 * HTTP/1.1 layer below is written directly on top of "net".
 */
(function () {
	'use strict';

	const PLUGIN_ID = 'blockbench_mcp';
	const VERSION = '1.1.0';
	const DEFAULT_PORT = 3939;
	const MAX_BODY_BYTES = 64 * 1024 * 1024;
	const TOOL_TIMEOUT_MS = 120000;
	const REMOTE_KEY_STORAGE = 'mcp_remote_key';
	const NGROK_AGENT_PORT = 4040;
	const nodeCrypto = require('crypto');
	const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

	const INSTRUCTIONS = `You are controlling a live Blockbench window. Everything you do appears immediately on the user's screen, and every tool call is one undo step.

Units and axes: 16 units = 1 Minecraft block. +X = east, +Y = up, +Z = south, -Z = north. Rotations are in degrees around the "origin" pivot.
Block/item models (java_block) live in the 0..16 space; entity formats are centered on 0,0 with Y=0 on the ground. Entities face north (-Z).

Workflow:
1. get_state, then list_formats if you are unsure. new_project picks the format: java_block (block/item), bedrock or modded_entity (entities), free (generic, allows meshes), skin (player skins), image (2D pixel art, icons, block and item textures).
2. Build with add_elements: send the whole tree of groups and cubes in one call. Use groups as bones with sensible pivots, and duplicate_elements with mirror_axis for symmetric limbs.
3. Look at the result with capture_preview after each significant change. Do not assume it looks right: check it and fix what is wrong.
4. Texture: generate_texture_template lays out the UVs and creates the texture, then paint_faces paints each face in its own pixel coordinates, so you never have to compute UV positions. (0,0) is the top-left corner of the face as seen from outside. For 2D art use create_texture + paint_texture. Check with get_texture.
5. Animate with create_animation + add_keyframes; capture_preview takes animation and time to see a pose.
6. validate_model reports problems for the target format. save_project writes the .bbmodel, export_model writes the game file, save_texture writes PNGs.

Pixel art tips: use a small palette, shade with 3-5 tones of each color, and add variation with the noise op instead of flat fills. Rows in the pixels op are the most exact way to draw details.`;

	const FACE_KEYS = ['north', 'east', 'south', 'west', 'up', 'down'];
	const CAMERA_VIEWS = {
		north: [0, 0, -1],
		south: [0, 0, 1],
		east: [1, 0, 0],
		west: [-1, 0, 0],
		top: [0, 1, 0.001],
		bottom: [0, -1, 0.001],
		iso_nw: [-1, 0.82, -1],
		iso_ne: [1, 0.82, -1],
		iso_sw: [-1, 0.82, 1],
		iso_se: [1, 0.82, 1],
	};

	class ToolError extends Error {}
	const fail = (message) => { throw new ToolError(message); };
	const round = (n) => (typeof n === 'number' ? Math.round(n * 10000) / 10000 : n);
	const roundAll = (list) => (list ? Array.from(list, round) : list);
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	// ------------------------------------------------------------------ state lookups

	function requireProject() {
		if (!Project) fail('No project is open. Call new_project or open_file first.');
		return Project;
	}

	function allNodes() {
		return [...Group.all, ...Outliner.elements];
	}

	// A group and a cube often share a name (bone "head" with cube "head"); prefer decides which one is meant.
	function findNode(ref, prefer = Group) {
		requireProject();
		if (OutlinerNode.uuids[ref]) return OutlinerNode.uuids[ref];
		const matches = allNodes().filter((node) => node.name === ref);
		if (matches.length === 1) return matches[0];
		const preferred = matches.filter((node) => node instanceof prefer);
		if (preferred.length === 1) return preferred[0];
		if (matches.length > 1) {
			fail(`"${ref}" matches ${matches.length} nodes, use an id instead: ${matches.map((n) => n.uuid).join(', ')}`);
		}
		fail(`No element or group called "${ref}". Use get_outliner to see what exists.`);
	}

	function findGroup(ref) {
		const node = findNode(ref);
		if (!(node instanceof Group)) fail(`"${ref}" is not a group.`);
		return node;
	}

	function findTexture(ref) {
		requireProject();
		if (ref === undefined || ref === null) {
			const texture = Texture.selected || Texture.getDefault() || Texture.all[0];
			if (!texture) fail('The project has no textures. Use create_texture or generate_texture_template.');
			return texture;
		}
		const matches = Texture.all.filter((t) => t.uuid === ref || t.name === ref || t.name === ref + '.png');
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) fail(`Texture name "${ref}" is ambiguous, use its id: ${matches.map((t) => t.uuid).join(', ')}`);
		fail(`No texture "${ref}". Available: ${Texture.all.map((t) => t.name).join(', ') || 'none'}`);
	}

	function findAnimation(ref) {
		requireProject();
		const animations = Animator.animations.filter((a) => a instanceof Animation);
		if (ref === undefined || ref === null) {
			const animation = Animation.selected || animations[0];
			if (!animation) fail('The project has no animations. Use create_animation.');
			return animation;
		}
		const found = animations.find((a) => a.uuid === ref || a.name === ref);
		if (!found) fail(`No animation "${ref}". Available: ${animations.map((a) => a.name).join(', ') || 'none'}`);
		return found;
	}

	function descendants(group, out = []) {
		for (const child of group.children) {
			out.push(child);
			if (child instanceof Group) descendants(child, out);
		}
		return out;
	}

	function withDescendants(nodes) {
		const result = new Set();
		for (const node of nodes) {
			result.add(node);
			if (node instanceof Group) descendants(node).forEach((child) => result.add(child));
		}
		return [...result];
	}

	const elementsOf = (nodes) => nodes.filter((node) => !(node instanceof Group));
	const groupsOf = (nodes) => nodes.filter((node) => node instanceof Group);

	// ------------------------------------------------------------------ serialization

	function cubeFacePixelSize(cube, faceKey) {
		const face = cube.faces[faceKey];
		const texture = face.getTexture ? face.getTexture() : null;
		const uv = cubeFaceUV(cube, faceKey);
		const scaleX = texture ? texture.width / texture.getUVWidth() : 1;
		const scaleY = texture ? texture.display_height / texture.getUVHeight() : 1;
		const w = Math.abs(uv[2] - uv[0]) * scaleX;
		const h = Math.abs(uv[3] - uv[1]) * scaleY;
		return face.rotation % 180 === 0 ? [Math.round(w), Math.round(h)] : [Math.round(h), Math.round(w)];
	}

	function describeNode(node, detail) {
		const out = { id: node.uuid, type: node.type, name: node.name };
		if (node instanceof Group) {
			out.origin = roundAll(node.origin);
			if (node.rotation.some((v) => v)) out.rotation = roundAll(node.rotation);
			if (node.visibility === false) out.visible = false;
			out.children = node.children.map((child) => describeNode(child, detail));
			return out;
		}
		if (node instanceof Cube) {
			out.from = roundAll(node.from);
			out.to = roundAll(node.to);
			if (detail) {
				out.origin = roundAll(node.origin);
				out.box_uv = node.box_uv;
				if (node.box_uv) out.uv_offset = roundAll(node.uv_offset);
				if (node.mirror_uv) out.mirror_uv = true;
				out.faces = {};
				for (const key of FACE_KEYS) {
					const face = node.faces[key];
					const texture = face.getTexture ? face.getTexture() : null;
					out.faces[key] = {
						uv: roundAll(cubeFaceUV(node, key)),
						pixel_size: cubeFacePixelSize(node, key),
						texture: texture ? texture.name : null,
					};
					if (face.rotation) out.faces[key].rotation = face.rotation;
				}
			}
			if (node.rotation.some((v) => v)) out.rotation = roundAll(node.rotation);
			if (node.inflate) out.inflate = node.inflate;
		} else if (node instanceof Mesh) {
			out.origin = roundAll(node.origin);
			out.vertex_count = Object.keys(node.vertices).length;
			out.face_count = Object.keys(node.faces).length;
			if (node.rotation.some((v) => v)) out.rotation = roundAll(node.rotation);
		} else if (node instanceof Locator) {
			out.position = roundAll(node.position);
		}
		if (node.visibility === false) out.visible = false;
		return out;
	}

	function describeTexture(texture) {
		return {
			id: texture.uuid,
			name: texture.name,
			width: texture.width,
			height: texture.display_height,
			uv_width: texture.getUVWidth(),
			uv_height: texture.getUVHeight(),
			saved: texture.saved,
			path: texture.path || undefined,
			selected: texture.selected || undefined,
		};
	}

	function describeProject() {
		if (!Project) return null;
		return {
			id: Project.uuid,
			name: Project.name,
			format: Format.id,
			texture_resolution: [Project.texture_width, Project.texture_height],
			box_uv: Project.box_uv,
			saved: Project.saved,
			save_path: Project.save_path || undefined,
			export_path: Project.export_path || undefined,
			mode: Mode.selected ? Mode.selected.id : undefined,
			counts: {
				cubes: Cube.all.length,
				meshes: Mesh.all.length,
				groups: Group.all.length,
				textures: Texture.all.length,
				animations: Animator.animations.length,
			},
			capabilities: describeFormat(Format),
		};
	}

	function describeFormat(format) {
		return {
			meshes: !!format.meshes,
			locators: !!format.locators,
			bones: !!format.bone_rig,
			animation: !!format.animation_mode,
			box_uv: format.optional_box_uv ? 'optional' : !!format.box_uv,
			single_texture: !!format.single_texture,
			rotation_limited_to_22_5_steps: !!format.rotation_limit,
			centered_grid: !!format.centered_grid,
		};
	}

	// ------------------------------------------------------------------ undo and paths

	async function undoable(label, aspects, work, finishAspects) {
		Undo.initEdit(aspects);
		try {
			const result = await work();
			Undo.finishEdit('AI: ' + label, finishAspects ? finishAspects(result) : undefined);
			return result;
		} catch (err) {
			Undo.cancelEdit(true);
			throw err;
		}
	}

	function requireAbsolutePath(path) {
		if (!/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(path)) fail(`Path must be absolute, got "${path}".`);
		return path;
	}

	function fileExists(path) {
		// Blockbench reads synchronously on desktop and skips the callback when the file is missing.
		let exists = false;
		Blockbench.read([path], { readtype: 'binary', errorbox: false }, () => { exists = true; });
		return exists;
	}

	function checkWritable(path, overwrite) {
		requireAbsolutePath(path);
		if (!overwrite && fileExists(path)) fail(`"${path}" already exists. Pass overwrite: true to replace it.`);
	}

	// ------------------------------------------------------------------ building elements

	function resolveBounds(spec) {
		if (spec.center && spec.size) {
			return {
				from: spec.center.map((c, i) => c - spec.size[i] / 2),
				to: spec.center.map((c, i) => c + spec.size[i] / 2),
			};
		}
		if (spec.from && spec.size) return { from: spec.from, to: spec.from.map((v, i) => v + spec.size[i]) };
		if (spec.from && spec.to) return { from: spec.from, to: spec.to };
		fail(`Cube "${spec.name || ''}" needs from+to, from+size or center+size.`);
	}

	function applyFaceSpecs(cube, faces) {
		for (const key in faces) {
			if (!cube.faces[key]) fail(`Unknown face "${key}", expected one of ${FACE_KEYS.join(', ')}.`);
			const spec = faces[key];
			const face = cube.faces[key];
			if (spec.uv) face.uv = spec.uv.slice();
			if (spec.rotation !== undefined) face.rotation = spec.rotation;
			if (spec.texture !== undefined) face.texture = spec.texture === null ? null : findTexture(spec.texture).uuid;
			if (spec.enabled === false) face.texture = null;
		}
	}

	function buildCube(spec, parent, warnings) {
		const bounds = resolveBounds(spec);
		const data = { name: spec.name || 'cube', from: bounds.from, to: bounds.to };
		data.origin = spec.origin || bounds.from.map((v, i) => (v + bounds.to[i]) / 2);
		for (const key of ['rotation', 'inflate', 'color', 'mirror_uv', 'shade', 'uv_offset', 'box_uv', 'light_emission']) {
			if (spec[key] !== undefined) data[key] = spec[key];
		}
		if (spec.visible !== undefined) data.visibility = spec.visible;
		if (spec.faces === undefined && Settings.get('autouv')) data.autouv = 1;
		if (Format.rotation_limit && spec.rotation) {
			const axes = spec.rotation.filter((v) => v);
			if (axes.length > 1 || axes.some((v) => Math.abs(v) > 45 || v % 22.5)) {
				warnings.push(`Cube "${data.name}": ${Format.id} allows rotation on one axis only, in 22.5 degree steps up to 45.`);
			}
		}
		const cube = new Cube(data);
		cube.addTo(parent);
		cube.init();
		if (spec.box_uv !== undefined) cube.setUVMode(spec.box_uv);
		if (cube.autouv) cube.mapAutoUV();
		if (spec.faces) applyFaceSpecs(cube, spec.faces);
		if (spec.texture !== undefined) cube.applyTexture(findTexture(spec.texture), true);
		else if (Format.single_texture && Texture.getDefault()) cube.applyTexture(Texture.getDefault(), true);
		return cube;
	}

	function primitiveGeometry(shape) {
		const type = shape.type;
		const radius = shape.radius ?? 4;
		const height = shape.height ?? 8;
		const sides = Math.max(3, Math.min(64, shape.sides ?? 12));
		const rings = Math.max(2, Math.min(32, shape.rings ?? Math.ceil(sides / 2)));
		const vertices = [];
		const faces = [];
		const ring = (r, y) => {
			const start = vertices.length;
			for (let i = 0; i < sides; i++) {
				const a = (i / sides) * Math.PI * 2;
				vertices.push([Math.cos(a) * r, y, Math.sin(a) * r]);
			}
			return start;
		};
		const side = (a, b) => {
			for (let i = 0; i < sides; i++) {
				const next = (i + 1) % sides;
				faces.push([a + i, a + next, b + next, b + i]);
			}
		};
		if (type === 'cylinder' || type === 'cone') {
			const bottom = ring(radius, 0);
			const topRadius = type === 'cone' ? (shape.top_radius ?? 0) : (shape.top_radius ?? radius);
			if (topRadius > 0) {
				const top = ring(topRadius, height);
				side(bottom, top);
				faces.push(Array.from({ length: sides }, (_, i) => top + sides - 1 - i));
			} else {
				vertices.push([0, height, 0]);
				const tip = vertices.length - 1;
				for (let i = 0; i < sides; i++) faces.push([bottom + i, bottom + (i + 1) % sides, tip]);
			}
			faces.push(Array.from({ length: sides }, (_, i) => bottom + i));
		} else if (type === 'sphere') {
			vertices.push([0, -radius, 0]);
			const south = 0;
			const starts = [];
			for (let r = 1; r < rings; r++) {
				const a = -Math.PI / 2 + (r / rings) * Math.PI;
				starts.push(ring(Math.cos(a) * radius, Math.sin(a) * radius));
			}
			vertices.push([0, radius, 0]);
			const north = vertices.length - 1;
			for (let i = 0; i < sides; i++) {
				const next = (i + 1) % sides;
				faces.push([starts[0] + i, starts[0] + next, south]);
				faces.push([starts[starts.length - 1] + next, starts[starts.length - 1] + i, north]);
			}
			for (let r = 0; r < starts.length - 1; r++) side(starts[r], starts[r + 1]);
		} else if (type === 'torus') {
			const tube = shape.tube_radius ?? radius / 3;
			const starts = [];
			for (let r = 0; r < rings; r++) {
				const a = (r / rings) * Math.PI * 2;
				const start = vertices.length;
				for (let i = 0; i < sides; i++) {
					const b = (i / sides) * Math.PI * 2;
					const dist = radius + Math.cos(a) * tube;
					vertices.push([Math.cos(b) * dist, Math.sin(a) * tube, Math.sin(b) * dist]);
				}
				starts.push(start);
			}
			for (let r = 0; r < rings; r++) side(starts[r], starts[(r + 1) % rings]);
		} else if (type === 'plane') {
			const w = shape.width ?? radius * 2;
			const d = shape.depth ?? radius * 2;
			vertices.push([-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, 0, d / 2], [-w / 2, 0, d / 2]);
			faces.push([0, 3, 2, 1]);
		} else {
			fail(`Unknown primitive "${type}". Use sphere, cylinder, cone, torus or plane.`);
		}
		return { vertices, faces };
	}

	function buildMesh(spec, parent) {
		if (!Format.meshes) fail(`Format ${Format.id} does not support meshes. Use cubes, or the "free" format.`);
		const geometry = spec.primitive ? primitiveGeometry(spec.primitive) : { vertices: spec.vertices, faces: spec.polygons };
		if (!geometry.vertices || !geometry.faces) fail(`Mesh "${spec.name || ''}" needs vertices+polygons or a primitive.`);
		const offset = spec.position || [0, 0, 0];
		const mesh = new Mesh({ name: spec.name || 'mesh', vertices: {}, origin: spec.origin || offset, rotation: spec.rotation || [0, 0, 0] });
		if (spec.color !== undefined) mesh.color = spec.color;
		const origin = mesh.origin;
		const keys = mesh.addVertices(...geometry.vertices.map((v) => v.map((c, i) => c + offset[i] - origin[i])));
		for (const indices of geometry.faces) {
			if (indices.length < 2) fail('Mesh faces need at least 2 vertices.');
			const vertices = indices.map((index) => {
				if (keys[index] === undefined) fail(`Mesh face uses vertex ${index}, but there are only ${keys.length}.`);
				return keys[index];
			});
			mesh.addFaces(new MeshFace(mesh, { vertices: orderMeshFace(mesh, vertices) }));
		}
		mesh.addTo(parent);
		mesh.init();
		if (spec.texture !== undefined) {
			const texture = findTexture(spec.texture);
			for (const key in mesh.faces) mesh.faces[key].texture = texture.uuid;
		}
		UVEditor.setAutoSize(null, true, Object.keys(mesh.faces));
		return mesh;
	}

	// Blockbench stores quads in zig-zag order (a b d c); the tool takes them around the perimeter.
	function orderMeshFace(mesh, vertices) {
		return vertices.length === 4 ? [vertices[0], vertices[1], vertices[3], vertices[2]] : vertices;
	}

	function buildNode(spec, parent, created, warnings) {
		const type = spec.type || (spec.children ? 'group' : spec.vertices || spec.primitive ? 'mesh' : 'cube');
		let node;
		if (type === 'group') {
			node = new Group({
				name: spec.name || 'group',
				origin: spec.origin || [0, 0, 0],
				rotation: spec.rotation || [0, 0, 0],
				color: spec.color,
			});
			if (spec.visible !== undefined) node.visibility = spec.visible;
			node.addTo(parent);
			node.init();
			for (const child of spec.children || []) buildNode(child, node, created, warnings);
			if (!spec.origin && node.children.length) node.origin.replace(boundsCenter(descendants(node)));
			if (spec.rotation && spec.rotation.some((v) => v) && !Format.bone_rig) {
				warnings.push(`Group "${node.name}": ${Format.id} ignores group rotation when exported.`);
			}
		} else if (type === 'cube') {
			node = buildCube(spec, parent, warnings);
		} else if (type === 'mesh') {
			node = buildMesh(spec, parent);
		} else if (type === 'locator') {
			if (!Format.locators) fail(`Format ${Format.id} does not support locators.`);
			node = new Locator({ name: spec.name || 'locator', position: spec.position || [0, 0, 0], rotation: spec.rotation || [0, 0, 0] });
			node.addTo(parent);
			node.init();
		} else {
			fail(`Unknown element type "${type}". Use group, cube, mesh or locator.`);
		}
		created.push(node);
		return node;
	}

	function boundsCenter(nodes) {
		const min = [Infinity, Infinity, Infinity];
		const max = [-Infinity, -Infinity, -Infinity];
		for (const node of nodes) {
			if (!(node instanceof Cube)) continue;
			for (let i = 0; i < 3; i++) {
				min[i] = Math.min(min[i], node.from[i], node.to[i]);
				max[i] = Math.max(max[i], node.from[i], node.to[i]);
			}
		}
		if (min[0] === Infinity) return [0, 0, 0];
		return min.map((v, i) => (v + max[i]) / 2);
	}

	function moveNode(node, delta) {
		const add = (list) => { if (list) list.forEach((_, i) => { list[i] += delta[i]; }); };
		if (node instanceof Group) {
			add(node.origin);
			node.children.forEach((child) => moveNode(child, delta));
		} else if (node instanceof Cube) {
			add(node.from);
			add(node.to);
			add(node.origin);
		} else if (node instanceof Locator) {
			add(node.position);
		} else if (node.origin) {
			add(node.origin);
		}
	}

	function mirrorNode(node, axis, center) {
		if (node instanceof Group) {
			node.origin[axis] = 2 * center - node.origin[axis];
			node.rotation[(axis + 1) % 3] *= -1;
			node.rotation[(axis + 2) % 3] *= -1;
			node.children.forEach((child) => mirrorNode(child, axis, center));
		} else if (node.flip) {
			node.flip(axis, center);
		}
	}

	function renameMirrored(name) {
		const swaps = [['left', 'right'], ['Left', 'Right'], ['LEFT', 'RIGHT'], ['_l', '_r'], ['_L', '_R']];
		for (const [a, b] of swaps) {
			if (name.includes(a)) return name.replace(a, b);
			if (name.includes(b)) return name.replace(b, a);
		}
		return name;
	}

	function refreshAll() {
		Canvas.updateAll();
		updateSelection();
	}

	// ------------------------------------------------------------------ painting

	const scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true });

	function parseColor(color) {
		if (typeof color !== 'string') fail(`Expected a color string like "#a0522d", got ${JSON.stringify(color)}.`);
		scratch.fillStyle = '#000000';
		scratch.fillStyle = color;
		const first = scratch.fillStyle;
		scratch.fillStyle = '#ffffff';
		scratch.fillStyle = color;
		if (first !== scratch.fillStyle) fail(`Invalid color "${color}".`);
		return first;
	}

	function colorToRGBA(color) {
		scratch.clearRect(0, 0, 1, 1);
		scratch.fillStyle = parseColor(color);
		scratch.fillRect(0, 0, 1, 1);
		return Array.from(scratch.getImageData(0, 0, 1, 1).data);
	}

	function rgbaToCSS(rgba) {
		return `rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3] / 255})`;
	}

	function mixColors(a, b, t) {
		return a.map((v, i) => Math.round(v + (b[i] - v) * t));
	}

	function seededRandom(seed) {
		let state = seed >>> 0;
		return () => {
			state = (state + 0x6D2B79F5) >>> 0;
			let t = state;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function loadImage(source) {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new ToolError(`Could not load image "${String(source).slice(0, 120)}".`));
			image.src = source.startsWith('data:') ? source : 'file:///' + requireAbsolutePath(source).replace(/\\/g, '/').replace(/^\/+/, '');
		});
	}

	async function preloadOpImages(ops) {
		for (const op of ops) {
			if (op.op === 'image') {
				if (!op.source) fail('The image op needs a source (absolute path or data URL).');
				op._image = await loadImage(op.source);
			}
		}
	}

	function paintOps(ctx, ops, width, height) {
		const plot = (x, y, style) => {
			ctx.fillStyle = style;
			ctx.fillRect(x, y, 1, 1);
		};
		for (const op of ops) {
			const x = op.x ?? 0;
			const y = op.y ?? 0;
			const w = op.w ?? width - x;
			const h = op.h ?? height - y;
			switch (op.op) {
				case 'fill':
					ctx.fillStyle = parseColor(op.color);
					ctx.fillRect(0, 0, width, height);
					break;
				case 'clear':
					ctx.clearRect(x, y, w, h);
					break;
				case 'rect':
					ctx.fillStyle = parseColor(op.color);
					if (op.outline) {
						ctx.fillRect(x, y, w, 1);
						ctx.fillRect(x, y + h - 1, w, 1);
						ctx.fillRect(x, y + 1, 1, h - 2);
						ctx.fillRect(x + w - 1, y + 1, 1, h - 2);
					} else {
						ctx.fillRect(x, y, w, h);
					}
					break;
				case 'pixels': {
					if (!Array.isArray(op.rows)) fail('The pixels op needs rows, e.g. ["aab", "abb"].');
					const palette = {};
					for (const key in op.palette || {}) palette[key] = parseColor(op.palette[key]);
					op.rows.forEach((row, rowIndex) => {
						for (let col = 0; col < row.length; col++) {
							const char = row[col];
							if (char === '.' || char === ' ') continue;
							if (char === '_') {
								ctx.clearRect(x + col, y + rowIndex, 1, 1);
								continue;
							}
							if (!palette[char]) fail(`Character "${char}" in row ${rowIndex} is not in the palette.`);
							plot(x + col, y + rowIndex, palette[char]);
						}
					});
					break;
				}
				case 'points':
					for (const point of op.points || []) plot(point[0], point[1], parseColor(point[2] ?? op.color));
					break;
				case 'line': {
					const style = parseColor(op.color);
					let [x0, y0] = [op.x1, op.y1];
					const [x1, y1] = [op.x2, op.y2];
					const dx = Math.abs(x1 - x0);
					const dy = -Math.abs(y1 - y0);
					const sx = x0 < x1 ? 1 : -1;
					const sy = y0 < y1 ? 1 : -1;
					let err = dx + dy;
					for (;;) {
						plot(x0, y0, style);
						if (x0 === x1 && y0 === y1) break;
						const e2 = 2 * err;
						if (e2 >= dy) { err += dy; x0 += sx; }
						if (e2 <= dx) { err += dx; y0 += sy; }
					}
					break;
				}
				case 'ellipse': {
					const style = parseColor(op.color);
					const inside = (px, py) => {
						const nx = (px + 0.5 - w / 2) / (w / 2);
						const ny = (py + 0.5 - h / 2) / (h / 2);
						return nx * nx + ny * ny <= 1;
					};
					for (let py = 0; py < h; py++) {
						for (let px = 0; px < w; px++) {
							if (!inside(px, py)) continue;
							if (op.outline && inside(px - 1, py) && inside(px + 1, py) && inside(px, py - 1) && inside(px, py + 1)) continue;
							plot(x + px, y + py, style);
						}
					}
					break;
				}
				case 'gradient': {
					const from = colorToRGBA(op.from);
					const to = colorToRGBA(op.to);
					const vertical = op.direction !== 'horizontal';
					const length = vertical ? h : w;
					const steps = op.steps ?? length;
					for (let i = 0; i < length; i++) {
						const raw = length > 1 ? i / (length - 1) : 0;
						const t = steps > 1 ? Math.round(raw * (steps - 1)) / (steps - 1) : 0;
						ctx.fillStyle = rgbaToCSS(mixColors(from, to, t));
						if (vertical) ctx.fillRect(x, y + i, w, 1);
						else ctx.fillRect(x + i, y, 1, h);
					}
					break;
				}
				case 'noise': {
					const colors = (op.colors || []).map(parseColor);
					if (!colors.length) fail('The noise op needs a colors list.');
					const random = seededRandom(op.seed ?? 1);
					const density = op.density ?? 1;
					for (let py = 0; py < h; py++) {
						for (let px = 0; px < w; px++) {
							const pick = random();
							const chance = random();
							if (chance < density) plot(x + px, y + py, colors[Math.floor(pick * colors.length)]);
						}
					}
					break;
				}
				case 'image':
					ctx.imageSmoothingEnabled = false;
					ctx.drawImage(op._image, x, y, op.w ?? op._image.width, op.h ?? op._image.height);
					break;
				default:
					fail(`Unknown paint op "${op.op}". Use fill, clear, rect, pixels, points, line, ellipse, gradient, noise or image.`);
			}
		}
	}

	function replaceColor(ctx, canvas, from, to) {
		const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
		const a = colorToRGBA(from);
		const b = colorToRGBA(to);
		let changed = 0;
		for (let i = 0; i < data.data.length; i += 4) {
			if (data.data[i] === a[0] && data.data[i + 1] === a[1] && data.data[i + 2] === a[2] && data.data[i + 3] === a[3]) {
				data.data.set(b, i);
				changed++;
			}
		}
		ctx.putImageData(data, 0, 0);
		return changed;
	}

	function cubeFaceUV(cube, faceKey) {
		if (!cube.box_uv) return cube.faces[faceKey].uv.slice();
		const size = cube.size(undefined, Format.box_uv_float_size != true);
		const [sx, sy, sz] = size;
		const layout = {
			east: { from: [0, sz], size: [sz, sy] },
			west: { from: [sz + sx, sz], size: [sz, sy] },
			up: { from: [sz + sx, sz], size: [-sx, -sz] },
			down: { from: [sz + sx * 2, 0], size: [-sx, sz] },
			south: { from: [sz * 2 + sx, sz], size: [sx, sy] },
			north: { from: [sz, sz], size: [sx, sy] },
		};
		if (cube.mirror_uv) {
			for (const key in layout) {
				layout[key].from[0] += layout[key].size[0];
				layout[key].size[0] *= -1;
			}
			[layout.east, layout.west] = [layout.west, layout.east];
		}
		const part = layout[faceKey];
		const u = part.from[0] + cube.uv_offset[0];
		const v = part.from[1] + cube.uv_offset[1];
		return [u, v, u + part.size[0], v + part.size[1]];
	}

	// Returns the 2D transform from face pixels (as seen from outside) to texture pixels.
	function faceTransform(cube, faceKey, texture) {
		const uv = cubeFaceUV(cube, faceKey);
		const scaleX = texture.width / texture.getUVWidth();
		const scaleY = texture.display_height / texture.getUVHeight();
		const rotation = ((cube.faces[faceKey].rotation || 0) + 360) % 360;
		const toTexture = (dx, dy) => {
			let tx = dx;
			let ty = dy;
			if (rotation === 90) [tx, ty] = [dy, 1 - dx];
			else if (rotation === 180) [tx, ty] = [1 - dx, 1 - dy];
			else if (rotation === 270) [tx, ty] = [1 - dy, dx];
			return [(uv[0] + tx * (uv[2] - uv[0])) * scaleX, (uv[1] + ty * (uv[3] - uv[1])) * scaleY];
		};
		const size = cubeFacePixelSize(cube, faceKey);
		const p0 = toTexture(0, 0);
		const px = toTexture(1, 0);
		const py = toTexture(0, 1);
		return {
			width: size[0],
			height: size[1],
			matrix: [
				(px[0] - p0[0]) / size[0], (px[1] - p0[1]) / size[0],
				(py[0] - p0[0]) / size[1], (py[1] - p0[1]) / size[1],
				p0[0], p0[1],
			],
			clip: [
				Math.min(uv[0], uv[2]) * scaleX, Math.min(uv[1], uv[3]) * scaleY,
				Math.abs(uv[2] - uv[0]) * scaleX, Math.abs(uv[3] - uv[1]) * scaleY,
			],
		};
	}

	function waitForTexture(texture) {
		return new Promise((resolve, reject) => {
			const started = Date.now();
			const check = () => {
				if (texture.width > 0 && texture.img.complete && !texture.img.src.endsWith('missing.png')) return resolve(texture);
				if (texture.error || Date.now() - started > 5000) return reject(new ToolError(`Texture "${texture.name}" could not be loaded.`));
				setTimeout(check, 10);
			};
			check();
		});
	}

	function matchUVSizeToPixels(texture) {
		if (!Format.per_texture_uv_size) return;
		texture.uv_width = texture.width;
		texture.uv_height = texture.display_height;
	}

	function blankCanvas(width, height, fill) {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (fill) {
			ctx.fillStyle = parseColor(fill);
			ctx.fillRect(0, 0, width, height);
		}
		return canvas;
	}

	// ------------------------------------------------------------------ preview capture

	function sceneBounds(nodes) {
		const box = new THREE.Box3();
		Canvas.scene.updateMatrixWorld(true);
		for (const element of elementsOf(withDescendants(nodes))) {
			if (element.visibility === false || !element.mesh) continue;
			if (!element.mesh.geometry) continue;
			box.expandByObject(element.mesh);
		}
		if (box.isEmpty()) {
			box.set(new THREE.Vector3(-8, 0, -8), new THREE.Vector3(8, 16, 8));
		}
		return box;
	}

	function aimCamera(preview, view, box, options) {
		if (view === 'current') {
			preview.copyView(Preview.selected);
			preview.resize(options.width, options.height);
			return;
		}
		const direction = CAMERA_VIEWS[view];
		if (!direction) fail(`Unknown view "${view}". Use ${Object.keys(CAMERA_VIEWS).join(', ')} or current.`);
		const orthographic = options.projection !== 'perspective';
		preview.setProjectionMode(orthographic);
		// resize only updates the active camera, so it has to follow the projection change.
		preview.resize(options.width, options.height);
		preview.setLockedAngle();
		const center = box.getCenter(new THREE.Vector3());
		const dir = new THREE.Vector3().fromArray(direction).normalize();
		const camera = preview.camera;
		if (!orthographic) preview.setFOV(30);
		camera.position.copy(center).addScaledVector(dir, 512);
		preview.controls.target.copy(center);
		camera.lookAt(center);
		camera.updateMatrixWorld(true);
		const inverse = camera.matrixWorld.clone().invert();
		const corners = [];
		for (const x of [box.min.x, box.max.x]) {
			for (const y of [box.min.y, box.max.y]) {
				for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z).applyMatrix4(inverse));
			}
		}
		const centerSpace = center.clone().applyMatrix4(inverse);
		const margin = options.margin ?? 1.12;
		if (orthographic) {
			let maxX = 0;
			let maxY = 0;
			for (const corner of corners) {
				maxX = Math.max(maxX, Math.abs(corner.x - centerSpace.x));
				maxY = Math.max(maxY, Math.abs(corner.y - centerSpace.y));
			}
			const zoom = Math.min(camera.right / Math.max(maxX * margin, 0.01), camera.top / Math.max(maxY * margin, 0.01));
			camera.zoom = zoom;
			camera.updateProjectionMatrix();
		} else {
			const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
			const tanH = tanV * camera.aspect;
			let distance = 1;
			for (const corner of corners) {
				const toward = corner.z - centerSpace.z;
				distance = Math.max(distance, toward + Math.abs(corner.x - centerSpace.x) * margin / tanH, toward + Math.abs(corner.y - centerSpace.y) * margin / tanV);
			}
			camera.position.copy(center).addScaledVector(dir, distance);
			preview.controls.target.copy(center);
		}
	}

	async function withAnimationPose(args, work) {
		if (args.animation === undefined && args.time === undefined) return work();
		if (!Format.animation_mode) fail(`Format ${Format.id} has no animations.`);
		const animation = findAnimation(args.animation);
		const previousMode = Mode.selected;
		const previousAnimation = Animation.selected;
		const previousTime = Timeline.time;
		if (previousMode !== Modes.options.animate) Modes.options.animate.select();
		animation.select();
		Timeline.setTime(args.time ?? 0);
		Animator.preview();
		try {
			return await work();
		} finally {
			if (previousAnimation && previousAnimation !== animation) previousAnimation.select();
			Timeline.setTime(previousTime);
			Animator.preview();
			if (previousMode !== Modes.options.animate) previousMode.select();
		}
	}

	function renderSheet(args) {
		const views = args.views && args.views.length ? args.views : ['iso_nw', 'iso_se'];
		const width = Math.min(args.width ?? 512, 1600);
		const height = Math.min(args.height ?? args.width ?? 512, 1600);
		const columns = Math.ceil(Math.sqrt(views.length));
		const rows = Math.ceil(views.length / columns);
		const sheet = document.createElement('canvas');
		sheet.width = columns * width;
		sheet.height = rows * height;
		const ctx = sheet.getContext('2d');
		const background = args.background ?? '#3b4252';
		if (background !== 'transparent') {
			ctx.fillStyle = parseColor(background);
			ctx.fillRect(0, 0, sheet.width, sheet.height);
		}
		const box = sceneBounds(args.focus ? args.focus.map(findNode) : Outliner.root);
		const preview = MediaPreview;
		const applyViewMode = args.view_mode && args.view_mode !== Project.view_mode;
		const previousMode = Project.view_mode;
		if (applyViewMode) BarItems.view_mode.change(args.view_mode);
		// withoutGizmos only hides the outlines of selected elements, but duplicates can keep theirs too.
		const outlines = Outliner.elements.map((element) => element.mesh && element.mesh.outline).filter((outline) => outline && outline.visible);
		outlines.forEach((outline) => { outline.visible = false; });
		try {
			views.forEach((view, index) => {
				const x = (index % columns) * width;
				const y = Math.floor(index / columns) * height;
				aimCamera(preview, view, box, { ...args, width, height });
				Canvas.withoutGizmos(() => {
					preview.render();
					ctx.drawImage(preview.canvas, x, y, width, height);
				});
				if (views.length > 1) {
					ctx.font = 'bold 14px sans-serif';
					ctx.fillStyle = '#000000aa';
					ctx.fillRect(x, y, ctx.measureText(view).width + 12, 22);
					ctx.fillStyle = '#ffffff';
					ctx.fillText(view, x + 6, y + 16);
				}
			});
		} finally {
			outlines.forEach((outline) => { outline.visible = true; });
			if (applyViewMode) BarItems.view_mode.change(previousMode);
		}
		return sheet.toDataURL('image/png');
	}

	function renderTexture(texture, args) {
		const source = texture.canvas;
		const maxSize = args.max_size ?? 1024;
		const scale = args.scale ?? Math.max(1, Math.floor(maxSize / Math.max(source.width, source.height)));
		const canvas = document.createElement('canvas');
		canvas.width = source.width * scale;
		canvas.height = source.height * scale;
		const ctx = canvas.getContext('2d');
		const tile = Math.max(scale, 8);
		for (let y = 0; y < canvas.height; y += tile) {
			for (let x = 0; x < canvas.width; x += tile) {
				ctx.fillStyle = ((x + y) / tile) % 2 ? '#8e8e8e' : '#6e6e6e';
				ctx.fillRect(x, y, tile, tile);
			}
		}
		ctx.imageSmoothingEnabled = false;
		ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
		if (args.grid && scale >= 4) {
			ctx.fillStyle = '#00000040';
			for (let x = 0; x <= source.width; x++) ctx.fillRect(x * scale, 0, 1, canvas.height);
			for (let y = 0; y <= source.height; y++) ctx.fillRect(0, y * scale, canvas.width, 1);
		}
		if (args.show_uv) {
			const sx = (texture.width / texture.getUVWidth()) * scale;
			const sy = (texture.display_height / texture.getUVHeight()) * scale;
			ctx.font = '11px sans-serif';
			for (const cube of Cube.all) {
				for (const key of FACE_KEYS) {
					const face = cube.faces[key];
					if (!face.getTexture || face.getTexture() !== texture) continue;
					const uv = cubeFaceUV(cube, key);
					const x = Math.min(uv[0], uv[2]) * sx;
					const y = Math.min(uv[1], uv[3]) * sy;
					const w = Math.abs(uv[2] - uv[0]) * sx;
					const h = Math.abs(uv[3] - uv[1]) * sy;
					ctx.strokeStyle = '#00e5ff';
					ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
					if (w > 40 && h > 26) {
						ctx.fillStyle = '#ffffff';
						ctx.fillText(cube.name.slice(0, Math.floor(w / 6)), x + 3, y + 12);
						ctx.fillText(key, x + 3, y + 24);
					}
				}
			}
		}
		return canvas.toDataURL('image/png');
	}

	function texturePixelsAsText(texture, region) {
		const x = region.x ?? 0;
		const y = region.y ?? 0;
		const w = Math.min(region.w ?? texture.width, 128);
		const h = Math.min(region.h ?? texture.display_height, 128);
		const data = texture.ctx.getImageData(x, y, w, h).data;
		const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
		const palette = {};
		const lookup = new Map();
		const rows = [];
		for (let row = 0; row < h; row++) {
			let text = '';
			for (let col = 0; col < w; col++) {
				const i = (row * w + col) * 4;
				if (data[i + 3] === 0) { text += '_'; continue; }
				const hex = '#' + [data[i], data[i + 1], data[i + 2], data[i + 3]].map((v) => v.toString(16).padStart(2, '0')).join('');
				if (!lookup.has(hex)) {
					if (lookup.size >= alphabet.length) return { x, y, too_many_colors: true };
					lookup.set(hex, alphabet[lookup.size]);
					palette[lookup.get(hex)] = hex;
				}
				text += lookup.get(hex);
			}
			rows.push(text);
		}
		return { x, y, palette, rows, transparent: '_' };
	}

	// Skin and vanilla mob models are private to Blockbench; its own creation dialog is the only way in.
	let skinModels = null;
	function openSkinDialog() {
		Formats.skin.new();
		const dialog = Dialog.open;
		if (!dialog || dialog.id !== 'skin') fail('The skin dialog did not open. Close any open dialog in Blockbench and retry.');
		return dialog;
	}

	// Cancelling this dialog clears the global Format, which would break the open project.
	function cancelDialog(dialog) {
		dialog.cancel();
		if (Project) Blockbench.Format = Project.format;
	}

	function listSkinModels() {
		if (!skinModels) {
			const dialog = openSkinDialog();
			skinModels = Object.keys(dialog.form.form_config.model.options).filter((id) => id !== 'flat_texture');
			cancelDialog(dialog);
		}
		return skinModels;
	}

	function createSkinProject(model) {
		const dialog = openSkinDialog();
		const options = dialog.form.form_config.model.options;
		if (!options[model] || model === 'flat_texture') {
			cancelDialog(dialog);
			fail(`Unknown skin_model "${model}". list_formats shows the available models.`);
		}
		dialog.setFormValues({ model, pose: false, texture_source: 'template', layer_template: false });
		dialog.confirm();
	}

	const dataUrlToImage = (dataUrl) => ({ type: 'image', data: dataUrl.split(',')[1], mimeType: 'image/png' });

	// ------------------------------------------------------------------ tool schemas

	const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
	const vec4 = { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 };
	const refList = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Names or ids.' };
	const faceList = { type: 'array', items: { type: 'string', enum: [...FACE_KEYS, 'all'] } };

	const paintOpSchema = {
		type: 'object',
		required: ['op'],
		description: 'Coordinates are pixels, (0,0) is top-left. x, y default to 0; w, h default to the rest of the area.',
		properties: {
			op: { type: 'string', enum: ['fill', 'clear', 'rect', 'pixels', 'points', 'line', 'ellipse', 'gradient', 'noise', 'image'], description: 'fill{color} | clear{x,y,w,h} | rect{x,y,w,h,color,outline} | pixels{x,y,rows,palette} | points{points:[[x,y,color?]],color} | line{x1,y1,x2,y2,color} | ellipse{x,y,w,h,color,outline} | gradient{x,y,w,h,from,to,direction,steps} | noise{x,y,w,h,colors,density,seed} | image{source,x,y,w,h}' },
			x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' },
			x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' },
			color: { type: 'string', description: 'CSS color, e.g. "#a0522d" or "rgba(0,0,0,0.5)".' },
			outline: { type: 'boolean', description: 'Draw only the 1px border.' },
			rows: { type: 'array', items: { type: 'string' }, description: 'One string per pixel row. Each character is a palette key; "." leaves the pixel unchanged, "_" erases it.' },
			palette: { type: 'object', description: 'Maps single characters to colors, e.g. {"a":"#fff"}.' },
			points: { type: 'array', items: { type: 'array' } },
			from: { type: 'string' }, to: { type: 'string' },
			direction: { type: 'string', enum: ['vertical', 'horizontal'] },
			steps: { type: 'integer', description: 'Number of color bands, for a banded pixel art look.' },
			colors: { type: 'array', items: { type: 'string' }, description: 'Noise picks randomly from these; repeat a color to weight it.' },
			density: { type: 'number', description: '0..1, the share of pixels that noise changes.' },
			seed: { type: 'integer' },
			source: { type: 'string', description: 'Absolute path or data URL.' },
		},
	};

	const elementSpecSchema = {
		type: 'object',
		description: 'A group, cube, mesh or locator. type defaults to group when children is present, otherwise cube.',
		properties: {
			type: { type: 'string', enum: ['group', 'cube', 'mesh', 'locator'] },
			name: { type: 'string' },
			children: { type: 'array', items: { type: 'object' }, description: 'Groups only: nested element specs of the same shape.' },
			from: vec3, to: vec3,
			size: { ...vec3, description: 'With from or center, instead of to.' },
			center: vec3,
			origin: { ...vec3, description: 'Pivot. Cubes default to their center, groups to the center of their contents. Set it explicitly for bones (e.g. the shoulder).' },
			rotation: vec3,
			inflate: { type: 'number', description: 'Grows a cube without changing its UV (e.g. hat or jacket layers).' },
			color: { type: 'integer', description: 'Marker color index 0-7.' },
			visible: { type: 'boolean' },
			box_uv: { type: 'boolean' },
			uv_offset: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
			mirror_uv: { type: 'boolean' },
			shade: { type: 'boolean' },
			light_emission: { type: 'integer' },
			texture: { type: 'string', description: 'Texture applied to all faces.' },
			faces: { type: 'object', description: 'Per-face settings: {"north":{"uv":[x1,y1,x2,y2],"rotation":0,"texture":"name","enabled":true}}.' },
			position: { ...vec3, description: 'Locators: position. Meshes: offset applied to vertices.' },
			vertices: { type: 'array', items: vec3, description: 'Meshes: vertex positions.' },
			polygons: { type: 'array', items: { type: 'array', items: { type: 'integer' } }, description: 'Meshes: faces as lists of vertex indices, 3 or 4 in perimeter order, counter-clockwise seen from outside.' },
			primitive: { type: 'object', description: 'Meshes: {type:"sphere"|"cylinder"|"cone"|"torus"|"plane",radius,height,sides,rings,top_radius,tube_radius,width,depth}.' },
		},
	};

	function validate(schema, value, path) {
		if (!schema) return;
		const types = { integer: (v) => Number.isInteger(v), number: (v) => typeof v === 'number' && !Number.isNaN(v), string: (v) => typeof v === 'string', boolean: (v) => typeof v === 'boolean', array: Array.isArray, object: (v) => v && typeof v === 'object' && !Array.isArray(v) };
		if (schema.type && !types[schema.type](value)) fail(`${path} should be ${schema.type}, got ${JSON.stringify(value)?.slice(0, 80)}.`);
		if (schema.enum && !schema.enum.includes(value)) fail(`${path} should be one of ${schema.enum.join(', ')}, got ${JSON.stringify(value)}.`);
		if (schema.type === 'array') {
			if (schema.minItems !== undefined && value.length < schema.minItems) fail(`${path} needs at least ${schema.minItems} items.`);
			if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`${path} allows at most ${schema.maxItems} items.`);
			value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`));
		}
		if (schema.type === 'object' && schema.properties) {
			for (const key of schema.required || []) {
				if (value[key] === undefined) fail(`${path}.${key} is required.`);
			}
			for (const key in value) {
				if (!schema.properties[key]) fail(`${path}.${key} is not a known field. Known fields: ${Object.keys(schema.properties).join(', ')}.`);
				validate(schema.properties[key], value[key], `${path}.${key}`);
			}
		}
	}

	// ------------------------------------------------------------------ tools

	const tools = new Map();
	function tool(name, description, properties, required, handler, options = {}) {
		tools.set(name, {
			name,
			description,
			inputSchema: { type: 'object', properties, required },
			handler,
			annotations: options.readOnly ? { readOnlyHint: true } : undefined,
			available: options.available,
		});
	}

	tool('get_state', 'Blockbench version, open projects, and details of the current project: format, capabilities, texture resolution, textures, selection.', {}, [], () => ({
		blockbench_version: Blockbench.version,
		open_projects: ModelProject.all.map((p) => ({ id: p.uuid, name: p.name, format: p.format.id, selected: p === Project })),
		project: describeProject(),
		textures: Project ? Texture.all.map(describeTexture) : [],
		selected: Project ? Outliner.selected.map((n) => n.name) : [],
	}), { readOnly: true });

	tool('list_formats', 'Lists the model formats new_project accepts with their capabilities, the codecs export_model accepts, and player skin models.', {}, [], () => ({
		formats: Object.values(Formats).map((f) => ({ id: f.id, name: f.name, ...describeFormat(f) })),
		export_codecs: Object.values(Codecs).filter((c) => c.compile && c.id !== 'skin_model').map((c) => ({ id: c.id, extension: c.extension })),
		skin_models: listSkinModels(),
	}), { readOnly: true });

	tool('new_project', 'Creates and switches to a new project. Open projects stay open in their own tabs. Format "skin" starts from a ready Minecraft model with its texture layout: a player (steve, alex) or a vanilla mob or object (creeper, cow, chest...).', {
		format: { type: 'string', description: 'Format id from list_formats, e.g. java_block, bedrock, free, skin, image.' },
		name: { type: 'string' },
		texture_width: { type: 'integer', description: 'UV/texture resolution. For image: the image width. Default 16 (64 for entities).' },
		texture_height: { type: 'integer' },
		box_uv: { type: 'boolean', description: 'For formats where box UV is optional.' },
		skin_model: { type: 'string', description: 'Skin format only, default steve. See skin_models in list_formats.' },
	}, ['format'], async (args) => {
		const format = Formats[args.format];
		if (!format) fail(`Unknown format "${args.format}". Available: ${Object.keys(Formats).join(', ')}`);
		if (args.format === 'image') {
			newProject(format);
			const width = args.texture_width ?? 16;
			const height = args.texture_height ?? width;
			const texture = new Texture({ name: (args.name || 'image') + '.png', mode: 'bitmap', keep_size: true, internal: true });
			texture.fromDataURL(blankCanvas(width, height).toDataURL()).add(false);
			await waitForTexture(texture);
			texture.select();
			texture.uv_width = width;
			texture.uv_height = height;
			if (args.name) Project.name = args.name;
			return describeProject();
		}
		if (args.format === 'skin') {
			createSkinProject(args.skin_model ?? 'steve');
			await Promise.all(Texture.all.map(waitForTexture));
			refreshAll();
		} else {
			newProject(format);
		}
		if (args.name) Project.name = args.name;
		if (args.box_uv !== undefined && Format.optional_box_uv) Project.box_uv = args.box_uv;
		if (args.texture_width) Project.texture_width = args.texture_width;
		if (args.texture_height || args.texture_width) Project.texture_height = args.texture_height ?? args.texture_width;
		return describeProject();
	});

	tool('update_project', 'Changes the current project: name or UV resolution.', {
		name: { type: 'string' },
		texture_width: { type: 'integer' },
		texture_height: { type: 'integer' },
	}, [], (args) => {
		requireProject();
		if (args.name) Project.name = args.name;
		if (args.texture_width) Project.texture_width = args.texture_width;
		if (args.texture_height) Project.texture_height = args.texture_height;
		if (Format.per_texture_uv_size) {
			for (const texture of Texture.all) {
				if (args.texture_width) texture.uv_width = args.texture_width;
				if (args.texture_height) texture.uv_height = args.texture_height;
			}
		}
		Canvas.updateAllUVs();
		return describeProject();
	});

	tool('open_file', 'Opens a model, project or image from disk in a new tab (.bbmodel, .json, .jem, .png and others).', {
		path: { type: 'string', description: 'Absolute path.' },
	}, ['path'], async (args) => {
		requireAbsolutePath(args.path);
		if (!fileExists(args.path)) fail(`File not found: ${args.path}`);
		const isImage = /\.(png|tga|jpe?g|gif|webp)$/i.test(args.path);
		await new Promise((resolve) => {
			Blockbench.read([args.path], { readtype: isImage ? 'image' : 'text', errorbox: false }, (files) => {
				if (isImage) Codecs.image.load(files, args.path);
				else loadModelFile(files[0]);
				resolve();
			});
		});
		await sleep(50);
		await Promise.all(Texture.all.map((t) => waitForTexture(t).catch(() => null)));
		return describeProject();
	});

	tool('switch_project', 'Switches to another open project tab.', {
		project: { type: 'string', description: 'Project id or name from get_state.' },
	}, ['project'], (args) => {
		const project = ModelProject.all.find((p) => p.uuid === args.project || p.name === args.project);
		if (!project) fail(`No open project "${args.project}".`);
		project.select();
		return describeProject();
	});

	tool('close_project', 'Closes the current project tab. Fails on unsaved changes unless discard_changes is true.', {
		discard_changes: { type: 'boolean' },
	}, [], async (args) => {
		requireProject();
		if (!Project.saved && !args.discard_changes) fail('The project has unsaved changes. Save it, or pass discard_changes: true after the user agrees.');
		await Project.close(true);
		return { open_projects: ModelProject.all.map((p) => p.name) };
	});

	tool('save_project', 'Saves the project as a .bbmodel file with textures embedded. Without path, saves to the path it was opened from or last saved to.', {
		path: { type: 'string', description: 'Absolute path ending in .bbmodel.' },
		overwrite: { type: 'boolean' },
	}, [], (args) => {
		requireProject();
		const target = args.path ?? Project.save_path;
		if (!target) fail('This project was never saved, so a path is required.');
		if (args.path && args.path !== Project.save_path) checkWritable(target, args.overwrite);
		else requireAbsolutePath(target);
		Codecs.project.write(Codecs.project.compile(), target);
		return { saved: target };
	});

	tool('export_model', 'Exports to a game or interchange format using a codec from list_formats (java_block, bedrock, obj, gltf, fbx, collada, stl, modded_entity, optifine_entity...). Textures are not written; use save_texture for them.', {
		codec: { type: 'string' },
		path: { type: 'string', description: 'Absolute path with the file extension.' },
		overwrite: { type: 'boolean' },
	}, ['codec', 'path'], async (args) => {
		requireProject();
		const codec = Codecs[args.codec];
		if (!codec || !codec.compile) fail(`Unknown codec "${args.codec}". Available: ${Object.keys(Codecs).join(', ')}`);
		checkWritable(args.path, args.overwrite);
		const content = await codec.compile();
		await codec.write(content, args.path);
		return { exported: args.path, codec: codec.id };
	});

	tool('undo', 'Undoes the last edits, like Ctrl+Z.', { steps: { type: 'integer' } }, [], (args) => {
		requireProject();
		for (let i = 0; i < (args.steps ?? 1); i++) Undo.undo();
		return describeProject().counts;
	});

	tool('redo', 'Redoes undone edits.', { steps: { type: 'integer' } }, [], (args) => {
		requireProject();
		for (let i = 0; i < (args.steps ?? 1); i++) Undo.redo();
		return describeProject().counts;
	});

	tool('get_outliner', 'Returns the model tree. With detail: true also returns the pivot, UVs and the pixel size of each face, which paint_faces coordinates are based on.', {
		detail: { type: 'boolean' },
		target: { type: 'string', description: 'Only this group or element.' },
	}, [], (args) => {
		requireProject();
		if (args.target) return describeNode(findNode(args.target), args.detail);
		return Outliner.root.map((node) => describeNode(node, args.detail));
	}, { readOnly: true });

	tool('add_elements', 'Adds groups, cubes, meshes and locators in one undo step. Send a whole model at once by nesting children. Example: {"elements":[{"name":"head","origin":[0,24,0],"children":[{"name":"skull","from":[-4,24,-4],"to":[4,32,4]}]}]}', {
		elements: { type: 'array', items: elementSpecSchema, minItems: 1 },
		parent: { type: 'string', description: 'Existing group to add into. Defaults to the root.' },
	}, ['elements'], async (args) => {
		requireProject();
		const parent = args.parent ? findGroup(args.parent) : 'root';
		const warnings = [];
		const created = [];
		const check = (spec) => {
			validate(elementSpecSchema, spec, 'element');
			(spec.children || []).forEach(check);
		};
		args.elements.forEach(check);
		const roots = await undoable('add elements', { outliner: true, elements: [], groups: [], selection: true }, () => {
			const result = args.elements.map((spec) => buildNode(spec, parent, created, warnings));
			refreshAll();
			return result;
		}, () => ({ outliner: true, elements: elementsOf(created), groups: groupsOf(created), selection: true }));
		return { created: roots.map((node) => describeNode(node)), warnings: warnings.length ? warnings : undefined };
	});

	tool('update_elements', 'Changes existing elements or groups in one undo step. Each update has target plus any of: name, from, to, origin, rotation, inflate, visible, color, shade, move (relative offset, includes group contents), parent (group name, or "root"), box_uv, uv_offset, mirror_uv, faces (per-face uv, rotation, texture, enabled).', {
		updates: {
			type: 'array',
			minItems: 1,
			items: {
				type: 'object',
				required: ['target'],
				properties: {
					target: { type: 'string' },
					name: { type: 'string' },
					from: vec3, to: vec3, origin: vec3, rotation: vec3,
					move: { ...vec3, description: 'Relative offset.' },
					inflate: { type: 'number' },
					visible: { type: 'boolean' },
					color: { type: 'integer' },
					shade: { type: 'boolean' },
					parent: { type: 'string' },
					box_uv: { type: 'boolean' },
					uv_offset: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
					mirror_uv: { type: 'boolean' },
					faces: { type: 'object' },
				},
			},
		},
	}, ['updates'], async (args) => {
		requireProject();
		const entries = args.updates.map((update) => ({ update, node: findNode(update.target) }));
		const nodes = withDescendants(entries.map((entry) => entry.node));
		const changesTree = args.updates.some((update) => update.parent !== undefined);
		await undoable('update elements', { outliner: changesTree, elements: elementsOf(nodes), groups: groupsOf(nodes), selection: true }, () => {
			for (const { update, node } of entries) {
				if (update.name !== undefined) node.name = update.name;
				for (const key of ['from', 'to', 'origin', 'rotation']) {
					if (update[key] === undefined) continue;
					if (!node[key]) fail(`${node.type} "${node.name}" has no ${key}.`);
					node[key].replace ? node[key].replace(update[key]) : (node[key] = update[key].slice());
				}
				if (update.move) moveNode(node, update.move);
				for (const key of ['inflate', 'color', 'shade', 'mirror_uv']) {
					if (update[key] !== undefined) node[key] = update[key];
				}
				if (update.visible !== undefined) node.visibility = update.visible;
				if (update.box_uv !== undefined && node.setUVMode) node.setUVMode(update.box_uv);
				if (update.uv_offset) node.uv_offset = update.uv_offset.slice();
				if (update.faces) {
					if (!(node instanceof Cube)) fail(`"${node.name}" is not a cube, so faces cannot be set.`);
					applyFaceSpecs(node, update.faces);
				} else if (node instanceof Cube && node.autouv && (update.from || update.to)) {
					node.mapAutoUV();
				}
				if (update.parent !== undefined) node.addTo(update.parent === 'root' ? 'root' : findGroup(update.parent));
			}
			refreshAll();
		});
		return { updated: entries.map(({ node }) => describeNode(node)) };
	});

	tool('delete_elements', 'Deletes elements or groups, including group contents, in one undo step.', {
		targets: refList,
	}, ['targets'], async (args) => {
		requireProject();
		const roots = args.targets.map(findNode);
		const nodes = withDescendants(roots);
		await undoable('delete elements', { outliner: true, elements: elementsOf(nodes), groups: groupsOf(nodes), selection: true }, () => {
			for (const root of roots) {
				if (root instanceof Group) root.remove(false);
				else root.remove();
			}
			refreshAll();
		}, () => ({ outliner: true, elements: [], groups: [], selection: true }));
		return { deleted: roots.length, remaining: describeProject().counts };
	});

	tool('duplicate_elements', 'Copies elements or groups with their contents. mirror_axis makes a symmetric copy (left arm to right arm) and swaps left/right in the name.', {
		targets: refList,
		offset: { ...vec3, description: 'Moves the copies.' },
		mirror_axis: { type: 'string', enum: ['x', 'y', 'z'] },
		mirror_center: { type: 'number', description: 'Defaults to the model center: 0 for entity formats, 8 for block formats.' },
		name: { type: 'string', description: 'Name for the copy, when duplicating one target.' },
	}, ['targets'], async (args) => {
		requireProject();
		const sources = args.targets.map(findNode);
		const axis = args.mirror_axis ? 'xyz'.indexOf(args.mirror_axis) : -1;
		const center = args.mirror_center ?? (Format.centered_grid ? 0 : 8);
		let copies = [];
		await undoable('duplicate elements', { outliner: true, elements: [], groups: [], selection: true }, () => {
			copies = sources.map((source) => {
				const copy = source.duplicate();
				if (axis >= 0) {
					mirrorNode(copy, axis, center);
					copy.name = renameMirrored(source.name);
					groupsOf(descendantsOf(copy)).forEach((child) => { child.name = renameMirrored(child.name); });
				}
				if (args.offset) moveNode(copy, args.offset);
				if (args.name && sources.length === 1) copy.name = args.name;
				if (copy.createUniqueName && copy instanceof Group) copy.createUniqueName();
				return copy;
			});
			refreshAll();
		}, () => {
			const nodes = withDescendants(copies);
			return { outliner: true, elements: elementsOf(nodes), groups: groupsOf(nodes), selection: true };
		});
		return { created: copies.map((node) => describeNode(node)) };
	});

	const descendantsOf = (node) => (node instanceof Group ? descendants(node) : []);

	tool('create_texture', 'Creates a blank texture in the current project, optionally filled and applied to everything.', {
		name: { type: 'string' },
		width: { type: 'integer', description: 'Default 16.' },
		height: { type: 'integer', description: 'Defaults to width.' },
		fill: { type: 'string', description: 'Background color. Default transparent.' },
		apply_to: { ...refList, description: 'Elements to apply the texture to, or ["*"] for all.' },
		ops: { type: 'array', items: paintOpSchema, description: 'Optional paint ops to run right away.' },
	}, [], async (args) => {
		requireProject();
		const width = args.width ?? 16;
		const height = args.height ?? width;
		if (Format.per_texture_uv_size !== true && !Texture.all.length) {
			Project.texture_width = width;
			Project.texture_height = height;
		}
		const canvas = blankCanvas(width, height, args.fill);
		const name = args.name || 'texture';
		const texture = await undoable('create texture', { textures: [] }, async () => {
			const created = new Texture({ name: name.endsWith('.png') ? name : name + '.png', mode: 'bitmap', keep_size: true, internal: true });
			created.fromDataURL(canvas.toDataURL()).add(false);
			await waitForTexture(created);
			matchUVSizeToPixels(created);
			created.select();
			return created;
		}, (created) => ({ textures: [created] }));
		if (args.apply_to) applyTextureTo(texture, args.apply_to, ['all']);
		if (args.ops) await paintTexture(texture, args.ops, 'create texture');
		return describeTexture(texture);
	});

	tool('import_texture', 'Adds an image from disk or a data URL as a texture.', {
		source: { type: 'string', description: 'Absolute path or data:image URL.' },
		name: { type: 'string' },
		apply_to: { ...refList, description: 'Elements to apply it to, or ["*"] for all.' },
	}, ['source'], async (args) => {
		requireProject();
		const isData = args.source.startsWith('data:');
		if (!isData) {
			requireAbsolutePath(args.source);
			if (!fileExists(args.source)) fail(`File not found: ${args.source}`);
		}
		const texture = await undoable('import texture', { textures: [] }, async () => {
			// Loading by path can stop on a "not in a resource pack" dialog, so the image is embedded instead.
			const image = await loadImage(args.source);
			const canvas = blankCanvas(image.width, image.height);
			canvas.getContext('2d').drawImage(image, 0, 0);
			const fallback = isData ? 'texture.png' : args.source.split(/[\\/]/).pop();
			const created = new Texture({ name: args.name || fallback, mode: 'bitmap', keep_size: true, internal: true }).fromDataURL(canvas.toDataURL());
			created.add(false);
			await waitForTexture(created);
			matchUVSizeToPixels(created);
			created.select();
			return created;
		}, (created) => ({ textures: [created] }));
		if (args.apply_to) applyTextureTo(texture, args.apply_to, ['all']);
		return describeTexture(texture);
	});

	function resolveTargets(targets) {
		if (targets.length === 1 && targets[0] === '*') return Outliner.elements.slice();
		return elementsOf(withDescendants(targets.map(findNode)));
	}

	function applyTextureTo(texture, targets, faces) {
		const elements = resolveTargets(targets);
		const all = faces.includes('all');
		Undo.initEdit({ elements });
		for (const element of elements) {
			if (element instanceof Cube) {
				element.applyTexture(texture, all ? true : faces);
			} else if (element.faces) {
				for (const key in element.faces) element.faces[key].texture = texture.uuid;
			}
		}
		Undo.finishEdit('AI: apply texture');
		Canvas.updateAllFaces();
		return elements.length;
	}

	tool('apply_texture', 'Assigns a texture to elements. Cube faces keep their existing UVs.', {
		texture: { type: 'string' },
		targets: { ...refList, description: 'Elements or groups, or ["*"] for all.' },
		faces: { ...faceList, description: 'Defaults to all.' },
	}, ['targets'], (args) => {
		requireProject();
		const texture = findTexture(args.texture);
		return { applied_to: applyTextureTo(texture, args.targets, args.faces ?? ['all']), texture: texture.name };
	});

	async function paintTexture(texture, ops, label) {
		await preloadOpImages(ops);
		let replaced;
		await undoable(label, { textures: [texture], bitmap: true }, () => {
			texture.edit((canvas, state) => {
				const ctx = state.ctx;
				ctx.save();
				if (state.offset) ctx.translate(-state.offset[0], -state.offset[1]);
				ctx.imageSmoothingEnabled = false;
				const regular = [];
				const flush = () => {
					paintOps(ctx, regular, canvas.width, canvas.height);
					regular.length = 0;
				};
				for (const op of ops) {
					if (op.op === 'replace_color') {
						flush();
						replaced = (replaced || 0) + replaceColor(ctx, canvas, op.from, op.to);
					} else {
						regular.push(op);
					}
				}
				flush();
				ctx.restore();
			}, { no_undo: true });
		});
		return replaced;
	}

	tool('paint_texture', 'Paints directly on a texture in texture pixels, in one undo step. The right tool for 2D art and for image projects. Ops also include replace_color{from,to}.', {
		texture: { type: 'string', description: 'Defaults to the selected texture.' },
		ops: { type: 'array', items: { ...paintOpSchema, properties: { ...paintOpSchema.properties, op: { type: 'string' } } }, minItems: 1 },
	}, ['ops'], async (args) => {
		const texture = findTexture(args.texture);
		const replaced = await paintTexture(texture, args.ops, 'paint texture');
		return { ...describeTexture(texture), replaced_pixels: replaced };
	});

	tool('paint_faces', 'Paints on cube faces using each face\'s own pixel coordinates: (0,0) is the top-left of the face as seen from outside (top face: top is north), so you never compute UVs. Painting stays inside the face. Run generate_texture_template first so faces have their own space on the texture. Returns each face\'s pixel size.', {
		paints: {
			type: 'array',
			minItems: 1,
			items: {
				type: 'object',
				required: ['target', 'ops'],
				properties: {
					target: { type: 'string', description: 'Cube, or a group to paint every cube inside it.' },
					faces: { ...faceList, description: 'Defaults to all.' },
					ops: { type: 'array', items: paintOpSchema, minItems: 1 },
					texture: { type: 'string', description: 'Use this texture when the face has none assigned.' },
				},
			},
		},
	}, ['paints'], async (args) => {
		requireProject();
		const jobs = [];
		const report = [];
		for (const paint of args.paints) {
			const cubes = elementsOf(withDescendants([findNode(paint.target, Cube)])).filter((node) => node instanceof Cube);
			if (!cubes.length) fail(`"${paint.target}" contains no cubes. paint_faces works on cubes; use paint_texture for meshes.`);
			await preloadOpImages(paint.ops);
			const wanted = !paint.faces || paint.faces.includes('all') ? FACE_KEYS : paint.faces;
			for (const cube of cubes) {
				const sizes = {};
				for (const key of wanted) {
					const face = cube.faces[key];
					if (face.texture === null) continue;
					const texture = (face.getTexture && face.getTexture()) || (paint.texture ? findTexture(paint.texture) : null);
					if (!texture) fail(`${cube.name}.${key} has no texture. Run generate_texture_template or apply_texture first.`);
					const transform = faceTransform(cube, key, texture);
					if (!transform.width || !transform.height) continue;
					sizes[key] = [transform.width, transform.height];
					jobs.push({ texture, transform, ops: paint.ops });
				}
				report.push({ cube: cube.name, faces: sizes });
			}
		}
		const textures = [...new Set(jobs.map((job) => job.texture))];
		await undoable('paint faces', { textures, bitmap: true }, () => {
			for (const texture of textures) {
				texture.edit((canvas, state) => {
					const ctx = state.ctx;
					const offset = state.offset || [0, 0];
					for (const job of jobs.filter((j) => j.texture === texture)) {
						ctx.save();
						ctx.imageSmoothingEnabled = false;
						ctx.translate(-offset[0], -offset[1]);
						ctx.beginPath();
						ctx.rect(...job.transform.clip);
						ctx.clip();
						ctx.transform(...job.transform.matrix);
						paintOps(ctx, job.ops, job.transform.width, job.transform.height);
						ctx.restore();
					}
				}, { no_undo: true });
			}
		});
		return { painted: report };
	});

	tool('generate_texture_template', 'Lays out the UVs of all elements on a new texture and applies it, so every face has its own pixels. Run it once the model shape is finished, then use paint_faces. Replaces the existing UV layout.', {
		name: { type: 'string' },
		resolution: { type: 'integer', description: 'Pixels per block: 16 (default) gives 1 pixel per unit, 32 gives 2.' },
		color: { type: 'string', description: 'Base color. Default is the template look with colored faces.' },
		box_uv: { type: 'boolean', description: 'Force a box UV layout. Entity formats use it already.' },
		padding: { type: 'boolean', description: 'Leaves a pixel between faces. Default false.' },
	}, [], async (args) => {
		requireProject();
		if (!Cube.all.length && !Mesh.all.length) fail('The model is empty. Add elements first.');
		const before = new Set(Texture.all);
		const previousSelection = Outliner.selected.slice();
		Outliner.elements.forEach((element) => element.markAsSelected && element.markAsSelected());
		updateSelection();
		const options = {
			type: 'template',
			name: args.name || 'texture',
			// Must be a string: addBitmap resets numbers to [16, 16], which generateTemplate cannot divide.
			resolution: String(args.resolution ?? 16),
			color: args.color ? new tinycolor(parseColor(args.color)) : undefined,
			rearrange_uv: true,
			box_uv: args.box_uv ?? false,
			padding: args.padding ?? false,
			double_use: false,
			power: true,
			particle: 'auto',
		};
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new ToolError('Template generation timed out.')), 60000);
			TextureGenerator.addBitmap(options, () => {
				clearTimeout(timer);
				resolve();
			});
		});
		const texture = Texture.all.find((t) => !before.has(t));
		if (!texture) fail('Blockbench did not create a template texture.');
		await waitForTexture(texture);
		await sleep(0);
		unselectAllElements();
		previousSelection.forEach((node) => node.markAsSelected && node.markAsSelected());
		updateSelection();
		Canvas.updateAll();
		return { texture: describeTexture(texture), texture_resolution: [Project.texture_width, Project.texture_height] };
	});

	tool('get_texture', 'Shows a texture as an upscaled image with crisp pixels on a checkerboard. show_uv outlines each cube face and labels it; as_text also returns exact pixels as a palette and rows, in the format the pixels paint op takes.', {
		texture: { type: 'string' },
		scale: { type: 'integer', description: 'Pixel scale. By default it fits max_size.' },
		max_size: { type: 'integer', description: 'Default 1024.' },
		grid: { type: 'boolean' },
		show_uv: { type: 'boolean' },
		as_text: { type: 'boolean' },
		region: { type: 'object', description: 'For as_text: {x,y,w,h}. Up to 128x128.' },
	}, [], (args) => {
		const texture = findTexture(args.texture);
		const info = describeTexture(texture);
		if (args.as_text) info.pixels = texturePixelsAsText(texture, args.region || {});
		return { content: [{ type: 'text', text: JSON.stringify(info) }, dataUrlToImage(renderTexture(texture, args))] };
	}, { readOnly: true });

	tool('save_texture', 'Writes a texture to disk as a PNG.', {
		texture: { type: 'string' },
		path: { type: 'string', description: 'Absolute path ending in .png.' },
		overwrite: { type: 'boolean' },
	}, ['path'], (args) => {
		const texture = findTexture(args.texture);
		checkWritable(args.path, args.overwrite);
		Blockbench.writeFile(args.path, { content: texture.getDataURL(), savetype: 'image' });
		texture.saved = true;
		return { saved: args.path, width: texture.width, height: texture.display_height };
	});

	tool('capture_preview', 'Renders the model and returns an image, framed automatically. This is how you see your work. It uses its own camera, so the user\'s view is not disturbed. Several views become one labeled sheet. An image project returns its texture instead.', {
		views: { type: 'array', items: { type: 'string', enum: [...Object.keys(CAMERA_VIEWS), 'current'] }, description: 'Default ["iso_nw","iso_se"]. north is the view from the north side, looking south at the front of an entity. current is the user\'s camera.' },
		width: { type: 'integer', description: 'Pixels per view. Default 512.' },
		height: { type: 'integer' },
		projection: { type: 'string', enum: ['orthographic', 'perspective'], description: 'Default orthographic.' },
		focus: { ...refList, description: 'Frame only these elements or groups.' },
		margin: { type: 'number', description: 'Framing margin. Default 1.12; below 1 crops in.' },
		background: { type: 'string', description: 'CSS color or "transparent". Default dark gray-blue.' },
		view_mode: { type: 'string', enum: ['textured', 'solid', 'colored_solid', 'wireframe', 'uv', 'normal'], description: 'Default is the current mode. wireframe shows hidden parts, colored_solid shows marker colors, uv and normal help debug textures and meshes.' },
		animation: { type: 'string', description: 'Animation to pose the model with.' },
		time: { type: 'number', description: 'Seconds into the animation.' },
	}, [], async (args) => {
		requireProject();
		if (Format.image_editor || Format.id === 'image') {
			const texture = findTexture();
			return { content: [{ type: 'text', text: JSON.stringify(describeTexture(texture)) }, dataUrlToImage(renderTexture(texture, { grid: false }))] };
		}
		const image = await withAnimationPose(args, () => renderSheet(args));
		return { content: [dataUrlToImage(image)] };
	}, { readOnly: true });

	tool('capture_window', 'Screenshot of the whole Blockbench window, to see the interface or dialogs. If another window covers Blockbench the image can be out of date. Use capture_preview to see the model, which is always current.', {}, [], async () => {
		const dataUrl = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new ToolError('The window capture timed out.')), 10000);
			Screencam.fullScreen(0, (url) => {
				clearTimeout(timer);
				resolve(url);
			});
		});
		return { content: [dataUrlToImage(dataUrl)] };
	}, { readOnly: true });

	tool('dismiss_dialog', 'Closes the dialog open in Blockbench by pressing its cancel button, or the button with the given index. Tool results mention it when a dialog is open. A dialog may belong to the user, so check it with capture_window if you did not cause it.', {
		button: { type: 'integer', description: 'Button index, from 0. Defaults to the cancel button.' },
	}, [], (args) => {
		const dialog = Dialog.open;
		if (!dialog) return { closed: false, message: 'No dialog is open.' };
		const text = dialogText(dialog);
		if (args.button !== undefined) dialog.close(args.button);
		else cancelDialog(dialog);
		return { closed: true, dialog: text };
	});

	tool('validate_model', 'Runs the Blockbench validator: problems that would break or change the model in its target format.', {}, [], async () => {
		requireProject();
		Validator.validate();
		await sleep(150);
		const simplify = (list) => list.map((entry) => ({ message: entry.message }));
		return { errors: simplify(Validator.errors), warnings: simplify(Validator.warnings) };
	}, { readOnly: true });

	tool('list_animations', 'Lists animations with their keyframes per bone.', {}, [], () => {
		requireProject();
		return Animator.animations.filter((a) => a instanceof Animation).map((animation) => ({
			id: animation.uuid,
			name: animation.name,
			length: animation.length,
			loop: animation.loop,
			selected: animation.selected || undefined,
			bones: Object.values(animation.animators).filter((a) => a.keyframes.length).map((animator) => ({
				bone: animator.name,
				keyframes: animator.keyframes.map((kf) => ({
					channel: kf.channel,
					time: kf.time,
					value: kf.data_points[0] ? [kf.data_points[0].x, kf.data_points[0].y, kf.data_points[0].z] : undefined,
					interpolation: kf.interpolation,
				})),
			})),
		}));
	}, { readOnly: true });

	tool('create_animation', 'Creates an animation and selects it.', {
		name: { type: 'string', description: 'E.g. animation.dragon.walk' },
		length: { type: 'number', description: 'Seconds.' },
		loop: { type: 'string', enum: ['once', 'hold', 'loop'], description: 'Default loop.' },
		override: { type: 'boolean' },
		snapping: { type: 'integer', description: 'Keyframe steps per second. Default 24.' },
	}, ['name'], (args) => {
		requireProject();
		if (!Format.animation_mode) fail(`Format ${Format.id} has no animations. Use bedrock, modded_entity or free.`);
		const animation = new Animation({ name: args.name, length: args.length ?? 1, loop: args.loop ?? 'loop', override: args.override ?? false, snapping: args.snapping ?? 24 });
		animation.add(true);
		animation.select();
		return { id: animation.uuid, name: animation.name, length: animation.length };
	});

	tool('add_keyframes', 'Adds keyframes in one undo step, replacing any at the same time. Rotation is in degrees, position in model units relative to the rest pose, scale as a multiplier. Values may be numbers or Molang strings such as "math.sin(query.anim_time*360)*20". Keyframes on bones that have no animator yet create one.', {
		animation: { type: 'string', description: 'Defaults to the selected animation.' },
		keyframes: {
			type: 'array',
			minItems: 1,
			items: {
				type: 'object',
				required: ['bone', 'channel', 'time', 'value'],
				properties: {
					bone: { type: 'string', description: 'Group name or id.' },
					channel: { type: 'string', enum: ['rotation', 'position', 'scale'] },
					time: { type: 'number' },
					value: { type: 'array', minItems: 3, maxItems: 3 },
					interpolation: { type: 'string', enum: ['linear', 'catmullrom', 'step', 'bezier'] },
				},
			},
		},
	}, ['keyframes'], async (args) => {
		const animation = findAnimation(args.animation);
		animation.select();
		const created = [];
		await undoable('add keyframes', { animations: [animation] }, () => {
			for (const spec of args.keyframes) {
				const animator = animation.getBoneAnimator(findNode(spec.bone));
				if (!animator) fail(`"${spec.bone}" cannot be animated.`);
				const [x, y, z] = spec.value;
				const data = { channel: spec.channel, data_points: [{ x, y, z }] };
				if (spec.interpolation) data.interpolation = spec.interpolation;
				created.push(animator.createKeyframe(data, spec.time, spec.channel, false, false));
			}
			animation.setLength();
		}, () => ({ animations: [animation] }));
		Animator.preview();
		return { added: created.length, animation: animation.name, length: animation.length };
	});

	tool('delete_animation', 'Deletes an animation.', { animation: { type: 'string' } }, ['animation'], (args) => {
		findAnimation(args.animation).remove(true);
		return { remaining: Animator.animations.map((a) => a.name) };
	});

	tool('run_script', 'Runs JavaScript inside Blockbench with access to its global API (Cube, Group, Texture, Project, Canvas, Undo...), for what the other tools do not cover. The body may use await, and its return value is sent back as JSON. Wrap edits in Undo.initEdit/finishEdit.', {
		code: { type: 'string', description: 'A function body, e.g. "return Cube.all.length".' },
	}, ['code'], async (args) => {
		const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
		const value = await new AsyncFunction(args.code)();
		return value === undefined ? { result: null } : { result: value };
	}, { available: () => scriptsAllowed() });

	// ------------------------------------------------------------------ MCP protocol

	function dialogText(dialog) {
		return (dialog.object ? dialog.object.innerText : dialog.id).replace(/\s+/g, ' ').slice(0, 300);
	}

	const availableTools = () => [...tools.values()].filter((t) => !t.available || t.available());

	let queue = Promise.resolve();
	function enqueue(work) {
		const result = queue.then(work, work);
		queue = result.catch(() => {});
		return result;
	}

	function withTimeout(promise, name) {
		let timer;
		const timeout = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new ToolError(`${name} did not finish within ${TOOL_TIMEOUT_MS / 1000}s. A dialog may be waiting in Blockbench; try capture_window.`)), TOOL_TIMEOUT_MS);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	}

	async function callTool(name, args) {
		const entry = availableTools().find((t) => t.name === name);
		if (!entry) {
			const hint = name === 'run_script' ? ' Ask the user to enable "MCP: Allow run_script" in Blockbench settings.' : '';
			return { isError: true, content: [{ type: 'text', text: `Unknown tool "${name}".${hint}` }] };
		}
		try {
			validate(entry.inputSchema, args, 'arguments');
			logActivity(name);
			const result = await withTimeout(enqueue(() => entry.handler(args)), name);
			const response = result && Array.isArray(result.content) ? result : { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }] };
			if (Dialog.open && name !== 'dismiss_dialog') {
				response.content.push({ type: 'text', text: `A dialog is open in Blockbench: "${dialogText(Dialog.open)}". If it is from your action, close it with dismiss_dialog.` });
			}
			return response;
		} catch (err) {
			if (!(err instanceof ToolError)) console.error(`[MCP] ${name} failed:`, err);
			const message = err instanceof Error ? err.message : String(err);
			logActivity(`${name} failed: ${message}`);
			return { isError: true, content: [{ type: 'text', text: message }] };
		}
	}

	async function handleMessage(message) {
		const isRequest = message && message.id !== undefined && message.id !== null;
		if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
			if (message && message.jsonrpc === '2.0' && (message.result !== undefined || message.error !== undefined)) return null;
			return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
		}
		if (!isRequest) return null;
		const reply = (result) => ({ jsonrpc: '2.0', id: message.id, result });
		const params = message.params || {};
		switch (message.method) {
			case 'initialize': {
				const requested = params.protocolVersion;
				return reply({
					protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: 'blockbench', title: 'Blockbench', version: VERSION },
					instructions: INSTRUCTIONS,
				});
			}
			case 'ping':
				return reply({});
			case 'tools/list':
				return reply({
					tools: availableTools().map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: t.inputSchema,
						...(t.annotations ? { annotations: t.annotations } : {}),
					})),
				});
			case 'tools/call':
				return reply(await callTool(params.name, params.arguments || {}));
			default:
				return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
		}
	}

	// ------------------------------------------------------------------ HTTP over net

	const STATUS_TEXT = { 200: 'OK', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 413: 'Payload Too Large' };

	function writeResponse(socket, status, body, headers = {}) {
		const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
		const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'Unknown'}`, `Content-Length: ${payload.length}`, 'Connection: keep-alive'];
		if (payload.length) lines.push('Content-Type: application/json');
		for (const key in headers) lines.push(`${key}: ${headers[key]}`);
		socket.write(lines.join('\r\n') + '\r\n\r\n');
		if (payload.length) socket.write(payload);
	}

	function parseHead(buffer, end) {
		const lines = buffer.toString('latin1', 0, end).split('\r\n');
		const [method, target] = lines[0].split(' ');
		const headers = {};
		for (const line of lines.slice(1)) {
			const colon = line.indexOf(':');
			if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
		}
		return { method, target, headers };
	}

	function readChunkedBody(buffer, start) {
		const parts = [];
		let position = start;
		for (;;) {
			const lineEnd = buffer.indexOf('\r\n', position);
			if (lineEnd < 0) return null;
			const size = parseInt(buffer.toString('latin1', position, lineEnd), 16);
			if (Number.isNaN(size)) throw new Error('Bad chunk size');
			if (size === 0) {
				if (buffer.length < lineEnd + 4) return null;
				return { body: Buffer.concat(parts), end: lineEnd + 4 };
			}
			if (buffer.length < lineEnd + 2 + size + 2) return null;
			parts.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
			position = lineEnd + 2 + size + 2;
		}
	}

	// Remote clients reach the server through a tunnel, where Host and Origin cannot be trusted
	// or predicted, so they prove themselves with this key instead.
	function getRemoteKey() {
		try {
			return localStorage.getItem(REMOTE_KEY_STORAGE);
		} catch (err) {
			return null;
		}
	}

	function createRemoteKey() {
		const key = nodeCrypto.randomBytes(16).toString('hex');
		localStorage.setItem(REMOTE_KEY_STORAGE, key);
		return key;
	}

	function hasRemoteKey(target) {
		const key = getRemoteKey();
		if (!key) return false;
		let given;
		try {
			given = new URL(target, 'http://127.0.0.1').searchParams.get('key');
		} catch (err) {
			return false;
		}
		if (!given) return false;
		const expected = Buffer.from(key);
		const received = Buffer.from(given);
		return expected.length === received.length && nodeCrypto.timingSafeEqual(expected, received);
	}

	// Blocks web pages: a browser always sends Origin, and a rebound DNS name shows up in Host.
	function isAllowedOrigin(headers, port) {
		if (headers.origin) return false;
		const host = (headers.host || '').toLowerCase();
		return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
	}

	async function handleRequest(socket, request, port) {
		if (!hasRemoteKey(request.target) && !isAllowedOrigin(request.headers, port)) {
			return writeResponse(socket, 403, { error: 'Only local non-browser clients may connect, or remote clients with the key from Tools > MCP Server.' });
		}
		const path = request.target.split('?')[0];
		if (path === '/health' && request.method === 'GET') {
			return writeResponse(socket, 200, { status: 'ok', name: 'blockbench', version: VERSION, blockbench: Blockbench.version, project: Project ? Project.name : null });
		}
		if (path !== '/mcp') return writeResponse(socket, 404, { error: 'Use the /mcp endpoint.' });
		if (request.method !== 'POST') return writeResponse(socket, 405, undefined, { Allow: 'POST' });
		if (!(request.headers['content-type'] || '').toLowerCase().includes('application/json')) {
			return writeResponse(socket, 400, { error: 'Content-Type must be application/json.' });
		}
		let message;
		try {
			message = JSON.parse(request.body.toString('utf8'));
		} catch (err) {
			return writeResponse(socket, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
		}
		if (Array.isArray(message)) {
			const replies = (await Promise.all(message.map(handleMessage))).filter(Boolean);
			return replies.length ? writeResponse(socket, 200, replies) : writeResponse(socket, 202);
		}
		const reply = await handleMessage(message);
		return reply ? writeResponse(socket, 200, reply) : writeResponse(socket, 202);
	}

	function serveConnection(socket, port) {
		let buffer = Buffer.alloc(0);
		let busy = false;
		const closeWith = (status, body) => {
			writeResponse(socket, status, body);
			socket.end();
		};
		const pump = async () => {
			if (busy) return;
			busy = true;
			try {
				while (!socket.destroyed) {
					const headEnd = buffer.indexOf('\r\n\r\n');
					if (headEnd < 0) {
						if (buffer.length > 65536) closeWith(400, { error: 'Headers too large.' });
						break;
					}
					const request = parseHead(buffer, headEnd);
					const bodyStart = headEnd + 4;
					let bodyEnd;
					if ((request.headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
						const chunked = readChunkedBody(buffer, bodyStart);
						if (!chunked) {
							if (buffer.length > MAX_BODY_BYTES) closeWith(413, { error: 'Request too large.' });
							break;
						}
						request.body = chunked.body;
						bodyEnd = chunked.end;
					} else {
						const length = parseInt(request.headers['content-length'] || '0', 10);
						if (length > MAX_BODY_BYTES) {
							closeWith(413, { error: 'Request too large.' });
							break;
						}
						if (buffer.length < bodyStart + length) break;
						request.body = buffer.subarray(bodyStart, bodyStart + length);
						bodyEnd = bodyStart + length;
					}
					buffer = buffer.subarray(bodyEnd);
					await handleRequest(socket, request, port);
				}
			} catch (err) {
				console.error('[MCP] Connection error:', err);
				socket.destroy();
			} finally {
				busy = false;
			}
		};
		socket.on('data', (chunk) => {
			buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
			pump();
		});
		socket.on('error', () => socket.destroy());
	}

	// ------------------------------------------------------------------ server lifecycle and UI

	const status = { server: null, sockets: new Set(), port: null, error: null, log: [] };
	let netModule = null;

	function logActivity(text) {
		const time = new Date().toLocaleTimeString();
		status.log.unshift(`${time}  ${text}`);
		status.log.length = Math.min(status.log.length, 30);
		if (Blockbench.setStatusBarText) Blockbench.setStatusBarText(`AI: ${text}`);
	}

	function scriptsAllowed() {
		return Settings.get('mcp_allow_scripts') === true;
	}

	// Starts and stops run one after another, so a quick double restart cannot leave a server behind.
	let lifecycle = Promise.resolve();
	function inLifecycle(work) {
		lifecycle = lifecycle.then(work, work);
		return lifecycle;
	}
	const startServer = () => inLifecycle(listen);
	const stopServer = () => inLifecycle(closeServer);

	function closeServer() {
		return new Promise((resolve) => {
			const server = status.server;
			status.server = null;
			status.port = null;
			for (const socket of status.sockets) socket.destroy();
			status.sockets.clear();
			if (!server) return resolve();
			server.close(() => resolve());
		});
	}

	async function listen() {
		await closeServer();
		const port = Number(Settings.get('mcp_port')) || DEFAULT_PORT;
		const net = netModule = require('net', {
			message: 'Runs the local MCP server that AI assistants connect to. It only listens on this computer (127.0.0.1).',
			optional: false,
		});
		if (!net) {
			status.error = 'Network permission was denied.';
			return;
		}
		const server = net.createServer((socket) => {
			status.sockets.add(socket);
			socket.on('close', () => status.sockets.delete(socket));
			serveConnection(socket, port);
		});
		await new Promise((resolve) => {
			server.once('error', (err) => {
				status.error = err.code === 'EADDRINUSE' ? `Port ${port} is already in use. Change it in the settings.` : err.message;
				Blockbench.showQuickMessage(`MCP: ${status.error}`, 4000);
				resolve();
			});
			server.listen(port, '127.0.0.1', () => {
				status.server = server;
				status.port = port;
				status.error = null;
				console.log(`[MCP] Listening on http://127.0.0.1:${port}/mcp`);
				resolve();
			});
		});
	}

	// Asks a running ngrok agent for this server's public address, so it can be shown ready to copy.
	function findTunnelAddress(port) {
		return new Promise((resolve) => {
			if (!netModule) return resolve(null);
			let response = '';
			const socket = netModule.connect(NGROK_AGENT_PORT, '127.0.0.1');
			const finish = (value) => {
				socket.destroy();
				resolve(value);
			};
			socket.setTimeout(500, () => finish(null));
			socket.on('error', () => finish(null));
			socket.on('connect', () => socket.write(`GET /api/tunnels HTTP/1.0\r\nHost: 127.0.0.1:${NGROK_AGENT_PORT}\r\n\r\n`));
			socket.on('data', (chunk) => { response += chunk; });
			socket.on('end', () => {
				try {
					const { tunnels } = JSON.parse(response.slice(response.indexOf('\r\n\r\n') + 4));
					const tunnel = tunnels.find((t) => t.public_url.startsWith('https://') && String(t.config && t.config.addr).endsWith(`:${port}`));
					finish(tunnel ? tunnel.public_url : null);
				} catch (err) {
					finish(null);
				}
			});
		});
	}

	function copyRow(label, value) {
		const row = document.createElement('div');
		row.style.cssText = 'margin: 8px 0';
		const title = document.createElement('div');
		title.textContent = label;
		const line = document.createElement('div');
		line.style.cssText = 'display: flex; gap: 6px; align-items: stretch';
		const text = document.createElement('code');
		text.textContent = value;
		text.style.cssText = 'flex: 1; min-width: 0; padding: 4px 6px; user-select: text; word-break: break-all; background: var(--color-back)';
		const button = document.createElement('button');
		button.textContent = 'Copy';
		button.style.cssText = 'min-width: 64px; flex-shrink: 0';
		button.addEventListener('click', () => {
			Clipbench.setText(value);
			Blockbench.showQuickMessage('Copied', 1200);
		});
		line.append(text, button);
		row.append(title, line);
		return row;
	}

	function textLine(text, color) {
		const paragraph = document.createElement('p');
		paragraph.textContent = text;
		if (color) paragraph.style.color = color;
		return paragraph;
	}

	async function showStatusDialog() {
		const port = status.port || Settings.get('mcp_port');
		const url = `http://127.0.0.1:${port}/mcp`;
		const key = getRemoteKey() || createRemoteKey();
		const tunnel = await findTunnelAddress(port);
		const log = document.createElement('pre');
		log.textContent = status.log.join('\n') || 'None yet.';
		log.style.cssText = 'user-select: text; max-height: 160px; overflow: auto';
		const lines = [
			status.server
				? textLine(`Running at ${url}`, 'var(--color-confirm)')
				: textLine(`Stopped${status.error ? ': ' + status.error : ''}`, 'var(--color-close)'),
			copyRow('Claude Code', `claude mcp add --transport http blockbench ${url}`),
			copyRow('ChatGPT, step 1: start the tunnel in a terminal', `ngrok http 127.0.0.1:${port}`),
			copyRow(
				tunnel ? 'ChatGPT, step 2: server URL to enter (tunnel found)' : 'ChatGPT, step 2: server URL to enter (start the tunnel and press Refresh)',
				`${tunnel || 'https://YOUR-NGROK-DOMAIN'}/mcp?key=${key}`
			),
			textLine('Keep this URL secret: it gives access to Blockbench and your files. Close the tunnel when you finish.'),
		];
		if (scriptsAllowed()) {
			lines.push(textLine('Warning: run_script is on, so anyone with this URL can run code on your computer.', 'var(--color-close)'));
		}
		lines.push(textLine('Recent AI activity:'), log);
		const dialog = new Dialog({
			id: 'mcp_status',
			title: 'MCP Server',
			width: 680,
			lines,
			buttons: ['Refresh', 'New key', 'Restart server', 'dialog.close'],
			cancelIndex: 3,
			onButton(index) {
				if (index === 0 || index === 1) {
					if (index === 1) {
						if (!confirm('Create a new key? The current URL stops working, and you will need to update it in ChatGPT.')) return false;
						createRemoteKey();
					}
					dialog.hide();
					showStatusDialog();
					return false;
				}
				if (index === 2) startServer();
			},
		});
		dialog.show();
	}

	const registered = [];

	Plugin.register(PLUGIN_ID, {
		title: 'MCP Server',
		author: 'Franciszek Sikora',
		website: 'https://github.com/sikorafranciszek/blockbench-mcp-addon',
		repository: 'https://github.com/sikorafranciszek/blockbench-mcp-addon',
		bug_tracker: 'https://github.com/sikorafranciszek/blockbench-mcp-addon/issues',
		description: 'Lets AI assistants build models, paint textures and animate in Blockbench, and see the result.',
		about: 'Runs a Model Context Protocol server on this computer. Connect any MCP client to the URL shown in Tools > MCP Server. Everything the AI does happens in the open project and can be undone.',
		icon: 'hub',
		version: VERSION,
		variant: 'desktop',
		min_version: '5.2.0',
		tags: ['Minecraft', 'AI', 'Automation'],
		onload() {
			registered.push(new Setting('mcp_port', {
				value: DEFAULT_PORT,
				type: 'number',
				min: 1024,
				max: 65535,
				category: 'general',
				name: 'MCP: Server port',
				description: 'Port of the local MCP server. AI clients connect to http://127.0.0.1:<port>/mcp',
				onChange: () => startServer(),
			}));
			registered.push(new Setting('mcp_allow_scripts', {
				value: false,
				type: 'toggle',
				category: 'general',
				name: 'MCP: Allow run_script',
				description: 'Lets connected AI clients run any JavaScript inside Blockbench, with access to your files. Leave off unless you need it. Clients must reconnect to see the tool.',
			}));
			const action = new Action('mcp_server_status', {
				name: 'MCP Server',
				description: 'Server address, connection help and recent AI activity',
				icon: 'hub',
				category: 'tools',
				click: showStatusDialog,
			});
			MenuBar.addAction(action, 'tools');
			registered.push(action);
			startServer();
		},
		onunload() {
			stopServer();
			for (const item of registered) item.delete();
			registered.length = 0;
		},
	});
})();
