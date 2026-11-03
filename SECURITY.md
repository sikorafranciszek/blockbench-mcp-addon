# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's security advisory form](https://github.com/sikorafranciszek/blockbench-mcp-addon/security/advisories/new), not in a public issue. Include the steps to reproduce the problem and what an attacker could do with it.

Only the latest version is supported.

## What the plugin protects against

- **Websites:** requests with an `Origin` header or an unexpected `Host` are rejected unless they carry the secret key, which blocks cross-site requests and DNS rebinding.
- **Requests through a tunnel:** these need the secret key from `Tools > MCP Server`, which is 128 bits of random data, compared in constant time. No key exists until you open that window, and **New key** replaces it.
- **The network:** the server listens only on `127.0.0.1`.
- **Accidental overwrites:** existing files are replaced only when the call sets `overwrite: true`.
- **Code execution through tools:** `run_script` stays unavailable until the user turns on its setting.

## What it does not protect against

- **Other programs on your computer:** the server has no password, so any local program can connect and use the tools.
- **Your AI client:** a connected client can read and write files at any path the Blockbench process can reach. Prompt injection in content the AI reads could misuse this, so connect only clients you trust.
- **`run_script`, when enabled:** it gives connected clients full access to Blockbench and your files.
- **A leaked tunnel address:** the address contains the key, so anyone who has it gets the same access as your AI client, including `run_script` if you enabled it. See the [ChatGPT guide](docs/chatgpt-ngrok.md), and close the tunnel when you are not using it.
