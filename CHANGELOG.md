# Changelog

This project follows [Semantic Versioning](https://semver.org/).

## 1.1.0

- Add a secret key for remote clients, so a tunnel works without extra configuration, including on ngrok's free plan
- Show copy buttons in `Tools > MCP Server` for the Claude Code command, the ngrok command and the ChatGPT address
- Find the running ngrok tunnel's address automatically
- Add a guide for ChatGPT through ngrok, in English and Polish

## 1.0.0

First release.

- MCP server inside Blockbench over Streamable HTTP, with a stdio bridge
- Rendered previews from any angle and animation frame, and texture inspection
- Tools for modeling, texturing, animation and project management
- Painting on cube faces in face pixel coordinates
- Protection against requests from websites, and `run_script` off by default
