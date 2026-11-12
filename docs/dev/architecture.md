# Architecture

This page explains how 3Dica is put together: the modules, how data flows from a click to pixels, how evaluation is
cached and run in a worker, and how undo works. Read it before you change anything deep. The code is plain TypeScript
with no UI framework, and `src/app/context.ts` is the contract between the layers: start there.

The original design is in the [v0.1 design spec](https://github.com/feiteira/3dica/blob/main/docs/design/spec-v0.1.md).
Code comments refer to its sections as `§4.5` and so on. It is a historical document: where it and the code disagree,
the code is right, and the spec lists the known deviations at the top.

## Modules

| Directory | Role | Main files |
|---|---|---|
| `src/core/` | **Pure logic.** No DOM, no three.js, no Worker. Shared by the main thread and the worker, and unit-tested in Node. | `types.ts` (the data model), `graph.ts` (expansion, paths, `part()` scan, cycles), `ops.ts` (every project mutation), `evalspec.ts` (specs, keys, wanted jobs, status), `params.ts`, `hash.ts`, `project-io.ts` (file format), `selection.ts`, `transform.ts`, `templates.ts`, `sample.ts`, `colors.ts`, `ids.ts` |
| `src/state/` | Application state | `store.ts` (project + UI state, undo), `history.ts`, `autosave.ts`, `clipboard.ts`, `tabs.ts` (other-tab detection) |
| `src/app/` | Wiring | `context.ts` (the cross-layer interfaces), `commands.ts` (one method per user action), `controller.ts` (the render pass) |
| `src/eval/` | Evaluation | `protocol.ts` (worker messages), `engine.ts` (runs JSCAD; pure, also runs in Node), `worker.ts` (thin worker shell), `client.ts` (queue, worker lifecycle), `mesh-cache.ts`, `edges.ts` (selection outlines) |
| `src/view/` | The 3D view (three.js) | `viewport.ts`, `scene-sync.ts`, `materials.ts`, `picking.ts`, `gizmo.ts` |
| `src/ui/` | Panels and input | `toolbar.ts`, `tree.ts`, `library.ts`, `inspector.ts`, `param-editor.ts`, `code-editor.ts` (CodeMirror 6), `breadcrumb.ts`, `statusbar.ts`, `shortcuts.ts`, `dnd.ts`, `dom.ts` (the `h()` helper, toasts, dialogs), `icons.ts` |
| `src/io/` | Browser file I/O | `files.ts` (download, file picker, window drop) |
| `src/mcp/` | The optional bridge to the local MCP server | `config.ts` (opt-in), `bridge.ts` (WebSocket client), `handlers.ts` (one handler per tool), `screenshot.ts` |
| `mcp/` | The MCP server (Node) | `server.mjs`, `lib/` |
| `src/main.ts` | Boot | Builds everything in order and installs `window.__3dica` |

## Data model

Everything the user makes is one `Project` (`src/core/types.ts`), a plain JSON-serializable object:

- **Definitions** (`defs`, keyed by id). A **Code** definition has `code` and a parameter list. A **Group** definition
  has `children` (instances) and an `op`: `none`, `union`, `subtract` or `intersect`. The scene itself is the root
  group, named `Scene`.
- **Instances** are placements inside a group: which definition, a transform `xf` (`t`, `r` in degrees, `s`), and
  optionally a label, a color, parameter overrides and a hidden flag.
- **Occurrences** are not stored. They are computed by `expand()` in `core/graph.ts`: one per drawn copy, identified by
  the **path** of instance ids from the root. Because a group's children occur once per copy of the group, a selection
  is a path, not an instance id.

Only the project is undoable and saved. The `UiState` (selection, context, view mode, gizmo settings, expanded rows,
paused flag) lives next to it in the store.

## Data flow

```text
  toolbar · tree · library · inspector · shortcuts · 3D view (picking, gizmo)
        │  call
        ▼
  app/commands.ts ──── store.update(label, recipe) ────▶ state/store.ts ──▶ state/autosave.ts
                                                         │ (snapshots + history)
                                                         │ subscribe
                                                         ▼
                              app/controller.ts — one pass per change, on a microtask
                                 buildSpecs · expand · computeWantedJobs · computeDefStates
                                    │                                        ▲
                         client.want(jobs)                          client.onChange
                                    ▼                                        │
                              eval/client.ts ── postMessage ──▶ eval/worker.ts ─▶ eval/engine.ts (JSCAD)
                                 mesh cache ◀── meshes (transferred Float32Arrays) ──┘
                                    │
                                    ▼
                  viewport.reconcile(state) ─▶ scene-sync, materials, gizmo
                  ctx.emit('render', state)  ─▶ every panel re-renders from it
```

1. **Input.** Every user action, from a toolbar button to a gizmo release, calls one method of `Commands`
   (`src/app/commands.ts`). Panels never change the project themselves.
2. **Store.** A command makes one `store.update(label, recipe)` call. The recipe mutates a `structuredClone` draft with
   the functions in `core/ops.ts`. That one update is one undo step.
3. **Controller.** Store subscribers schedule a controller pass on a microtask (several changes coalesce into one pass).
   The pass:
   1. rebuilds the specs (`buildSpecs`) and the occurrence expansion (`expand`) when the project changed;
   2. computes the isolate view, if any;
   3. works out which booleans show their operands;
   4. computes the **wanted jobs** (`computeWantedJobs`);
   5. tells the client, if the wanted set or its priority changed (`client.want`);
   6. computes each definition's status and each tree row's status (`computeDefStates`, `computeRowStatuses`);
   7. calls `viewport.reconcile(state)` and emits `render`.
4. **Evaluation.** The client sends jobs to the worker one at a time. Each result arrives as typed arrays, goes into the
   mesh cache and fires `onChange`, which schedules another pass.
5. **View and panels.** `reconcile` syncs the three.js scene to the new state. The panels listen to `render` and patch
   their DOM.

The controller output is a `RenderState`: the project and UI snapshot plus everything derived from them (occurrences,
specs, wanted jobs, statuses, counts). Treat it as immutable.

## The evaluation pipeline

### Specs and jobs

`buildSpecs(project)` (`core/evalspec.ts`) turns every definition into a self-contained **DefSpec**:

- A `CodeSpec` holds the code, the parameter definitions and, under `deps`, the specs of every definition its code
  names in a `part()` call. The names come from the static scan in `core/graph.ts` (`staticRefs`, which ignores
  comments).
- A `GroupSpec` holds the op and its **visible** children, each with its spec, resolved parameters and transform
  matrix.

A spec never points back into the project, so a job can be sent to a freshly started worker that knows nothing else.
Specs that cannot be built (a missing `part()` name, a cycle) become entries in `specErrors` and get no job.

A **Job** is `{ resultKey, spec, params }` with the parameters already resolved (defaults merged with overrides).

### Cache keys

```text
CodeSpec  defKey = hash(['code', ENGINE, code, params.map(p => [name, type, default (, options for a choice)]),
                         sortedDeps.map(([name, spec]) => [name, spec.defKey])])
GroupSpec defKey = hash(['group', ENGINE, op, visibleChildren.map(c => [c.spec.defKey, c.params, c.matrix])])
resultKey        = hash([defKey, resolvedParams])
```

- `hash` is two 53-bit cyrb53 hashes of a stable stringification: sorted object keys, `-0` written as `0`, and
  4×4 matrices rounded to 1e-9 (`core/hash.ts`).
- `ENGINE` (`'jscad-2.13.0/e1'`) is part of every key. Bump it when a JSCAD upgrade or an engine change should
  invalidate every result.
- Names, colors and min/max/step are **not** in the keys. Renaming or recoloring never re-evaluates.
- Keys are Merkle-style: a `part()` dependency's key is inside its caller's key, and a child's key is inside its group's
  key, so a change anywhere below invalidates exactly the results above it.
- Two definitions with identical content (a fresh unique copy, two Cubes from the same template) share keys, and so
  share one evaluation.

### Wanted jobs

`computeWantedJobs` decides what to evaluate right now:

- every visible Code or boolean occurrence that is not inside a boolean;
- the operands of a boolean, only while they are shown (the boolean, or something in it, is selected);
- the isolate target, while isolated;
- nothing at all while the code is paused.

`none` groups never get a job: three.js composes their children. Jobs are de-duplicated by `resultKey`, so the eight
bolts of the sample are one job. **Priority** goes to the selected occurrence's subtree, every occurrence of the
selected definition and the isolate target.

### The client (main thread)

`EvalClient` (`src/eval/client.ts`) owns the worker, the queue, the failure memo and the mesh cache.

- **Queue.** FIFO, de-duplicated by `resultKey`, priority keys first, one request in flight. Keys that are no longer
  wanted are dropped. Ready and failed keys are not queued again.
- **Failure memo.** A failed key is never retried by itself, only by `retry()` (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) or
  when the content changes and so the key changes.
- **Timeout.** After 20 s (`?evalTimeout=<ms>`) the worker is terminated and respawned, and the key fails with a
  `timeout` error. STL requests have 60 s.
- **Abandon.** An in-flight job that is no longer wanted is killed once it has run for 1 s, without recording a
  failure. That is how typing over an infinite loop recovers.
- **Crashes.** A worker error fails the in-flight key with a `crash` error and respawns the worker. Three crashes
  within 10 s stop evaluation (`Evaluator keeps crashing — reload the page`). A worker that never reports `ready`
  is retried three times with a growing back-off, then evaluation stops (`Evaluator failed to start`).
- **STL** requests wait for the in-flight job and then jump the queue.
- **Mesh cache** (`mesh-cache.ts`): `resultKey → MeshEntry` (one non-indexed `BufferGeometry` per mesh, the baked
  colors, the bounding box, time and warnings). It survives worker respawns. Entries that are neither wanted nor shown
  are evicted least-recently-used beyond 300 entries or 256 MB, and entries that stop being shown give their WebGL
  buffers back at once.

### The worker and the engine

`eval/worker.ts` is a thin shell around `eval/engine.ts`, which has no DOM or Worker dependencies and runs in Node
for the unit tests.

- User code is compiled once per code text (LRU of 100) as
  `new Function('params', 'part', 'jscad', 'Math', ...SHADOWED, ...FLAT_NAMES, '"use strict";\n' + code)`. The engine
  calibrates the line offset of that wrapper at start-up, so error line numbers refer to the user's lines.
- Results are memoized by `resultKey` (LRU of 200 entries and about 2,000,000 polygon vertices), so repeated `part()`
  calls and unchanged children of a group are free. Group ops (`union`, `subtract`, `intersect`) run here too.
- `Math.random` is a mulberry32 generator seeded from the result key.
- Every exception is wrapped once, at the innermost definition being evaluated, into an `EvalError` that names that
  definition and the trace of names above it.
- The geometry guards wrap the creating JSCAD functions: an estimate refuses an oversized call before it allocates,
  and a per-evaluation budget stops code that creates more than 2,000,000 polygons. Results above 2,000,000
  triangles fail.
- Meshes go back as non-indexed `Float32Array` positions and normals, **transferred** rather than copied, with a
  bounding box computed from the exact float32 values.

### The worker protocol

The messages are typed in `src/eval/protocol.ts`:

```ts
export type ToWorker =
  | { type: 'eval'; id: number; job: Job }
  | { type: 'stl';  id: number; items: { job: Job; matrix: Mat4 }[] }

export type FromWorker =
  | { type: 'ready'; lineOffset: number; flatNames: number }
  | { type: 'result'; id: number; resultKey: string; ok: true;  meshes: MeshData[]; tris: number; ms: number; warnings: string[] }
  | { type: 'result'; id: number; resultKey: string; ok: false; error: EvalError; ms: number }
  | { type: 'stl';    id: number; ok: true;  parts: ArrayBuffer[]; tris: number }
  | { type: 'stl';    id: number; ok: false; error: EvalError }

export interface MeshData {
  positions: Float32Array; normals: Float32Array     // non-indexed triangles, 9 floats per tri
  color?: [number, number, number, number]          // baked by code via colorize (sRGB 0..1)
  bbox: [Vec3, Vec3]
}
export interface EvalError {
  kind: 'syntax' | 'runtime' | 'result' | 'cycle' | 'dependency' | 'timeout' | 'crash'
  def: Id; defName: string          // the def whose code actually failed (innermost)
  message: string; line?: number; col?: number
  trace: string[]                   // def names from the job root to the failing def
}
```

The worker posts `ready` once at start. The client sends one request at a time and matches replies by `id`, so a
late reply from a terminated worker is ignored. An `stl` request serializes binary STL of every item's geometry,
transformed by its world matrix, without unioning the solids.

### Scene sync and the last good mesh

`view/scene-sync.ts` keeps a three.js `Group` per occurrence, nested like the instance tree, and gives each mesh the
shared `BufferGeometry` of its result. When an occurrence's new result is not ready, it keeps showing the **last good**
mesh: semi-transparent while the new one is pending, tinted red when it failed. Materials come from
`view/materials.ts`, which works out selected, linked (purple), ghosted, operand and stale or error states.

The gizmo (`view/gizmo.ts`) moves the three.js objects directly during a drag, copying the transform to every object of
the same instance so that linked copies move together, and only calls `commands.commitGizmo` on release. That
release is the one store update, and the one undo step, of the drag.

## Undo model

The history is made of **project snapshots** (`state/history.ts`), which is cheap because projects are small and
plain:

- `store.update(label, recipe, opts)` clones the project, runs the recipe on the clone, and compares the result with
  the original. If nothing changed, nothing is recorded. If the recipe throws an `OpError`, its message becomes an
  error toast and nothing changes. Otherwise the previous snapshot is pushed with the label (the toolbar shows
  *Undo Move Bolt*), the redo stack is cleared, and the selection is repaired (`fixSelection`) in case it points at
  something that no longer exists.
- **Coalescing.** An update with the same `coalesce` key as the previous step, within its time window, replaces the
  state without adding a step: per transform field and instance (`xf:<id>:<field>`, 500 ms), per parameter override
  (`param:<id>:<name>`, 500 ms), per color (1 s) and per definition's code (`code:<id>`, 2 s).
- **Cap:** 200 steps.
- **Not in history:** the selection, the entered group, the view mode, expanded rows, gizmo settings and the camera.
- **Reset** on New, Sample, Open and reload. The history is not saved.
- Changes made through the MCP server are ordinary steps labelled `MCP: …`, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes an
  assistant's edit.
- The code editor keeps its own CodeMirror history while you type in it. Its text is committed to the store 0.4 s
  after you stop typing, as one coalesced *Edit code* step.

## Persistence

`state/autosave.ts` writes `{ savedAt, project, paused? }` to `localStorage` 1 s after a change, keeps a ring of five
validated backups, and on boot loads the current record, then the newest backup, then the sample. A crash marker
written while a slow job runs makes the next boot pause the code instead of crashing again. `core/project-io.ts`
serializes and validates the `.3dica.json` format. See [Files, autosave and STL](/reference/files) for the behavior and
the format.

## The MCP bridge

AI assistants drive 3Dica through `mcp/server.mjs`, a Node MCP server that speaks MCP over stdio to the assistant and
runs a WebSocket server on `127.0.0.1` (port 6173 by default) for the app. A tab opened on localhost with `?mcp` joins
it through `src/mcp/bridge.ts`. Its handlers (`src/mcp/handlers.ts`) use the same core ops and the same store as the
UI. Screenshots come from `ViewportApi.capture` (`src/view/viewport.ts`): it renders with its own cameras into the
view's renderer, resized to the requested size, copies the pixels out and restores everything in the same task, so
the user's camera and selection never change and the canvas never flickers. `src/mcp/screenshot.ts` lays out the
views, draws the labels, axis triad and scale bar, and writes the text that goes with the image. Published copies,
such as the GitHub Pages site, never open the socket. See [AI assistants (MCP)](/guide/mcp).

## Boot order

`src/main.ts` builds the app in this order:

1. `Autosave.boot(location.search)` picks the project (`?fresh`, the autosave, a backup or the sample);
2. the `Store`, the `EvalClient` (which spawns the worker), the viewport, the commands and the controller;
3. `viewport.mount(#view)`, then the breadcrumb overlay, toolbar, tree, library, inspector, the MCP bridge (only if
   enabled), the status bar and the shortcuts;
4. the autosave subscriptions and the other-tab watcher;
5. `window.__3dica`, then the first controller pass, and `ready = true`.

## The test API

Every page installs a small API as `window.__3dica`, used by the e2e tests, the manual's screenshot generator and
debugging in the console:

| Member | Returns |
|---|---|
| `ready` | `true` after boot and the first render pass |
| `idle()` | A promise that resolves when nothing is queued or running and the view has drawn the result |
| `project()` | A deep copy of the project |
| `ui()` | `selection`, `context`, `viewMode`, `ghostOthers`, `gizmoMode`, `snap` |
| `stats()` | `{ occurrences, meshes, geometries, triangles, pending, failed }` |
| `occurrencesOf(name)` | How many times the named definition occurs in the scene |
| `defStatus(name)` | `'idle'`, `'pending'`, `'ok'` or `'error'` |
| `defError(name)` | The definition's `EvalError`, or `undefined` |
| `objectPixels()` | How many pixels of the view differ from the background (grid and gizmo hidden) |
| `gizmoAxisScreen(axis, along)` | The screen point `along` mm from the selected object along a world axis, for driving the gizmo |
| `history()` | `{ past, future }` undo labels |
| `view()` | What the gizmo is attached to, whether a drag runs, and the on-screen extent of what is drawn |

For example, in the developer console:

```js
await __3dica.idle()
__3dica.stats()          // { occurrences, meshes, geometries, triangles, pending, failed }
__3dica.defError('Bolt') // undefined when it evaluates
```

URL parameters for testing: `?fresh` starts from the sample and ignores the autosave, and `?evalTimeout=<ms>`
shortens the runaway-code timeout.
