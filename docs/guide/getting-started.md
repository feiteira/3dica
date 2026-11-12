# Getting started

This page gets you from zero to finding your way around: opening the app, the parts of the screen, moving the camera,
selecting things, and what is in the sample project.

## Open the app

Go to **[feiteira.github.io/3dica](https://feiteira.github.io/3dica/)** in a recent desktop browser with WebGL 2.
There's nothing to install and no account to create. On your first visit 3Dica opens the sample project **Bracket kit**.

### Or run it locally

You need [Node.js](https://nodejs.org/) 20.19 or newer and git.

```sh
git clone https://github.com/feiteira/3dica.git
cd 3dica
npm ci
npm run dev
```

Then open `http://localhost:5173` in your browser. Running locally is also what you need to connect an AI
assistant: see [AI assistants (MCP)](/guide/mcp). For a production build, run `npm run build` and then
`npm run preview` (it serves on port 4173).

::: tip Start from the sample again
Add `?fresh` to the address (for example `http://localhost:5173/?fresh`) to open the sample and ignore the autosaved
project. Careful: your first change then autosaves over the previous project. Use **Save** first if you want to keep it.
:::

## A tour of the interface

![The 3Dica window: toolbar at the top, Scene tree and Library on the left, the 3D view in the middle, the inspector and code editor on the right, the status bar at the bottom](/shots/overview.png)

| Area | Where | What it's for |
|---|---|---|
| **Toolbar** | top | Add objects, wrap them in booleans, gizmo modes, view helpers, undo and redo, files. |
| **Scene** tree | left, top | Every placed object (instance), nested by group. Shows the `◆N` linked-copy badges, a status dot and an eye to hide each row. |
| **Library** | left, bottom | Every definition in the project, with how often it occurs (`×8`), or `unused`, or `part()` when only code uses it. |
| **3D view** | center | The scene, a gizmo on the selection, a breadcrumb at the top left, and hints at the bottom left. |
| **Inspector** | right, top | The selection's label, transform, color and parameters, and below them its definition: name, color, parameter defaults or the group's operation. |
| **Code editor** | right, bottom | The code of the selected code object. Edits run 0.4 s after you stop typing. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> runs them right away. |
| **Status bar** | bottom | Evaluator state and the last evaluation time, the mesh and triangle count, and the time of the last autosave. |

### The toolbar

![The toolbar](/shots/toolbar.png)

From left to right. Hover a button to see its name and shortcut. In a window narrower than 1440 px most buttons show
only their icon.

| Buttons | What they do |
|---|---|
| **Cube · Sphere · Cyl · Torus** | Add a primitive to the current group. Each one is a new code object with its own definition and parameters. |
| **Code** | Add a blank code object (a small rounded cube to start from). |
| **Group** | Add an empty group (an assembly). |
| **∪ − ∩** | Wrap the selected object in a new Union, Subtract or Intersect group. Subtract keeps the first child and cuts away the others. |
| **Move · Rotate · Scale** | Gizmo mode (<kbd>W</kbd> <kbd>E</kbd> <kbd>R</kbd>). |
| **World / Local** | Gizmo axes aligned to the world or to the object (<kbd>Q</kbd>). |
| **Snap** | Snap gizmo drags to 1 mm, 15° and 0.1× steps (<kbd>X</kbd>). It's on by default. Hold <kbd>Ctrl</kbd> while dragging to suspend it. |
| **Ghost** | Fade everything outside the selection (<kbd>G</kbd>). It's on by default. |
| **Isolate** | Show the selected definition on its own at the origin (<kbd>I</kbd>). |
| **Frame** | Frame the selection (<kbd>F</kbd>), or everything with <kbd>Home</kbd>. |
| **Undo · Redo** | <kbd>Ctrl</kbd>+<kbd>Z</kbd> and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> (or <kbd>Ctrl</kbd>+<kbd>Y</kbd>). The tooltip names the step, for example "Undo Move Bolt". |
| **New · Sample · Open · Save · STL** | Start an empty project, load the sample, open or save a `.3dica.json` file, export STL. |
| **Run code** | Only appears while the project's code is paused, for example after you opened a file with **Open without running**. |
| **Manual** | Opens this manual in a new tab. It's the book icon at the far right. |

## Moving around the 3D view

Z points up, as in OpenSCAD. The grid lies in the XY plane: 200 mm across with 10 mm cells. The short red and green
lines at the origin are the X and Y axes.

| Mouse or key | Does |
|---|---|
| Left-drag | Orbit around the view's center. |
| Right-drag, or <kbd>Shift</kbd>+left-drag | Pan. |
| Mouse wheel, or middle-drag | Zoom. |
| <kbd>F</kbd> | Frame the selection (everything when nothing is selected). |
| <kbd>Home</kbd> | Frame everything. |
| <kbd>1</kbd> / <kbd>3</kbd> / <kbd>7</kbd> | Front, right or top view. The numeric keypad works too. |

::: tip Keyboard focus
Shortcuts work when the keyboard focus isn't in a text field or the code editor. Press <kbd>Esc</kbd> to leave a field
or the editor. In the inspector, <kbd>Enter</kbd> commits a value and hands the keyboard back to the view. Only
<kbd>Ctrl</kbd>+<kbd>S</kbd> (save) and <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (run code) work everywhere.
:::

## Selecting things

| Do this | To |
|---|---|
| Click an object in the view | Select the top-level object under the pointer, for example the whole "Fixture A". |
| Double-click an object in the view | Enter that group and select the part under the pointer. |
| <kbd>Ctrl</kbd>+click in the view | Select the deepest part under the pointer directly. |
| Click a row in the Scene tree | Select exactly that object, at any depth. |
| Click a row in the Library | Select the definition and show it on its own (isolate). |
| Click empty space in the view | Clear the selection. If you are inside a group, you stay inside it. |
| <kbd>Esc</kbd> | Step back: leave isolate first, then leave the group (selecting it), then clear the selection. |
| <kbd>F2</kbd>, or double-click a row's name | Rename. |

The selection is drawn in blue with an outline. **Other copies of the same definition get a purple tint**, in the view
and in the tree, so you can always see what an edit will affect. With Ghost on, everything else is faded. The
breadcrumb at the top left shows where the selection sits, for example `Scene › Fixture A ◆2 › Bolt ◆8`. You can
click a segment to go back up.

![A bolt selected in the tree: the other seven bolts are tinted purple, everything else is faded](/shots/select-linked.png)

Press <kbd>I</kbd> to **isolate** the selection: its definition alone, at the origin, with that copy's parameters.
A banner at the top names what you are looking at. Press <kbd>I</kbd> or <kbd>Esc</kbd> to go back.

![The Plate isolated: the definition alone at the origin, with the banner at the top](/shots/isolate.png)

## The sample project: Bracket kit

The sample is small, but it uses every idea in 3Dica:

| Definition | Kind | What it shows |
|---|---|---|
| **Bolt** | code: `length` 12, `diameter` 5 | A hex-head bolt. The hex head is a 6-segment cylinder, and the thread look is a twisted extrusion, with no booleans. |
| **Plate** | code: `width` 60, `depth` 40, `thickness` 4, `holeDiameter` 5.5, `inset` 7 | A slab with rounded edges. Its four holes are cut **in code** with `subtract()`. |
| **Disc**, **Hole** | code | The two pieces of the washer. |
| **Washer** | group, operation **subtract** | Disc minus Hole: a boolean made **in the tree**, without code. |
| **Fixture** | group, operation **none** (an assembly) | One Plate, four Washers and four Bolts. |
| **Bolt sizes** | code that calls `part('Bolt', { length })` | Five bolts, 8 to 24 mm long, built from the Bolt definition. |

The scene places three things: **Fixture A** at the origin, **Fixture B**, a linked copy of the same Fixture moved
75 mm along X and turned 15° about Z, and **Bolt sizes**.

A few things to try:

- Click a **Bolt** row under Fixture A in the tree. The other seven bolts turn purple: they're all occurrences of one
  definition. The Library says `Bolt ×8`. The five bolts of "Bolt sizes" aren't counted, because they come from code,
  not from instances.
- Click the **Washer** row under Fixture A. It's a Subtract group: the Disc is the base and the Hole, the cutter, shows
  in translucent red.
- Click **Plate** in the Library. The view isolates the definition, and the inspector shows its parameter defaults
  and its code. Press <kbd>Esc</kbd> to go back to the scene.

[Tutorial 2: Linked copies](/tutorials/linked-copies) builds on this sample.

## Autosave and files

3Dica saves the project in your browser's local storage 1 second after every change, and when you leave or reload the
page. The status bar shows the time of the last save (`saved 12:01:33`), and 3Dica keeps 5 older backups. When you come
back, it reopens your project. If that copy can't be read, it falls back to the newest backup that can, and then to
the sample.

That storage belongs to this browser on this computer. To keep a project, share it or move it, use **Save**
(<kbd>Ctrl</kbd>+<kbd>S</kbd>). It downloads a `.3dica.json` file that **Open** (<kbd>Ctrl</kbd>+<kbd>O</kbd>, or
drop the file on the window) reads back.

::: warning One tab at a time
All tabs share one autosave slot, and the last tab to save wins. 3Dica warns you when it is open in another tab.
:::

[Files, autosave and STL](/reference/files) has the details, including what happens when you open a file that
contains code.

## Where to go next

- [Tutorial 1: Your first part](/tutorials/first-part): a plate with a hole, built in the tree.
- [Tutorial 2: Linked copies](/tutorials/linked-copies): duplicate, edit once, make unique.
- [Tutorial 3: Code objects and part()](/tutorials/code-and-parts): write JSCAD code and reuse it.
- [Coming from OpenSCAD](/guide/coming-from-openscad): your OpenSCAD habits, mapped to 3Dica.
- [Keyboard shortcuts](/reference/shortcuts): every key on one page.
