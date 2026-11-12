# AI assistants (MCP)

3Dica comes with an [MCP](https://modelcontextprotocol.io) server, so an AI assistant such as Claude Code or
Claude Desktop can work in a 3Dica that runs on your machine. The assistant can read the scene, create and edit
objects and their code, undo, save, export STL, and **see the result** with screenshots. You can watch it build in your
own browser tab and take over at any time, or let it run on its own with a headless browser.

![A screenshot taken by the assistant: the sample in four orthographic views (front, right, top and iso), each with its label, an axis triad and a scale bar](/shots/mcp-multiview.png)

## What you need

- **A local copy of 3Dica.** Clone the repository and run `npm ci`, as in [Getting started](/guide/getting-started).
  The app only connects to the MCP server when it runs on `localhost`. The published site never does.
- **Node.js 20.19 or newer.** The MCP client starts the server with `node`.
- **An MCP client**: Claude Code, Claude Desktop, or any client that can start a local stdio server.
- For the headless mode only: the Chromium build that Playwright uses. If you have never run the e2e tests on this
  machine, install it once with `npx playwright install chromium`.

## How it fits together

The MCP client starts `node mcp/server.mjs`. The server talks MCP to the client over stdin and stdout, and it opens a
WebSocket on `127.0.0.1`, port 6173 by default. A 3Dica tab opened with `?mcp` in its address joins that socket. Every
tool call is then handled **inside the tab**, with the same operations as the toolbar and the inspector.

| Part | Runs where | Job |
|---|---|---|
| Your MCP client | your machine | Starts the server, shows the tools to the model, asks you before tool calls |
| `mcp/server.mjs` | your machine (Node) | Defines the tools, writes and reads files, forwards everything else to the tab |
| The 3Dica tab | your browser, or a headless one | Does the work: edits the project, evaluates, renders the screenshots |

## Set up Claude Code

The repository has a `.mcp.json` file. Start Claude Code in the 3Dica folder and it offers the `3dica` server, so you
approve it once and you're done. The file contains:

```json
{
  "mcpServers": {
    "3dica": { "command": "node", "args": ["mcp/server.mjs"] }
  }
}
```

To add the server by hand, or to use it from another folder, register it with the full path:

```sh
claude mcp add 3dica -- node /path/to/3dica/mcp/server.mjs
```

Add `--scope user` before the name to make it available in all your projects. Type `/mcp` in Claude Code to check
that the server is connected.

::: warning Use node, not npm run
Put `node mcp/server.mjs` in client configurations, not `npm run mcp`. npm prints a banner to stdout, and stdout is
where the MCP messages go, so the client can't parse them.
:::

## Set up Claude Desktop

Open **Settings › Developer › Edit Config** and add the server to `claude_desktop_config.json`. The file is in
`~/Library/Application Support/Claude/` on macOS and in `%APPDATA%\Claude\` on Windows. Use absolute paths:

```json
{
  "mcpServers": {
    "3dica": {
      "command": "node",
      "args": ["/path/to/3dica/mcp/server.mjs"]
    }
  }
}
```

Restart Claude Desktop afterwards. If `node` comes from a version manager such as nvm, Claude Desktop may not find it.
Put the full path of the `node` binary in `command` instead (`which node` prints it).

For any other client, the command is `node /path/to/3dica/mcp/server.mjs` and the transport is stdio.

## Mode 1: watch it build in your tab

1. Start 3Dica as usual: `npm run dev` in the 3Dica folder.
2. Open `http://localhost:5173/?mcp` in your browser. Add `?fresh&mcp` instead if you want to start from the sample.
3. Ask the assistant to do something. The status bar shows **MCP · connected** at the right.

The tab remembers the choice, so a reload or a later visit to `http://localhost:5173` connects again without `?mcp`.
You see every change as it happens: new rows in the Scene tree, updated code in the editor and the 3D view. You can
keep working at the same time.

![The status bar pill "MCP · connected" with its menu open: what the connection is, the last change made by the assistant, and "Disconnect and disable"](/shots/mcp-status.png)

The pill appears only while the bridge is turned on:

| Pill | Meaning |
|---|---|
| **MCP · connecting…** | The tab is looking for the server. It retries on its own, with pauses that grow from 0.5 s to 10 s. |
| **MCP · connected** | The assistant's tool calls go to this tab. |
| **MCP · superseded** | Another tab connected after this one, so the calls go there now. This tab is idle. |

Click the pill for its menu. **Use this tab** (only when superseded) makes this tab the active one again.
**Disconnect and disable** closes the connection and forgets the choice, and a toast confirms it. To turn the bridge on
again, open the address with `?mcp`.

| Address | Effect |
|---|---|
| `?mcp` | Turn the bridge on for this browser, and remember it |
| `?mcp&mcpPort=6200` | The same, for a server started with `--port 6200` (the port is remembered too) |
| `?mcp=0` | Turn it off and forget it |

The choice is stored in the browser under `3dica:v1:mcp` (see [Files, autosave and STL](/reference/files)). The tab
doesn't need to be in front: it keeps answering while it is in the background.

## Mode 2: let it run on its own

With `--serve --headless` the server needs nothing else: it starts the app and a headless browser for itself.

```sh
claude mcp add 3dica-auto -- node /path/to/3dica/mcp/server.mjs --serve --headless
```

- `--serve` checks `http://localhost:5173` (or the `--app-port` you give). If 3Dica already runs there, it uses it.
  Otherwise it starts a Vite dev server inside the MCP server process. If another program holds the port, Vite takes
  the next free one; with `--app-port`, the server reports an error instead.
- `--headless` opens the app in headless Chromium with a fresh profile, so it starts with the sample project.

The first tool call waits until the headless tab is connected, which takes a few seconds. Everything stops when the
client closes the server. You only see the work through the assistant's screenshots, or by opening the same address
yourself (your tab then becomes the active one).

| Option | Default | What it does |
|---|---|---|
| `--port` `<n>` | 6173 (or the `THREEDICA_MCP_PORT` environment variable) | The WebSocket port on 127.0.0.1 |
| `--serve` | off | Start a Vite dev server for 3Dica if nothing answers at the app address |
| `--app-port` `<n>` | 5173 | Port for `--serve` and for the default app address |
| `--app-url` `<url>` | `http://localhost:<app-port>/` | Where the app runs, if it isn't the default |
| `--headless` | off | Open the app in headless Chromium |
| `--open` | off | Open the app in your default browser instead |
| `--help` | | Print the options |

::: tip Two assistants at once
Each MCP server needs its own port. A second Claude Code session that starts the server on 6173 while another one
runs reports *port 6173 is already in use* in every tool. Give the second one `--port 6174`, and open its tab with
`?mcp&mcpPort=6174`. A headless tab also supersedes a tab of yours on the same server, because it connected last.
:::

## How the assistant works

The server gives the model a short briefing when it connects: units are millimetres, Z is up, what a code definition
is, and the recommended loop. In short:

1. **Change one thing**, for example `create_object` or `update_definition`.
2. **Read the result.** Every editing tool waits for the evaluation to finish and reports the status of the objects it
   touched, their size in mm, warnings, and every error in the project with its line number.
3. **Look**: `screenshot` with the multi view shows front, right, top and iso at once.
4. **Fix and repeat.**

This is what `create_object` returned for the tutorial's Bracket, placed in the sample:

```json
{
  "ok": true,
  "definition": "Bracket",
  "instanceId": "i_si21ft2lv8",
  "path": ["i_si21ft2lv8"],
  "transform": { "t": [120, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1] },
  "evaluation": "done",
  "objects": [
    { "definition": "Bracket", "kind": "code", "status": "ok", "triangles": 20, "size": [30, 20, 25], "copies": 1 }
  ],
  "errors": []
}
```

And this is `update_definition` with code that throws on its second line:

```json
{
  "ok": true,
  "changed": true,
  "definition": "Bracket",
  "evaluation": "done",
  "objects": [
    { "definition": "Bracket", "kind": "code", "status": "error",
      "error": { "kind": "runtime", "message": "boom", "line": 2, "col": 7 }, "copies": 1 }
  ],
  "errors": [{ "definition": "Bracket", "kind": "runtime", "message": "boom", "line": 2, "col": 7 }]
}
```

`"ok": true` means the edit was made. Whether the code works is in `objects` and `errors`. A refused edit (an
unknown name, a definition that is still in use) comes back as a tool error with a message instead.

::: tip Undo the assistant
Every change the assistant makes is one ordinary step in the undo history, labelled `MCP: …` (for example
*MCP: Add Bracket*). Press <kbd>Ctrl</kbd>+<kbd>Z</kbd> to undo it, like your own edits. The assistant's `undo` and
`redo` tools walk the same history, so they can undo your steps too. They return the labels they undid.
:::

Objects are addressed the way 3Dica stores them. A placed object is an **instance path**: the instance ids from the
scene root down, such as `["i_fx1", "i_b1"]` for the first bolt of Fixture A (`"i_fx1/i_b1"` works too). A definition
is addressed by its name, such as `"Bolt"`. `get_scene` lists the paths. Read [The 3Dica model](/concepts/model) for
the difference between definitions, instances and occurrences.

## Tools

### Reading

| Tool | Parameters | Returns |
|---|---|---|
| `status` | none | Whether a tab is connected and how to connect one; the project name, counts, selection, view mode, evaluator state, error count, the last undo and redo labels, the camera |
| `get_scene` | `path` (a subtree), `depth`, `maxNodes` (default 500), `bbox` (default true) | The occurrence tree: path, label, definition, kind and op, operand role inside a boolean (base, cut, other), local transform, color, overrides, hidden, status, world bounding box in mm |
| `list_definitions` | none | Every definition: kind, op, parameters, color, copies in the scene, instance records, `part()` references both ways, status, error |
| `get_definition` | `name` | One definition in full: its code and parameters, or its op and children |
| `get_errors` | none | Every definition in error: kind, message, line, column, the inner definition that failed and the trace |
| `help` | none | The code API cheat sheet (also the resource `threedica://docs/code-api`) |

### Creating and editing

Each of these is one undo step, and each returns the evaluation report shown above.

| Tool | Parameters | What it does |
|---|---|---|
| `create_object` | `kind` (cube, sphere, cylinder, torus, code, group), `name`, `code`, `params`, `defaults`, `op`, `parent`, `transform`, `color` | Makes a **new** definition and places one instance of it. The primitives start from the toolbar templates and sit on Z = 0. `parent` is a group's instance path, or a group definition's name (then every copy of that group gets the object); the default is the scene root. Without `transform` the object is placed to the right of the others, as the toolbar does. |
| `update_definition` | `name`, then any of `code`, `params`, `defaults`, `op`, `color` (`null` clears), `rename` | Changes a definition, and so every copy of it. A rename rewrites the `part()` calls. |
| `add_instance` | `definition`, `parent`, `transform`, `params` (overrides), `label`, `color`, `index` | Places another linked copy of an existing definition, in the scene root unless you give a `parent` (as for `create_object`). The default transform is the parent's origin, and the default `index` is last. |
| `update_instance` | `path`, then any of `transform` (only the fields you give), `params` (`null` removes an override), `label` (`null` clears), `color` (`null` clears), `hidden` | Changes one placed object. An instance inside a group definition exists in every copy of that group, and the result says so. |
| `move_instance` | `path`, `toParent` (a group's path, `[]` for the scene root), `index` | Moves an object into another group, keeping its world position, like dragging it in the tree |
| `duplicate` | `path`, `mode` (`linked`, the default, or `unique`), `offset` (mm along X) | Copies an object next to the original, like <kbd>Ctrl</kbd>+<kbd>D</kbd> or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>. Without `offset` it moves the copy by the object's width plus 5 mm. |
| `make_unique` | `path` | Gives the object its own copy of its definition, one level deep |
| `wrap` | `path`, `op` (`none`, the default, `union`, `subtract` or `intersect`), `name` | Wraps the object in a new group or boolean. The object becomes its first child, which is the base of a subtract. |
| `ungroup` | `path` | Replaces a group by its children, keeping their world positions |
| `delete` | `path`, or `definition` with `cascade` | Deletes one placed object, or a whole definition. A definition with instances needs `cascade: true`. One that other code calls with `part()` can't be deleted. |

`params` is a list of parameter definitions, the same fields as the inspector's table (see [Parameters](/reference/parameters)):

```json
[{ "name": "width", "type": "number", "default": 30, "min": 1, "max": 200, "step": 1 }]
```

`defaults` is shorter when you only want other values, for example `{ "width": 40, "depth": 30, "height": 5 }` for a
cube. `transform` is `{ "t": [x, y, z], "r": [x, y, z], "s": [x, y, z] }` with millimetres, degrees and scale factors,
as in [Transforms and the gizmo](/reference/transforms).

### History, selection and view

| Tool | Parameters | What it does |
|---|---|---|
| `undo`, `redo` | `steps` (1 to 50, default 1) | Walks the shared history and returns the labels, for example `"undone": ["MCP: Edit Bracket"]` |
| `select` | `path`, or `definition`, or nothing | Changes **your** selection. A definition is shown isolated, as a Library click does. Nothing clears the selection. |
| `set_view` | `mode` (context, isolate), `ghost`, `preset` (front, right, top, iso, all, selection) | Changes what **you** see. Screenshots never need it. |

### Projects and files

The server reads and writes these files itself, so they land on your disk and not in the browser's downloads. A
relative path is relative to the server's working directory. That is the project folder in Claude Code, but often
not in Claude Desktop, so use absolute paths there. `~/` means your home folder.

| Tool | Parameters | What it does |
|---|---|---|
| `new_project` | `name` | Replaces the project with an empty one, without asking. Not undoable. |
| `load_sample` | none | Replaces the project with the sample *Bracket kit*. Not undoable. |
| `save_project` | `path` | Writes a `.3dica.json` file. Overwrites an existing file; the folder must exist. |
| `load_project` | `path` | Opens a `.3dica.json` file and **runs its code without asking** (see the warning below). Not undoable. |
| `export_stl` | `path`, `target` | Writes a binary STL. No target: the whole visible scene. A path: that object, in world position. A definition name: that definition alone at the origin, with its default parameters. |

## Screenshots

`screenshot` returns a PNG image and a few lines of text. It never moves your camera, changes your selection or makes
the view flicker: it renders separately and puts everything back within the same moment.

| Option | Values | Default | Meaning |
|---|---|---|---|
| `view` | `multi`, `front`, `right`, `top`, `iso`, `current` | `multi` | `multi` is a 2×2 image: front and right on top, top and iso below. front looks along +Y, right along −X, top down −Z (with +Y up), iso from +X −Y +Z. These four are orthographic, so parallel edges stay parallel and sizes compare directly. `current` is your own perspective camera. |
| `target` | an instance path or a definition name | the whole scene | Frames that object. A definition name frames all its copies. |
| `isolate` | true, false | false | With `target`: draw it alone at the origin. A definition is drawn with its default parameters, a path with that copy's overrides. A target that isn't drawn on its own (a boolean's cutter, a hidden object) is isolated automatically, and the text says so. |
| `style` | `clean`, `as-seen` | `clean` | `clean` draws plain materials: no selection highlight, linked tint, ghosting, boolean operands or gizmo. `as-seen` keeps your materials and selection, and with `view: current` also the gizmo: exactly your screen, at the requested size. |
| `grid` | true, false | true | The 10 mm grid and the X and Y axis lines on Z = 0 |
| `width`, `height` | 16 to 2048 | 800 × 600 | Image size in pixels |

In the clean style and in the multi view, each view gets a label at the top left, an axis triad at the bottom left
(X red, Y green, Z blue, as they point in that view) and, for orthographic views, a scale bar at the bottom right.
The text describes the image, for example:

```text
3Dica screenshot 800×600 px · view multi (2×2: front | right / top | iso, all orthographic) · style clean · grid 10 mm cells, 200 mm across, on Z = 0
Shows the whole scene (3 visible top-level objects).
Framed box: 139.2 × 76 × 34.5 mm (X × Y × Z), min [-30, -48.9, -7], max [109.15, 27.08, 27.5].
Drawn: 36 meshes, 69,052 triangles.
Scale (mm per px): front 0.38, right 0.21, top 0.38, iso 0.42.
Axes in the corner triad: X red, Y green, Z blue.
No evaluation errors.
```

If something is still evaluating, or code is paused because you opened a file without running it, the text says so.
An object whose code fails shows its last good shape tinted red, or nothing.

## Example prompts

- *Connect to 3Dica and describe what's in the scene. Take a multi-view screenshot.*
- *Make a 40 × 30 × 5 mm plate with a 6 mm hole in the middle, as a subtract group named "Plate with hole". Check it
  from the top.*
- *Write a code object "Bracket" with parameters width, height and thickness: an L-shaped bracket. Then make
  "Bracket row", which places four brackets in a row with part(). Show me both, isolated.*
- *The Bolt's thread looks too coarse. Find where the pitch is set, change it to 0.5 mm and compare before and after.*
- *Make the second fixture unique and widen only its plate to 80 mm.*
- *Export the Plate with hole to plate.stl and save the project as plate.3dica.json.*

## Security

::: warning What the assistant can do
- **It runs code on your computer.** Code objects run in a Web Worker in your browser with no sandbox, the same as
  code you type. `load_project` opens a file **without** the app's *This file contains code that runs on your
  computer. Run it?* question, because the request comes from your own assistant. Only load files you trust.
- **It reads and writes files** wherever your user account can (`save_project`, `load_project`, `export_stl`).
- **What it reads goes to the model.** Scene data, code and screenshots that the assistant reads become part of the
  conversation with the model provider, like anything else you share with it.

Your MCP client asks before tool calls unless you allowed them, and that is the place to keep control.
:::

The connection itself is local:

- The WebSocket listens on `127.0.0.1` only, so other machines can't reach it.
- The server accepts a connection only from a page served from `localhost`, `127.0.0.1` or `[::1]`, on any port.
  Other websites open in your browser can't connect. A different web app that you run on localhost could, so don't
  leave the server running next to local pages you don't trust.
- The app connects only when it runs on one of those addresses and you turned the bridge on with `?mcp`. A copy on
  the internet, such as the GitHub Pages site, never tries.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The tools say *No 3Dica tab is connected* | No tab has the bridge turned on, or it uses another port | Open `http://localhost:5173/?mcp` (with `&mcpPort=` and the port, if you changed it). The status bar must show **MCP · connected**. |
| The pill stays on **MCP · connecting…** | The server isn't running, or it listens on another port | In Claude Code, type `/mcp` and check that `3dica` is connected. Check that `--port` and `?mcpPort` match. |
| Every tool says *port 6173 is already in use* | Another MCP server for 3Dica runs already, for example in a second Claude Code session | Close the other one, or start this one with `--port` and open the tab with `?mcpPort=`. |
| The pill says **MCP · superseded** | Another tab, or a headless one, connected later | Close the other tab, or choose **Use this tab** in the pill's menu. |
| The browser console shows *WebSocket connection to 'ws://127.0.0.1:6173/' failed* again and again (up to every 10 s) | The bridge is turned on in this browser but no server is running | Start your MCP client, or choose **Disconnect and disable** in the pill's menu (or open `?mcp=0`). |
| Claude Desktop says the server failed to start | It can't find `node` | Put the full path of `node` in `command`. |
| `--headless` fails with *Executable doesn't exist* | Playwright's Chromium isn't installed | Run `npx playwright install chromium` once. |
| A file landed in an unexpected folder | Relative paths are relative to the server's working directory | Use an absolute path. |
| *Unknown method … reload the tab* | The tab runs an older version of the app than the server | Reload the tab. |
| A tool says *The 3Dica tab did not answer … within … s* | A very long evaluation, or the tab is frozen | Look at the tab. Runaway code stops after the evaluation timeout (20 s by default), then try again. |

For problems with the models themselves, such as red dots or nothing rendering, see [Troubleshooting](/help/troubleshooting).
How the bridge is built is described in [Architecture](/dev/architecture), and the code API in [Code API](/reference/code-api).
