// Minimal MCP client for the end-to-end tests.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const URL_MCP = process.env.BLOCKBENCH_MCP_URL || 'http://127.0.0.1:3939/mcp';
let nextId = 1;

export async function rpc(method, params) {
	const response = await fetch(URL_MCP, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
		body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} for ${method}`);
	const message = await response.json();
	if (message.error) throw new Error(`${method}: ${message.error.message}`);
	return message.result;
}

// Returns the parsed text of a tool result; throws when the tool reports an error.
export async function call(name, args = {}) {
	const result = await rpc('tools/call', { name, arguments: args });
	const text = result.content.find((c) => c.type === 'text')?.text;
	if (result.isError) throw new Error(`${name}: ${text}`);
	return { data: /^[[{]/.test(text) ? JSON.parse(text) : undefined, images: result.content.filter((c) => c.type === 'image') };
}

export async function expectError(name, args, pattern) {
	const result = await rpc('tools/call', { name, arguments: args });
	const text = result.content[0].text;
	if (!result.isError) throw new Error(`${name} should have failed, got ${text.slice(0, 200)}`);
	if (pattern && !pattern.test(text)) throw new Error(`${name} failed with the wrong message: ${text}`);
	return text;
}

export function saveImage(outDir, file, image) {
	mkdirSync(outDir, { recursive: true });
	const path = join(outDir, file);
	writeFileSync(path, Buffer.from(image.data, 'base64'));
	return path;
}
