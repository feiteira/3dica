# FAQ and limitations

## Questions

### Is 3Dica free?

Yes. 3Dica is open source under the [MIT License](https://github.com/feiteira/3dica/blob/main/LICENSE), copyright
The 3Dica authors. You can use the app, the code and the models you make with it for anything, including commercial
work.

### Do I need to install anything?

No. Open [feiteira.github.io/3dica](https://feiteira.github.io/3dica/) in a desktop browser. A local copy is only
needed if you want to change 3Dica itself or connect an AI assistant: see [Contributing](/dev/contributing) and
[AI assistants (MCP)](/guide/mcp).

### Is my model uploaded anywhere?

No. 3Dica is a static web page. Your project is evaluated in your browser, autosaved in the browser's local storage, and
saved or exported as files that your browser downloads. Nothing is sent to a server. See
[Files, autosave and STL](/reference/files).

### Which browsers work?

Desktop browsers with WebGL and module Web Workers. 3Dica is developed and tested with Chromium, so a Chromium-based
browser such as Chrome or Edge is the safest choice. The layout needs a window at least 1,100 pixels wide and is made
for a mouse and keyboard, so phones and tablets are not supported.

### How is it different from OpenSCAD?

The modeling idea is the same: code makes solids, booleans combine them, and parameters make them reusable. The
differences are the language (JavaScript with [JSCAD](https://github.com/jscad/OpenJSCAD.org) instead of the OpenSCAD
language) and the workbench around it: each object has its own code, objects sit in a scene tree, copies stay linked to
their definition, and you can select, isolate and move things with the mouse. See
[Coming from OpenSCAD](/guide/coming-from-openscad).

### Can I open my .scad files?

Not directly. There is no OpenSCAD import. Most OpenSCAD code ports to JSCAD line by line, and
[Coming from OpenSCAD](/guide/coming-from-openscad) has a translation table.

### Can I import STL, STEP, SVG or DXF files?

No. Every shape in 3Dica is made by code. Imported meshes and drawings are not supported in v0.1.

### What can I export?

Binary **STL** (for slicers and most CAD tools) and the **`.3dica.json`** project file. STL export writes the selected
object, or the whole scene, in millimetres, without colors and without merging overlapping solids.

### What units does 3Dica use?

Millimetres, with Z up, like OpenSCAD and most slicers. Rotation in the inspector is in degrees. Rotation in code is in
radians, because that is what JSCAD's functions take: use `degToRad(45)`.

### Is it safe to open a project someone sent me?

Only if you trust its code. A project's code is JavaScript that runs on your computer, and 3Dica has **no sandbox**:
the code runs in a Web Worker, which keeps it from freezing the page but not from doing what scripts can do, such as
making network requests. That is why opening a file with code asks *Run it?*. Choose **Open without running**, read the
code of each object, then click **Run code**. See [the Run it? prompt](/reference/files#the-run-it-prompt-and-paused-mode).

### Can I use npm packages or share helper functions between objects?

Not in v0.1. Code cannot `import` or `require` anything, and definitions cannot share functions. What they can share
is **geometry**: one object can use another's shape with `part('Name', overrides)`. Write small helpers inside the
object that needs them.

### How do I make an array or a pattern?

Two ways:

- **In the tree:** select an object and press <kbd>Ctrl</kbd>+<kbd>D</kbd> for each linked copy. Each copy can be moved,
  overridden and selected on its own. Good for a handful of copies.
- **In code:** build the item as its own definition and place copies with `part()` in a loop. Good for many copies and
  for regular patterns. See the examples in the [Code API](/reference/code-api).

### Can groups have parameters?

No. Parameters belong to Code objects. To make a parametric assembly, write a Code object that builds the assembly
with `part()` and passes its parameters on. See [Parameters](/reference/parameters).

### Can I select several objects at once?

No. v0.1 has single selection only. To act on several objects together, put them in a group (<kbd>Ctrl</kbd>+<kbd>G</kbd>)
and select the group.

### Why does editing one object change others?

They are linked copies of the same definition, which is 3Dica's default. The `◆N` badge and the purple tint show which
objects share a definition. Use **Make unique** (<kbd>U</kbd>) to give one copy its own definition. See
[The 3Dica model](/concepts/model).

### Where is my work saved, and how do I back it up?

The current project is autosaved in the browser, with a ring of five older versions. That storage is tied to one
browser on one computer, so **Save** (<kbd>Ctrl</kbd>+<kbd>S</kbd>) your project to a `.3dica.json` file to keep it,
move it or share it. Project files are plain JSON written in a stable order, so they work well in git.

### Can I use 3Dica offline?

There is no offline install. If you need it without a network connection, run a local copy (see
[Contributing](/dev/contributing)).

### Can an AI assistant use 3Dica?

Yes, with a local copy. 3Dica includes an MCP server that lets an assistant such as Claude read and edit the open
project and take screenshots of the view. See [AI assistants (MCP)](/guide/mcp).

### Does 3Dica use the GPU for modeling?

No. The GPU only draws the result. The modeling itself is done by JSCAD on the CPU, in a Web Worker, so the page stays
responsive while it works.

### How do I report a bug or ask for a feature?

Open an issue at [github.com/feiteira/3dica/issues](https://github.com/feiteira/3dica/issues). For a bug, list the steps
to reproduce, what you expected and what happened, and attach a small `.3dica.json` if you can.

## Current limitations

These are the known limits of v0.1.

**Modeling**

- **No sketches, constraints or feature history.** 3Dica is mesh-based code-CAD: shapes come from code and booleans,
  not from constrained 2D sketches, fillet tools or a B-rep kernel. There is no STEP export for the same reason.
- **JSCAD speed.** Booleans (`union`, `subtract`, `intersect`), hulls and Minkowski sums get slow on detailed meshes.
  One evaluation runs at a time.
- **2D shapes are not shown.** Code must return 3D geometry. Extrude 2D shapes before returning them.
- **No group parameters,** no parameters that flow from a group into its children, and no expressions in overrides.
- **No shared code.** No `import`, no npm packages, and no helper functions shared between objects.
- **Evaluation limits.** 20 s per evaluation (adjustable with `?evalTimeout`), 2,000,000 triangles per result, and
  2,000,000 polygons created per evaluation. See [Code API](/reference/code-api#limits).
- **Scene limits.** The tree is expanded to at most 32 levels and 5,000 occurrences.

**Safety**

- **No sandbox.** Project code runs in a Web Worker with the same powers as any script on the page. Opening a file with
  code asks before running it, and that is the only protection.

**Interface**

- **Single selection.** No multi-select, box select or multi-object gizmo, and no keyboard navigation in the tree.
- **No measuring tool, section planes or snapping to faces.** The gizmo snaps to 1 mm, 15° and 0.1 steps.
- **Booleans update on release.** While you drag the cutter of a subtract with the gizmo, the result updates when you
  let go.
- **Desktop only.** Tested with Chromium, at least 1,100 pixels wide, mouse and keyboard, dark theme only.
- **No project rename field.** The name comes from the file: edit `"name"` in the `.3dica.json`.

**Files**

- **No import** of STL, OpenSCAD, STEP, SVG, DXF or images.
- **STL only.** No 3MF, OBJ or GLB, and no colors in exports. Overlapping solids are not merged.
- **One autosaved project per browser and address.** There is no project list or cloud sync, and all tabs share one
  autosave slot.
- **The clipboard is internal.** Copy and paste work within one tab, not between tabs or projects, and not through the
  system clipboard.
- **Undo history is not saved.** A reload, New, Sample or Open starts a new history.

## Ideas for later

::: info Ideas, not promises
Nothing below is planned or scheduled. These are directions that fit 3Dica and come up often. If one matters to you,
say so in an [issue](https://github.com/feiteira/3dica/issues).
:::

- A faster geometry kernel (for example [manifold-3d](https://github.com/elalish/manifold)) and several workers
  evaluating in parallel.
- A real sandbox for project code, such as an isolated iframe.
- Export to 3MF and OBJ, with colors.
- Import of STL meshes, and of OpenSCAD code through openscad-wasm.
- Shared helper modules that several objects can import.
- Group parameters and parameters that flow from a group into its children.
- Multi-select, a measuring tool and section planes.
- Dragging definitions from the Library straight into the 3D view, with snapping to faces.
- A light theme, touch support and an installable offline app.
