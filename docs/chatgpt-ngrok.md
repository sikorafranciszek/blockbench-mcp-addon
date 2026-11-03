# Use Blockbench MCP with ChatGPT through ngrok

[Polska wersja](chatgpt-ngrok.pl.md)

ChatGPT runs in the cloud and can only reach servers on the internet, while the plugin's server listens only on your computer. An [ngrok](https://ngrok.com/) tunnel connects the two, and everything you need to copy is in Blockbench under `Tools > MCP Server`.

> [!WARNING]
> **A tunnel makes the server reachable from the internet.** Only requests with your secret key get through, but anyone who has the full address can control Blockbench and read and write files at any path Blockbench can access. Treat the address like a password, and close the tunnel when you finish.

> [!NOTE]
> ngrok's free plan and the plugin's key were tested with the official MCP client. The final connection from ChatGPT itself has not been tested yet. If a step behaves differently, please [open an issue](https://github.com/sikorafranciszek/blockbench-mcp-addon/issues).

## What you need

- Blockbench with version 1.1 or newer of the plugin. See the [quick start](../README.md#quick-start).
- A free [ngrok account](https://dashboard.ngrok.com/signup).
- ChatGPT on the web, on an account that can add custom MCP servers. OpenAI's documentation does not list plans and says workspace policies apply, so on a work account an admin may need to allow it.

## 1. Install ngrok

Install ngrok from the [Microsoft Store](https://apps.microsoft.com/detail/9MVS1J51GMK6) or the [ngrok downloads page](https://ngrok.com/download). Then add the token from your [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken):

```bash
ngrok config add-authtoken YOUR_TOKEN
```

You only need to do this once.

## 2. Start the tunnel

Open `Tools > MCP Server` in Blockbench. Under **ChatGPT, step 1**, select **Copy**, then paste and run the command in a terminal:

```bash
ngrok http 127.0.0.1:3939
```

Keep this terminal open. Do not add `--host-header` or a policy that rewrites the host, because that would weaken the plugin's protection.

## 3. Copy the address

Go back to the `MCP Server` window and select **Refresh**. The label under **ChatGPT, step 2** should now say `tunnel found`, and the address contains your ngrok domain and key:

```text
https://YOUR-DOMAIN/mcp?key=YOUR_KEY
```

Select **Copy** next to it. The plugin creates the key the first time you open this window and keeps it. With another ngrok agent running, the plugin may not find the address: in that case, replace `YOUR-NGROK-DOMAIN` with the domain from the `Forwarding` line in the terminal.

## 4. Add the server to ChatGPT

1. Open [chatgpt.com/plugins](https://chatgpt.com/plugins).
2. Select the plus button, then **Add custom MCP server**.
3. Enter a name, such as `Blockbench`.
4. Under **Connection**, paste the address from step 3 as the server URL.
5. Set **Authentication** to **No authentication**. The key in the address does this job instead.
6. Review the risk warning and select **I understand and want to continue**.
7. Select **Create as a plugin**, check that the tools appear, and install the plugin.

OpenAI changes these menus from time to time. Its guide to [adding a custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server) has the current steps.

## 5. Use it

Keep Blockbench and the tunnel running. Start a new conversation, type `@`, select your plugin and ask for something:

> Use Blockbench to make a small Minecraft-style lantern in the java_block format. Check the preview after each stage.

ChatGPT asks you to confirm each tool that changes something. Read-only tools, such as previews, do not ask. You can choose to remember a decision for one tool within a conversation.

OpenAI's documentation does not say how ChatGPT handles images returned by tools. If ChatGPT does not react to previews, use the live view in Blockbench to check its work and tell it what to fix.

## When you finish

Press `Ctrl+C` in the ngrok terminal to close the tunnel. While the tunnel is closed, ChatGPT cannot reach Blockbench.

ngrok's free domain stays the same, so the address in ChatGPT keeps working the next time you start the tunnel.

## Staying safe

- If the address leaks, select **New key** in the `MCP Server` window, then update the URL in ChatGPT. The old key stops working immediately.
- Keep the `MCP: Allow run_script` setting **off**. With it on, a leaked address would let others run code on your computer, and the `MCP Server` window shows a warning.
- Close the tunnel whenever you are not using it.
- Read each confirmation before approving it, especially for tools that save or export files. A web page or file that ChatGPT reads could try to trick it into misusing them.
- Never put the address in a screenshot, a repository or a public chat. Tools such as ngrok's request inspector at `http://127.0.0.1:4040` can show it too.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The `MCP Server` window has no **New key** button | The plugin is out of date or was not reloaded. Update the file, then restart Blockbench. |
| Requests return **403** | The key is missing or wrong. Copy the address from the `MCP Server` window again. |
| ngrok reports an error reaching the server, or returns 502 | Blockbench is closed, or the plugin is not running. Check `Tools > MCP Server`. |
| ngrok reports that the endpoint is already online (`ERR_NGROK_334`) | A tunnel is already running. The free plan has one domain, so close the other one first. |
| ChatGPT receives an ngrok warning page (`ERR_NGROK_6024`) | Free accounts show this page to browsers. It should not affect API traffic, but if it does, a paid ngrok plan removes it. |
| ChatGPT does not show new tools | After updating the plugin, open the plugin's details page in ChatGPT and refresh it. |
| The tunnel stops working | The free ngrok plan has [monthly limits](https://ngrok.com/docs/pricing-limits/free-plan-limits). Images use up the bandwidth limit fastest. |
