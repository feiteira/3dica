# Files, autosave and STL

3Dica keeps your work in three ways: an **autosave** in the browser, project files you **save** and **open**
(`.3dica.json`), and **STL** exports for slicers and other CAD tools. It also **imports** OpenSCAD `.scad` files into
the open project. Everything happens in your browser. Nothing is
uploaded anywhere, unless you use the [AI chat](/guide/ai-chat): it sends what the assistant reads to the AI
provider you chose.

## Autosave

The project is saved automatically:

- **1 second after each change**, and
- right away when you close or reload the tab, or switch to another tab. A code edit that is still waiting for its
  0.4 s typing pause is committed first, so text you typed just before a reload is kept.

The status bar shows the time of the last save, as in **saved 12:01:33**.

What is saved is the whole project (every definition and the scene), plus whether its code is
[paused](#the-run-it-prompt-and-paused-mode). Your view settings are saved separately: which tree rows are expanded,
the gizmo mode and space, snap, ghost and the camera. The undo history and the clipboard are not saved: after a reload
you start with an empty history.

### Where it is stored

Autosave uses the browser's `localStorage` for the address you opened 3Dica from:

| Key | Holds |
|---|---|
| `3dica:v1:current` | The current project, as `{ savedAt, project, paused? }` |
| `3dica:v1:backup:0` … `3dica:v1:backup:4` | The backup ring (see below) |
| `3dica:v1:backup-meta` | Which ring slot is next, and when the last backup was made |
| `3dica:v1:ui` | View settings: expanded rows, gizmo mode and space, snap, ghost, camera |
| `3dica:v1:evaluating` | Present only while a slow evaluation runs: crash detection (see [below](#after-a-crash)) |
| `3dica:v1:mcp` | Present only if you turned on the [MCP bridge](/guide/mcp) in a local copy |
| `3dica:v1:right-tab` | Which tab of the right column was open: Inspector or Chat |
| `3dica:v1:ai` | The [AI chat](/guide/ai-chat) settings: provider, model and base URL per provider, effort, images, step limit, and whether to remember keys. Never a key. |
| `3dica:v1:ai-keys` | API keys for the AI chat, one per provider, only while **Remember the key in this browser** is on |

With **Remember** off, the chat keeps `3dica:v1:ai-keys` in the browser's `sessionStorage` instead, which lasts until
the tab is closed. The autosave, project files and STL exports never contain a key or the conversation, and the
conversation is not saved anywhere. See [Privacy and your key](/guide/ai-chat#privacy-and-your-key).

Storage belongs to an *origin* (scheme, host and port). The published app at `https://feiteira.github.io/3dica/` and a
copy you run with `npm run dev` on `http://localhost:5173` therefore have separate autosaves, chat settings and keys.
Clearing the site's data in the browser deletes all of them, including the autosave backups.

### Backups

Next to the current version, 3Dica keeps a ring of **5 backups**. Each time it saves, it checks when the last backup was
made. If that was more than 60 seconds ago, it first copies the previous version into the next slot of the ring,
replacing the oldest backup. So the ring holds up to five older versions, at least a minute apart.

Only versions that load correctly are copied into the ring, so a broken state never pushes out the good backups. When
storage is full, backups are dropped, oldest first, to make room for the current version.

### What loads at startup

1. With `?fresh` in the address (`https://feiteira.github.io/3dica/?fresh`), the sample project. The autosave is
   ignored but not deleted.
2. Otherwise the current autosave, if it loads.
3. Otherwise the newest backup that loads, with the message *Restored an autosave backup from …*.
4. Otherwise the sample project.

::: warning `?fresh` does not protect your autosave
`?fresh` only skips the autosave while loading. The first change you make is saved over the current slot, as usual.
If the last backup is more than a minute old, the version you had is copied into the backup ring first. To be sure,
**Save** your project before you experiment.
:::

### Getting an older backup back

3Dica restores backups by itself only when the current autosave cannot be loaded. To get an older version back by
hand, open the browser's developer console (<kbd>F12</kbd>) on the 3Dica tab. This lists the backups:

```js
for (let n = 0; n < 5; n++) {
  const r = localStorage.getItem('3dica:v1:backup:' + n)
  if (r) console.log(n, JSON.parse(r).savedAt, JSON.parse(r).project.name)
}
```

and this downloads one of them (here slot 3) as a project file:

```js
const rec = JSON.parse(localStorage.getItem('3dica:v1:backup:3'))
const a = document.createElement('a')
a.href = URL.createObjectURL(new Blob([JSON.stringify(rec.project, null, 2)], { type: 'application/json' }))
a.download = 'backup-3.3dica.json'
a.click()
```

Then **Open** the downloaded file. Save your current project first if you want to keep it as well.

### Autosave unavailable

If the browser refuses to store anything (site data blocked, some private windows, or storage full even after the
backups are dropped), 3Dica shows **Autosave unavailable** once and carries on. Everything else works. Use
<kbd>Ctrl</kbd>+<kbd>S</kbd> to keep your work.

### Several tabs

All 3Dica tabs of the same address share **one** autosave slot, and the last tab to save wins. When 3Dica notices
another tab, both tabs show:

> 3Dica is also open in another tab. Both tabs autosave to the same slot and the last one to save wins — close one of
> them, or Save to keep a copy.

Close one of the tabs, or save one project to a file before you continue in the other.

### After a crash

A Web Worker that runs out of memory can take the whole tab down. While an evaluation has been running for half a
second or more, 3Dica notes its name in `3dica:v1:evaluating`. If the tab dies with that note in place, the next start
restores the project with its code **paused** and says which object was running:

> 3Dica stopped while evaluating 'Plate' last time (out of memory?). Its code is paused — fix it, then click Run code.

Select that object, fix its code (for example lower its `segments`), then click **Run code**.

## Save and Open

| Action | How |
|---|---|
| Save | <kbd>Ctrl</kbd>+<kbd>S</kbd> (works in text fields and in the code editor too), or **Save** in the toolbar |
| Open | <kbd>Ctrl</kbd>+<kbd>O</kbd>, **Open** in the toolbar, or drop a file anywhere on the window |
| Import `.scad` files | **Import** in the toolbar, or drop them anywhere on the window |

**Save** downloads `<project name>.3dica.json` to your browser's download folder. Characters that file systems reject
(`\ / : * ? " < > |`) are replaced with `_`. The file includes the current camera, so opening it later shows the same
view. A pending code edit is committed before saving.

The project name is shown at the top of the Scene panel. New projects are called **Untitled** and the sample is
**Bracket kit**. v0.1 has no field to rename a project: change `"name"` in the saved file and open it again.

**Open** picks a `.json` or `.3dica.json` file. 3Dica checks the whole file first:

- If anything is wrong, a dialog titled *Can't open &lt;file&gt;* lists every problem it found, followed by *The current
  project was not changed.*
- If the file is fine, it **replaces** the current project. There is no "are you sure" step, except for the code prompt
  below, so save first if you want to keep what you have. The undo history starts again, and the camera from the file
  is restored.

Dropping a file on the window does the same as Open. While you drag a file over 3Dica, the window shows *Drop a
.3dica.json file to open it, or .scad files to import them*. If any of the dropped files is a `.scad` file, they all go
to [Import](#import-openscad-files) instead. Otherwise only the first file of a multi-file drop is used. A file dropped
on the code editor is opened or imported the same way; its text is never pasted into the code. Dragging rows inside the
Scene tree is not affected.

## Import OpenSCAD files

**Import** in the toolbar picks one or more `.scad` files and **adds** them to the open project as
[OpenSCAD objects](/guide/openscad), in the current group. It never replaces the project. Files that another chosen
file uses or includes are attached to that object instead of becoming objects of their own. The whole import is one
undo step, labelled `Import bracket.scad`, or `Import 3 files`. Import doesn't ask *Run it?*, because OpenSCAD code is
interpreted and never runs as JavaScript.

To get the code back out, select the object and click **Export .scad** in the Inspector's **Files** section. It
downloads `<name>.scad`, and each attached file has its own Download button. See
[What Import does](/guide/openscad#what-import-does) for the details.

## The "Run it?" prompt and paused mode

![The prompt shown when you open a file that contains code](/shots/dialog-run-code.png)

Code in a 3Dica project is JavaScript that runs on your computer. It runs in a Web Worker, but **there is no
sandbox**: it can do what any script on a web page can do from a worker, such as make network requests or use up your
CPU and memory. So when you open a file that contains any code object (and every primitive is one), 3Dica asks:

> This file contains code that runs on your computer. Run it?

| Choice | Result |
|---|---|
| **Run code** | The project opens and evaluates normally. |
| **Open without running** (or <kbd>Esc</kbd>) | The project opens **paused**. |

While a project is paused:

- nothing is evaluated, so the 3D view stays empty, although the Scene tree, the Library and the inspector work;
- you can read and edit every object's code and parameters;
- the status bar says **Paused — code not run**, the inspector says *Code is paused — click Run code to evaluate this
  project*, and a **Run code** button appears in the toolbar;
- STL export is refused with *Code is not running — click Run code first*;
- the paused state is saved with the autosave, so a reload or a reopened tab is still paused.

Read the code, then click **Run code** (or press <kbd>Ctrl</kbd>+<kbd>Enter</kbd>) when you trust it.

OpenSCAD objects count as code here too, so a project with only OpenSCAD objects also asks, and opens paused if you
choose so. Their code can only make shapes, but the file can also hold JavaScript objects you haven't seen yet.

## New and Sample

| Button | Asks | Then |
|---|---|---|
| **New** | *Replace the current project with an empty one? Save it first if you want to keep it.* | An empty project named **Untitled** |
| **Sample** | *Replace the current project with the sample 'Bracket kit'? Save it first if you want to keep it.* | The sample project |

Both clear the undo history, and the result is autosaved over the current slot a second later (with a backup of the
old version if the last one is more than a minute old). Save first if the current project matters.

The [AI chat](/guide/ai-chat) can do the same, but only after you click **Approve** in the chat. It can also download
the project file and STL exports, named as above, but it can't open files.

## Export STL

**STL** in the toolbar exports what is selected, or the whole scene:

| Selection | What is exported |
|---|---|
| An object in the scene (3D view or Scene tree) | That object, at its position in the scene. A group exports its visible contents, a boolean group its result. |
| Nothing, or a definition in the Library | Every visible top-level object of the scene |

- **File name:** `<project>-<selection>.stl`, where the selection is the instance's label or its definition's name, or
  `<project>-scene.stl` for the whole scene. Example: `Bracket kit-Fixture A.stl`.
- **Format:** binary STL, one file. Each solid is written as it is: overlapping solids are **not** merged into one, and
  most slicers merge them on import. Colors are not exported.
- **Units:** millimetres, Z up. STL files carry no unit, and slicers assume millimetres.
- **Hidden objects** are left out, also inside groups.
- **Objects whose evaluation failed** (an error or a timeout) are skipped instead of being run again, and a warning
  names them: *Skipped because of errors: Bolt*. If that leaves nothing, the message is *Nothing to export ('Bolt' has
  errors)*.
- When the export is done, a message gives the file name and size, as in *Exported Bracket kit-scene.stl · 61,234
  triangles*.

The export runs in the evaluation worker and has a 60 s limit (*STL export timed out after 60 s*). It is refused while
code is paused.

## The .3dica.json format

A project file is UTF-8 JSON with 2-space indentation. Keys are always written in the same order and definitions are
sorted by id, so files diff well in version control.

This is a complete, valid file with one definition placed twice:

```json
{
  "format": "3dica",
  "version": 1,
  "app": "3dica 0.1.0",
  "name": "Two cubes",
  "savedAt": "2026-11-12T10:00:00.000Z",
  "root": "d_root",
  "defs": {
    "d_cube": {
      "id": "d_cube",
      "name": "Cube",
      "kind": "code",
      "color": "#4f8fd8",
      "params": [
        { "name": "size", "type": "number", "default": 10, "min": 1, "max": 100, "step": 1 },
        { "name": "rounded", "type": "boolean", "default": false }
      ],
      "code": "const { size, rounded } = params\nconst mid = [0, 0, size / 2]\nif (rounded) return roundedCuboid({ size: [size, size, size], roundRadius: size / 10, center: mid })\nreturn cuboid({ size: [size, size, size], center: mid })\n"
    },
    "d_root": {
      "id": "d_root",
      "name": "Scene",
      "kind": "group",
      "op": "none",
      "children": [
        { "id": "i_a", "def": "d_cube", "xf": { "t": [0, 0, 0], "r": [0, 0, 0], "s": [1, 1, 1] } },
        { "id": "i_b", "def": "d_cube", "name": "Big cube", "xf": { "t": [30, 0, 0], "r": [0, 0, 45], "s": [1, 1, 1] },
          "color": "#e05252", "params": { "size": 20, "rounded": true } }
      ]
    }
  }
}
```

Reading it:

- `defs` holds every **definition**, keyed by id. `d_cube` is a Code definition with two parameters; `d_root` is the
  scene itself.
- The scene's `children` are the **instances** placed at the top level. `i_a` uses the Cube's defaults; `i_b` is
  labelled *Big cube*, moved 30 mm along X, turned 45° about Z, colored red and overrides both parameters.
- Because both instances point at `d_cube`, they are linked copies: editing the Cube's code changes both.

### Top level

| Field | Required | Value |
|---|---|---|
| `format` | yes | Always `"3dica"` |
| `version` | yes | The file format version: `1` |
| `app` | no | The app that wrote the file, for information. Ignored on load. |
| `name` | yes | The project name |
| `savedAt` | no | When it was saved (ISO 8601), for information. Ignored on load. |
| `root` | yes | The id of the root group (the scene) |
| `camera` | no | `{ "position": [x, y, z], "target": [x, y, z] }`, restored on open |
| `defs` | yes | Every definition, as an object keyed by definition id |

### Definitions

| Field | Applies to | Value |
|---|---|---|
| `id` | all | Equal to its key in `defs`. `d_` followed by 1 to 32 lowercase letters or digits. |
| `name` | all | Unique, case-sensitive, 1 to 64 characters, no leading or trailing space, no quotes, backticks, backslashes or line breaks. `Scene` is reserved for the root. `part()` calls use this name. |
| `kind` | all | `"code"` or `"group"` |
| `color` | all, optional | `"#rrggbb"`. Used when no instance color is set. |
| `lang` | code, optional | `"openscad"` for an [OpenSCAD object](/guide/openscad). Left out for JavaScript (JSCAD) code. |
| `params` | code | The parameter list: see below. For an OpenSCAD object it is read again from the code when the file is opened, whatever the file says. |
| `code` | code | The code, as one string with `\n` line breaks |
| `files` | OpenSCAD code, optional | The [attached files](/guide/openscad#attached-files): an object of relative path → text, sorted by path, such as `{ "lib/holes.scad": "module screw_hole(…) …" }`. At most 200 files, 2 MB each and 16 MB in all. |
| `op` | group | `"none"` (assembly), `"union"`, `"subtract"` (the first visible child minus the others) or `"intersect"` |
| `children` | group | The instances inside the group, in order |

A parameter is `{ "name", "type", "default" }` plus, optionally, `"min"`, `"max"` and `"step"` (numbers) and
`"options"` (a list of strings, required for a choice). See [Parameters](/reference/parameters) for the rules.

### Instances

| Field | Required | Value |
|---|---|---|
| `id` | yes | `i_` followed by 1 to 32 lowercase letters or digits. Unique in the whole project. |
| `def` | yes | The id of the definition it places |
| `name` | no | A label shown in the tree instead of the definition's name |
| `xf` | yes | The transform: `t` translation in mm, `r` rotation in degrees, `s` scale factors. Each is three finite numbers. A scale can be negative (a mirror) but not 0. |
| `color` | no | `"#rrggbb"`, overriding the definition's color |
| `params` | no | Parameter overrides: `{ "name": value }`, with numbers, `true`/`false` or strings |
| `hidden` | no | `true` when hidden. Left out otherwise. |

The transform means `translate(t) rotate(r) scale(s)` exactly as in OpenSCAD: scale first, then rotate about X, then Y,
then Z, then translate. See [Transforms and the gizmo](/reference/transforms).

### Rules checked on open

Besides the field formats above, 3Dica checks that:

- the root exists, is a group with op `none`, is named `Scene`, and is never placed as an instance;
- every instance's `def` exists, and no instance id is used twice;
- definition names are unique;
- no group contains itself, directly or through other groups.

`part()` calls are not checked on open. A call to a missing definition, or a cycle made of `part()` calls, loads fine
and shows up as an error on the object, so a file is never refused because of what its code says. Unknown fields are
dropped on load.

Some problems a file can have, as the Open dialog words them:

- `Not valid JSON: …`
- `Not a 3Dica project (format is "x", expected "3dica")`
- `This file was made by a newer 3Dica (file version 2, this app reads version 1)`
- `Instance "i_a" in 'Scene' refers to a missing definition "d_gone"`
- `Instance "i_a" in 'Scene': scale can't be 0`
- `Definition 'Bad "name"': the name can't contain quotes, backticks, backslashes or line breaks`
- `Definition 'Widget': parameter 'my size': name must be a valid identifier`
- `Definition 'bracket': lang "python" must be "openscad" (or absent for JSCAD code)`
- `Definition 'bracket': files are only for OpenSCAD code (lang "openscad")`
- `Definition 'bracket': files: '../x.scad' points outside the object's files ('..' climbs above the root)`

### Versions

Version `1` is the only format so far. OpenSCAD objects added the optional `lang` and `files` fields without a new
version: an older 3Dica that doesn't know them drops them and opens the object as JavaScript code, which then fails. A file with a higher version is refused with the message above, so an older
3Dica never half-reads a newer file. The loader runs every file through a table of upgrade steps, one per version,
before it checks it, so that a future format can still open the files you save today.
