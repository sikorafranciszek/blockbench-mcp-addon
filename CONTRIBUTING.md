# Contributing

Bug reports and pull requests are welcome. For a large change, please open an issue first so we can agree on the approach.

## Setup

You need [Blockbench](https://www.blockbench.net/) 5.2 or newer and [Node.js](https://nodejs.org/) 18 or newer. The project has no dependencies and no build step.

1. Load `plugin/blockbench_mcp.js` in Blockbench with `File > Plugins... > Load Plugin from File`.
2. After editing the file, click the reload icon next to the plugin in the same window.

## Checks

Before opening a pull request, run both of these:

```bash
npm run check
npm test
```

`npm test` needs Blockbench running with the plugin loaded. It opens and closes its own project tabs and switches the active tab while it runs, so let it finish before going back to your work. It writes files only to `test/output`.

The tests cannot judge how things look. If you change rendering or painting, also look at the images in `test/output`.

## Guidelines

- **Keep the plugin one file with no dependencies,** so that installing it stays a single step.
- **Make each tool call one undo step.** Use the `undoable` helper.
- **Write error messages for the AI.** Say what to do next, not only what went wrong.
- **Never block on a dialog.** Blockbench's own dialogs can stop a tool call, so avoid code paths that open them.
- **Add a tool only when existing tools cannot do the job.** Every tool adds to what the AI has to read.
- **Add new tools to the README and to `test/smoke.mjs`.**
