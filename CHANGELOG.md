# Changelog

All notable changes to 3Dica are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-11-12

The first public release.

### Added

- **Workbench.** Scene tree and Library on the left, a three.js 3D view in the middle, and the inspector with a
  CodeMirror code editor on the right. Dark theme, Z up, millimetres.
- **Code objects.** An object's code is a JSCAD (`@jscad/modeling` 2.13) function body that returns a 3D shape or an
  array of them. The functions of the main modeling namespaces are in scope by their plain names, `jscad` holds the
  whole library, and `Math.random` is seeded so a re-run gives the same shape.
- **Templates.** Cube, Sphere, Cylinder, Torus, a blank Code object and an empty Group, added to the group you are in.
- **Parameters.** A parameter table per definition (number, boolean or choice, with default and min/max/step), and
  per-instance overrides marked with ● and reset with ↺.
- **Linked instances.** Ctrl+D adds a linked copy, Ctrl+Shift+D a unique one. Copy and paste (Ctrl+C, Ctrl+V,
  Ctrl+Shift+V). **Make unique** (U) breaks a link one level deep. `◆N` badges, a purple tint on linked copies, a
  "Definition shared by N copies" banner and "N copies updated" toasts show what an edit affects.
- **Groups.** Assemblies plus `union`, `subtract` and `intersect` groups. Wrap the selection (Ctrl+G or the ∪ − ∩
  toolbar buttons) and ungroup (Ctrl+Shift+G) without moving anything. A selected boolean shows its operands, with
  subtract cutters in translucent red.
- **`part('Name', overrides)`.** Code can reuse another definition's geometry. Renaming a definition rewrites the
  `part()` calls, deleting one is refused while code still uses it, and cycles are reported by name.
- **Selection and navigation.** Click selects the outermost object at the current level, Ctrl+click the deepest part,
  double-click in the view or Enter enters a group, Esc steps back out. A breadcrumb shows where you are. Everything outside the
  selection is ghosted (G toggles it), and ghosts stay clickable.
- **Isolate** (I). Shows the selected definition alone at the origin, with a banner naming its parameter values.
- **Gizmo.** Move, rotate and scale (W, E, R) in world or local space (Q), with snapping to 1 mm, 15° and 0.1 (X; hold
  Ctrl while dragging to suspend it). Linked copies move live while you drag, and one drag is one undo step. Rotation
  order matches OpenSCAD's `rotate([x, y, z])`.
- **Camera.** Frame the selection (F) or everything (Home), front, right and top views (1, 3, 7), and smart framing on
  tree clicks.
- **Tree drag and drop.** Reorder and reparent rows with the world position kept, hold Ctrl to drop a linked copy, and
  drag Library rows into the tree to add instances.
- **Hide** (H) and **Unhide all** (Alt+H), **Rename** (F2) and **Delete** (Del), with a confirmation before a definition
  and all its instances are removed. **Purge** removes unused definitions.
- **Undo and redo** for every project edit (Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y), up to 200 steps.
- **Evaluation in a Web Worker.** Results are cached by content hash, so linked copies share one mesh, and the selected
  object is evaluated first. The last good mesh stays on screen while you type. Errors show in the editor gutter with
  the line number, in the status line and as a red dot in the tree.
- **Runaway protection.** Code that runs longer than 20 s is stopped (`?evalTimeout=<ms>` changes this), and code you
  have already typed over is stopped after about 1 s. Primitives whose segment counts would exceed 2,000,000
  triangles, and code that creates more than 2,000,000 polygons in one evaluation, fail at once with "Too much
  geometry". The worker's memo and the view's mesh cache are bounded by size as well as by count.
- **Files.** Save and open `.3dica.json` projects (Ctrl+S, Ctrl+O, or drop a file on the window). Opening a file that
  contains code asks before running it, and **Open without running** is remembered across reloads until you click
  **Run code**. New and Sample ("Bracket kit") start over after a confirmation.
- **Autosave.** The project is saved to `localStorage` 1 s after each change and when you leave the page, with a ring
  of 5 backups. A tab that dies while evaluating comes back with its code paused, and 3Dica warns when it is open in
  another tab.
- **STL export.** Binary STL of the selection or of the whole scene. Objects whose evaluation failed are skipped and
  named.
- **Manual.** A VitePress manual with guides, three tutorials, a reference and developer notes, published at
  <https://feiteira.github.io/3dica/manual/> and linked from the toolbar.
- **MCP server.** `mcp/server.mjs` lets an AI assistant drive a 3Dica that runs on your machine and take screenshots,
  over a bridge that listens on localhost only.
- **Tests.** Vitest unit tests for the pure core, the engine (with real JSCAD), the store and the client, and Playwright
  end-to-end tests against the dev server and the production build. CI and GitHub Pages deployment through GitHub
  Actions.

[Unreleased]: https://github.com/feiteira/3dica/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/feiteira/3dica/releases/tag/v0.1.0
