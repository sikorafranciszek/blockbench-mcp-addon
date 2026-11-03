# Use Blockbench MCP with ChatGPT through ngrok

[Polska wersja](chatgpt-ngrok.pl.md)

ChatGPT runs in the cloud and can only reach servers on the internet, while the plugin's server listens only on your computer. An [ngrok](https://ngrok.com/) tunnel connects the two.

> [!WARNING]
> **A tunnel exposes the server to the internet, and the server has no password.** Anyone who can reach it can control Blockbench and read and write files at any path Blockbench can access. Follow the steps below exactly: the secret address in step 2 is what protects you. Treat that address like a password, and close the tunnel when you finish.

> [!NOTE]
> The tunnel was tested on ngrok's free plan with the official MCP client, including rejected requests and work on a model. The final connection from ChatGPT itself has not been tested yet. If a step behaves differently, please [open an issue](https://github.com/sikorafranciszek/blockbench-mcp-addon/issues).

## What you need

- Blockbench with the plugin running. See the [quick start](../README.md#quick-start).
- A free [ngrok account](https://dashboard.ngrok.com/signup).
- ChatGPT on the web, on an account that can add custom MCP servers. OpenAI's documentation does not list plans and says workspace policies apply, so on a work account an admin may need to allow it.

## 1. Install ngrok

On Windows:

```bash
winget install Ngrok.Ngrok
```

Winget can install an old version that lacks the options used here, so update it right away:

```bash
ngrok update
```

Other systems can use the [ngrok downloads page](https://ngrok.com/download). Then add the token from your [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken):

```bash
ngrok config add-authtoken YOUR_TOKEN
```

## 2. Create the secret address

Generate a random value and keep it for the next steps.

In PowerShell:

```powershell
[guid]::NewGuid().ToString('N')
```

On macOS or Linux:

```bash
openssl rand -hex 16
```

In the repository root, copy [`docs/ngrok-policy.example.yml`](ngrok-policy.example.yml) to `ngrok-policy.yml`. Replace `REPLACE_WITH_SECRET` with your value. Git ignores this file, so the secret will not be committed.

If you changed the plugin's port, also update `host` in the policy and the port in the next command.

## 3. Start the tunnel

Run this in the repository root:

```bash
ngrok http 127.0.0.1:3939 --traffic-policy-file ngrok-policy.yml
```

ngrok shows a `Forwarding` line with your public domain. Your server address is that domain plus the secret:

```text
https://YOUR-DOMAIN/mcp?key=YOUR_SECRET
```

## 4. Check the tunnel

Use `curl.exe` instead of `curl` in Windows PowerShell.

The secret address should return **405**. That is correct: the request reached the plugin, which accepts only POST on this address.

```bash
curl -i "https://YOUR-DOMAIN/mcp?key=YOUR_SECRET"
```

An address without the secret should return **404**. If it reaches the plugin instead, stop the tunnel and check your policy file.

```bash
curl -i https://YOUR-DOMAIN/mcp
```

## 5. Add the server to ChatGPT

1. Open [chatgpt.com/plugins](https://chatgpt.com/plugins).
2. Select the plus button, then **Add custom MCP server**.
3. Enter a name, such as `Blockbench`.
4. Under **Connection**, enter your full server address from step 3 as the server URL.
5. Set **Authentication** to **No authentication**. The secret address does this job instead.
6. Review the risk warning and select **I understand and want to continue**.
7. Select **Create as a plugin**, check that the tools appear, and install the plugin.

OpenAI changes these menus from time to time. Its guide to [adding a custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server) has the current steps.

## 6. Use it

Keep Blockbench and the tunnel running. Start a new conversation, type `@`, select your plugin and ask for something:

> Use Blockbench to make a small Minecraft-style lantern in the java_block format. Check the preview after each stage.

ChatGPT asks you to confirm each tool that changes something. Read-only tools, such as previews, do not ask. You can choose to remember a decision for one tool within a conversation.

OpenAI's documentation does not say how ChatGPT handles images returned by tools. If ChatGPT does not react to previews, use the live view in Blockbench to check its work and tell it what to fix.

## When you finish

Press `Ctrl+C` in the ngrok window to close the tunnel. While the tunnel is closed, ChatGPT cannot reach Blockbench.

If the secret address leaks, change the value in `ngrok-policy.yml`, restart ngrok and update the URL in ChatGPT.

## Staying safe

- Keep the `MCP: Allow run_script` setting **off**, and check it before you start the tunnel. With it on, a leaked address would let others run code on your computer.
- Close the tunnel whenever you are not using it.
- Read each confirmation before approving it, especially for tools that save or export files. A web page or file that ChatGPT reads could try to trick it into misusing them.
- Never put the address in a screenshot, a repository or a public chat.
- ngrok can also limit access to OpenAI's [published IP ranges](https://developers.openai.com/api/docs/guides/ip-addresses) with the [`restrict-ips` action](https://ngrok.com/docs/traffic-policy/actions/restrict-ips). These ranges change over time, and this adds to the secret address rather than replacing it.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| ngrok reports `unknown flag: --traffic-policy-file` or `unknown version '3'` | Your ngrok is too old. Run `ngrok update`. If that reports the version error too, install the current version from the [downloads page](https://ngrok.com/download). |
| ngrok reports `ERR_NGROK_2263` | Your policy uses a paid feature. The example policy uses only actions that the free plan accepts, while `url-rewrite` and `remove-headers` need a paid plan. |
| Step 4 returns **403** instead of 405 | The request reached the plugin, but the host in `ngrok-policy.yml` does not match its address and port. |
| ChatGPT reports **403** with `Only local non-browser clients may connect` | ChatGPT sent an `Origin` header, which the plugin refuses. This has not been seen in testing, so please [open an issue](https://github.com/sikorafranciszek/blockbench-mcp-addon/issues). |
| ChatGPT reports **404** | It may have changed the address. The policy accepts only the exact `key=YOUR_SECRET` query, so please check the URL you entered. |
| ngrok reports an error reaching the server, or returns 502 | Blockbench is closed, or the plugin is not running. Check `Tools > MCP Server`. |
| Both addresses return **404** | The secret in the policy file and the one in the address differ. Check that they match. |
| ChatGPT receives an ngrok warning page (`ERR_NGROK_6024`) | Free accounts show this page to browsers. It should not affect API traffic, but if it does, a paid ngrok plan removes it. |
| ChatGPT does not show new tools | After updating the plugin, open the plugin's details page in ChatGPT and refresh it. |
| The tunnel stops working | The free ngrok plan has [monthly limits](https://ngrok.com/docs/pricing-limits/free-plan-limits). Images use up the bandwidth limit fastest. |
