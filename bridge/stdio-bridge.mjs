#!/usr/bin/env node
// Connects MCP clients that only speak stdio (such as Claude Desktop's local config)
// to the HTTP server inside Blockbench. It needs Node.js 18 or newer and has no dependencies.
//
// usage: node stdio-bridge.mjs [port]   (or set BLOCKBENCH_MCP_PORT, default 3939)
import { createInterface } from 'node:readline';

const port = process.argv[2] || process.env.BLOCKBENCH_MCP_PORT || '3939';
const url = `http://127.0.0.1:${port}/mcp`;
const NOT_RUNNING = `Blockbench is not reachable at ${url}. Start Blockbench with the MCP Server plugin enabled, then try again.`;
const REQUEST_TIMEOUT_MS = 180000;

function send(message) {
	process.stdout.write(JSON.stringify(message) + '\n');
}

async function forward(message) {
	const isRequest = message.id !== undefined && message.id !== null;
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
			body: JSON.stringify(message),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await response.text();
		if (!isRequest) return;
		if (!text) throw new Error(`Empty response, HTTP ${response.status}`);
		send(JSON.parse(text));
	} catch (err) {
		if (!isRequest) return;
		const unreachable = err.cause?.code === 'ECONNREFUSED' || err.name === 'TimeoutError';
		// A failed tool call is shown to the model, which can then ask the user to open Blockbench.
		if (message.method === 'tools/call') {
			send({ jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: unreachable ? NOT_RUNNING : String(err.message) }] } });
		} else {
			send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: unreachable ? NOT_RUNNING : String(err.message) } });
		}
	}
}

// Requests are forwarded in order, because Blockbench handles one at a time anyway.
let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
		return;
	}
	chain = chain.then(() => forward(message));
}).on('close', () => {
	chain.finally(() => process.exit(0));
});
