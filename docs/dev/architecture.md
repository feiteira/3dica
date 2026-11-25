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
| `src/core/` | **Pure logic.** No DOM, no three.js, no Worker. Shared by the main thread and the worker, and unit-tested in Node. | `types.ts` (the data model), `graph.ts` (expansion, paths, `part()` scan, cycles), `ops.ts` (every project mutation), `evalspec.ts` (specs, keys, wanted jobs, status), `params.ts`, `hash.ts`, `project-io.ts` (file format), `selection.ts`, `transform.ts`, `templates.ts`, `sample.ts`, `colors.ts`, `ids.ts`, `scad.ts` (OpenSCAD objects: derived parameters, attached-file rules, the `part()` scan), `scad-import.ts` (which imported files become objects) |
| `src/state/` | Application state | `store.ts` (project + UI state, undo), `history.ts`, `autosave.ts`, `clipboard.ts`, `tabs.ts` (other-tab detection) |
| `src/app/` | Wiring | `context.ts` (the cross-layer interfaces), `commands.ts` (one method per user action), `controller.ts` (the render pass) |
| `src/eval/` | Evaluation | `protocol.ts` (worker messages), `engine.ts` (runs JSCAD and OpenSCAD code; pure, also runs in Node), `worker.ts` (thin worker shell), `client.ts` (queue, worker lifecycle), `mesh-cache.ts`, `edges.ts` (selection outlines) |
| `src/openscad/` | The OpenSCAD interpreter and geometry builder. No DOM; the contract is `types.ts` | See [OpenSCAD objects](#openscad-objects) below |
| `src/view/` | The 3D view (three.js) | `viewport.ts`, `scene-sync.ts`, `materials.ts`, `picking.ts`, `gizmo.ts` |
| `src/ui/` | Panels and input | `toolbar.ts`, `tree.ts`, `library.ts`, `inspector.ts`, `param-editor.ts`, `code-editor.ts` (CodeMirror 6), `scad-lang.ts` (OpenSCAD highlighting and completion), `scad-panel.ts` (an OpenSCAD object's parameter table and files list), `breadcrumb.ts`, `statusbar.ts`, `shortcuts.ts`, `dnd.ts`, `dom.ts` (the `h()` helper, toasts, dialogs), `icons.ts`, `right-tabs.ts` (Inspector / Chat), `chat.ts`, `chat-transcript.ts`, `chat-settings.ts`, `chat-markdown.ts` |
| `src/io/` | Browser file I/O | `files.ts` (download, file picker, window drop) |
| `src/agent/` | The in-app AI chat, without DOM | `types.ts` (the contract), `loop.ts` (`ChatController`), `tools.ts`, `prompt.ts`, `settings.ts`, `summary.ts`, `abort.ts`, `adapters.ts`, `providers/` (`anthropic.ts`, `openai-compatible.ts`, `presets.ts`, `common.ts`) |
| `src/mcp/` | The tool handlers, and the optional bridge to the local MCP server | `handlers.ts` (one handler per tool, used by MCP and the chat), `screenshot.ts`, `config.ts` (opt-in), `bridge.ts` (WebSocket client) |
| `shared/` | Plain ESM used by both the MCP server and the app | `tool-catalog.mjs` (tool names, descriptions, zod schemas), `briefing.mjs` (the model briefing and code-API cheat sheet), with `.d.mts` types |
| `mcp/` | The MCP server (Node) | `server.mjs`, `lib/` |
| `src/main.ts` | Boot | Builds everything in order and installs `window.__3dica` |

## Data model

Everything the user makes is one `Project` (`src/core/types.ts`), a plain JSON-serializable object:

- **Definitions** (`defs`, keyed by id). A **Code** definition has `code` and a parameter list. With
  `lang: 'openscad'` its code is OpenSCAD source, its parameter list is derived from that code, and an optional
  `files` map holds the files its `use <…>` and `include <…>` name. A **Group** definition has `children`
  (instances) and an `op`: `none`, `union`, `subtract` or `intersect`. The scene itself is the root group, named
  `Scene`.
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
                              eval/client.ts ── postMessage ──▶ eval/worker.ts ─▶ eval/engine.ts (JSCAD, OpenSCAD)
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
  names in a `part()` call. The names come from the static scan in `core/graph.ts` (`defRefs`: `staticRefs` for
  JavaScript, which ignores comments, and a token scan of the code and the attached files it reaches for OpenSCAD).
  An OpenSCAD spec also carries `lang` and its `files`.
- A `GroupSpec` holds the op and its **visible** children, each with its spec, resolved parameters and transform
  matrix.

A spec never points back into the project, so a job can be sent to a freshly started worker that knows nothing else.
Specs that cannot be built (a missing `part()` name, a cycle) become entries in `specErrors` and get no job.

A **Job** is `{ resultKey, spec, params }` with the parameters already resolved (defaults merged with overrides).

### Cache keys

```text
CodeSpec  defKey = hash(['code', ENGINE, code, params.map(p => [name, type, default (, options for a choice)]),
                         sortedDeps.map(([name, spec]) => [name, spec.defKey])
                         (, 'openscad', hash(sortedFiles.map(([path, text]) => [path, text]))   OpenSCAD code only)])
GroupSpec defKey = hash(['group', ENGINE, op, visibleChildren.map(c => [c.spec.defKey, c.params, c.matrix])])
resultKey        = hash([defKey, resolvedParams])
```

- `hash` is two 53-bit cyrb53 hashes of a stable stringification: sorted object keys, `-0` written as `0`, and
  4×4 matrices rounded to 1e-9 (`core/hash.ts`).
- `ENGINE` (`'jscad-2.13.0/e2'`) is part of every key. Bump it when a JSCAD upgrade or an engine change should
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
- OpenSCAD code is never compiled: the engine hands it to `runScad` from `src/openscad` (see below). The worker loads
  that module as a separate chunk the first time a job needs it (`usesScad(spec)`), so projects without OpenSCAD
  objects start as fast as before.
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
  | { type: 'result'; id: number; resultKey: string; ok: true;  meshes: MeshData[]; tris: number; ms: number; warnings: string[]; console?: ConsoleLine[] }
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
  console?: ConsoleLine[]           // OpenSCAD: the output before the error, the error and its call trace
}
export interface ConsoleLine {      // one line of an OpenSCAD object's Output panel
  level: 'echo' | 'warning' | 'error' | 'trace'
  text: string; line?: number; col?: number; file?: string
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

## OpenSCAD objects

An OpenSCAD object is a code definition with `lang: 'openscad'`. Its code is never run as JavaScript: `src/openscad`
interprets it and builds its geometry, and the engine treats the result like any other code result (memo, meshes,
STL, `part()`). The contract between the pieces is `src/openscad/types.ts`.

```text
 main thread                                      eval worker
 ───────────                                      ───────────
 core/scad.ts                                     eval/engine.ts  evalScad(spec, params, key)
   scadParams(code)  ◀─ openscad/customizer.ts      │  runScad(code, { files, overrides: params, randomSeed,
   scadRefs(code, files)  (part() scan)              │           preview: true, resolvePart, charge })
   scadDepList(code, files)  ◀─ openscad/deps.ts     ▼
 core/scad-import.ts  (Import plan)               openscad/index.ts  runScad = interpret + build
 ui/scad-lang.ts, ui/scad-panel.ts                  │
                                                     ├─ interpret(source, opts) → { nodes: GeomNode[], messages }
                                                     │    lexer → parser → plan (include / use) → interp
                                                     │    (scope, values, builtins, modules, format, rng)
                                                     └─ build(nodes, ctx) → { geoms: Geom3[], warnings }
                                                          build-2d, build-tri, build-offset, build-extrude,
                                                          build-project, build-csg, build-face, minkowski,
                                                          tess, text
```

- **Parameters are derived.** The code is the single source of truth. `core/scad.ts` calls `extractParams()` (the
  Customizer reader, which needs only the tokenizer) whenever the code changes: in `ops.addDef`, `ops.setCode`, a
  rename that rewrites `part()` calls, and `project-io` on load. `ops.setParamDefs` refuses an OpenSCAD definition,
  and `ops.setScadParamDefault` rewrites one literal in the code with `setParamDefault()`. The main thread imports only
  `customizer.ts`, `lexer.ts`, `deps.ts` and `paths.ts`, never the interpreter or the builder.
- **Overrides.** The engine passes the resolved parameters as `InterpretOptions.overrides`. The interpreter replaces
  the value of that top-level assignment, as `openscad -D` does, and maps a choice option back to its value.
- **interpret** turns source into a CSG tree of `GeomNode`s: one node per built-in module instance, with its
  arguments evaluated and normalised (`d` → `r`, transforms → one matrix, colour names → RGBA). User modules, loops,
  `children()` and modifiers are resolved into `group` nodes. `part("Name", …)` becomes a `part` node. It knows nothing
  about JSCAD.
- **build** turns that tree into JSCAD `Geom3`s with OpenSCAD's tessellation (`$fn` / `$fa` / `$fs`, sphere rings,
  extrusion slices), its own 2D engine and 3D booleans, and OpenSCAD's rules for colours and 2D/3D mixing. It knows
  nothing about the language. A `part` node calls `ctx.resolvePart`, which the engine wires to the same `part()` as
  JavaScript code, so the static dependency check, the override check and the memo are shared.
- **Budget.** `build` calls `ctx.charge(polygons, what)` before it creates geometry, and again for any excess after.
  The engine adds that to the same per-evaluation budget as JSCAD's creating functions, so `Too much geometry` stops a
  runaway OpenSCAD model while it is still allocating.
- **Errors and output.** Both sides throw `ScadError` (`syntax`, `runtime` or `limit`) with a `SourcePos`, whose
  `file` is `''` for the object's own code. The engine turns it into an `EvalError` with a line and column, or a
  `file:line:` prefix for an attached file, and attaches the console lines (`ScadError.messages`) and the call trace
  as `EvalError.console`. On success the console lines travel with the result (`console` on the worker message,
  `MeshEntry.console`) to the Output panel and to the MCP reports.
- **Caching.** `lang` and the attached files are part of the definition's cache key (above). The random seed for
  unseeded `rands()` comes from the result key, so a re-run gives the same shape. Inside one run, `build` also caches
  geometry by content, so a module called many times with the same arguments is built once (and still charged).
- **Main-thread cost.** An object may carry 200 attached files and 16 MB, and specs are rebuilt on every project
  change, so nothing there may rescan them each time. The store keeps an unchanged `files` map the same object across
  snapshots (`shareUnchanged`; ops replace a map, never change one in place), and `evalspec.ts` hashes each map once
  (a `WeakMap`), `core/scad.ts` keeps the `part()` and include scan per map and code (a `WeakMap`) on top of a scan
  cache bounded by characters (64 MB), and the Customizer reader remembers the last source it read. The scans are
  linear: the Customizer keeps its entries in a `Map`, and the fallback text scan counts lines as it goes.
- **Security.** OpenSCAD source is never passed to `eval`, `new Function` or a string `setTimeout`: the parser is
  hand-written, and the interpreter turns its syntax tree into plain closures, never into source text. Scopes and namespaces are `Map`s, so names like
  `__proto__` or `constructor` are ordinary variables. Limits (`InterpretLimits`: call depth, list and string length,
  values created, steps; plus a token limit in the lexer, a cap of 2,000,000 statements on what `include` expands to,
  the geometry budget and the worker's timeout) stop runaway code before the tab runs out of memory. Element-wise
  list arithmetic (`c + c`, `2 * c`, `-c`) is charged before its result is built, with a count that stops at the
  budget: a list of shared sub-lists can stand for billions of values. Values and expressions quoted in warnings and
  errors are cut at about 1,000 characters (`shortValue`), and the engine cuts any message at 10,000 and an echo line
  at 100,000, so a message built from the model's data can't flood the page, the Output panel or MCP. Attached-file paths are checked in `core/scad.ts`: relative, no `..` above
  the root, no `__proto__` / `constructor` / `prototype` segments, at most 2 MB each.
- **Bundle.** The interpreter and builder are a separate chunk of the worker, loaded on first use. The main bundle
  carries only the Customizer reader, the tokenizer and the editor's stream language.

### Fidelity and tests

The reference is the OpenSCAD 2021.01 binary, used as a black box: the behaviour was implemented from the OpenSCAD
User Manual and compared with the binary's echo output, CSG export and STL export. No OpenSCAD source code and none of
its bundled `.scad` files are copied into this repository (OpenSCAD is GPL and MCAD is LGPL; 3Dica is MIT). The
committed tests use our own snippets, with the expected output recorded from the binary:

| Tests | What they check |
|---|---|
| `tests/unit/scad-lang*.test.ts` | Console output and CSG trees of a few hundred snippets, against recorded binary output; interpreter details |
| `tests/unit/scad-customizer.test.ts` | Parameter extraction and default rewriting |
| `tests/unit/scad-build*.test.ts`, `scad-run.test.ts` | Vertices and volumes against the binary's STL export, tessellation tables, booleans, a 2D fuzz test |
| `tests/unit/scad-fidelity.test.ts`, `scad-limits.test.ts` | Whole models against recorded volumes; hostile inputs end with a `ScadError` |
| `tests/unit/openscad-*.test.ts` | Objects, the engine branch (`part()` both ways, budget, errors, console), the editor mode |
| `tests/e2e/openscad.spec.ts` | Import, the editor and Output panel, overrides, defaults, `part()`, attached files, save and autosave, STL, limits |

When you change the interpreter or the builder, compare with the binary (`openscad -o out.echo`, `-o out.csg`,
`-o out.stl`, `-D name=value`) on snippets of your own, and record the expected values in a test.

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
- Changes made through the MCP server are ordinary steps labelled `MCP: …`, and changes made by the in-app chat are
  labelled `AI: …`, so <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes an assistant's edit.
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

The tool list itself (names, descriptions, zod input schemas, annotations) lives in `shared/tool-catalog.mjs`, plain
ESM that both Node and the app's bundle load. `toolCatalog('mcp' | 'chat')` returns it for one audience: the texts
differ only where the two really differ (the history label prefix, file tools, confirmation, the screenshot size).

## The AI chat

The Chat tab is a second front end to the same tools, running entirely in the tab. The user's API key goes from the
browser straight to the provider; there is no 3Dica server.

```text
ui/chat.ts  (the Chat panel)
  │ send(text)             ▲ entries, state, usage
  ▼                        │ (subscribe: one render per frame)
agent/loop.ts  ChatController
  │                                 │ each tool call
  │ addUser · runTurn ·             ▼
  │ addToolResults            agent/tools.ts
  ▼                                 │ label prefix 'AI'
ChatSession (from the adapter)      ▼
  providers/anthropic.ts      mcp/handlers.ts ──▶ store
  providers/openai-compatible.ts
  │ HTTPS, straight from the tab (CORS)
  ▼
the provider: Anthropic, OpenAI, OpenRouter, Ollama, …
```

- **The contract** is `src/agent/types.ts`: `AgentTool`, `ProviderPreset`, `ProviderConfig`, `ChatSession`,
  `ProviderAdapter`, `TurnEvent`, `ChatEntry`. Start there.
- **The loop** (`loop.ts`, `ChatController`) has no DOM. A user message goes in with an `<app_state>` block in front
  (`prompt.ts`: project, selection, context group, paused code, errors). Then it runs model turns: every tool call of a
  turn runs in order, and all results go back in one `addToolResults`, also on Stop, bad input or an unknown tool, so
  the provider's history always pairs calls with results. It stops when the model ends its turn, on Stop, at the
  step limit (`maxSteps`, default 25) or after `maxChanges` project changes (default 100, half the undo history), where
  `continue()` goes on. `new_project` and `load_sample` wait for a `confirm` entry that the user approves or
  declines. The panel reads `entries`, `state`, `usage`, `canContinue` and `canRetry` (Retry only for errors that may
  pass, or after a settings change), and `subscribe()` fires on every streamed delta. Entries are replaced, never
  mutated. The same text sent again after a failure is a retry, not a second copy for the model.
- **The tools** (`tools.ts`) turn the catalog's zod shapes into a portable JSON Schema subset, validate the model's
  input, and run the handlers of `src/mcp/handlers.ts` with the label prefix `AI`. Each call is one undo step. The
  chat's `undo` and `redo` walk only `AI: …` steps and stop at the user's (an AI change after an undo would clear the
  user's redo steps).
  `save_project` and `export_stl` download through `ctx.files`, and errors come back as text the model can read.
- **The adapters** own the conversation history in their provider's native format and only ever append to it, which
  keeps Anthropic's thinking blocks intact and prompt caching effective. `anthropic.ts` uses `@anthropic-ai/sdk`
  (streaming, adaptive thinking with `effort` on Claude 4.6 and later, prompt caching). `openai-compatible.ts` uses the
  `openai` SDK for every other preset and strips the SDK's `x-stainless-*` headers, so the browser's CORS preflight
  asks only for `authorization` and `content-type`. It sends screenshots as text, per request and without changing
  the stored history, when images are off, when OpenRouter lists the model as text-only, or after the server refused
  them once (that turn is sent again). It echoes Gemini's thought signatures and DeepSeek's `reasoning_content`. A
  `ProviderError`'s message is the provider's own text; `describeError` in `loop.ts` writes the one sentence around it. `presets.ts` lists the providers; each hosted one was checked for
  CORS from a browser.
- **Settings** (`settings.ts`) are in `localStorage` under `3dica:v1:ai`. Keys are kept apart under
  `3dica:v1:ai-keys`, in `localStorage` or `sessionStorage` depending on "remember", and in memory when storage is
  blocked. Error texts shown to the user go through `redactKey`, and an authentication error leaves out the provider's
  own text, since some providers echo a masked key.
- **Bundle.** The panel imports only `loop.ts`, `settings.ts`, `presets.ts` and `adapters.ts`. The tool layer (zod),
  the system prompt (the cheat sheet reads `@jscad/modeling`) and each provider SDK are separate chunks, loaded on the
  first message.
- **The panel** (`src/ui/chat*.ts`) renders the transcript with a small Markdown renderer that builds DOM nodes with
  `textContent` only, so model text never becomes HTML. `right-tabs.ts` holds the Inspector and Chat tabs and
  <kbd>Ctrl</kbd>+<kbd>L</kbd>.

## Boot order

`src/main.ts` builds the app in this order:

1. `Autosave.boot(location.search)` picks the project (`?fresh`, the autosave, a backup or the sample);
2. the `Store`, the `EvalClient` (which spawns the worker), the viewport, the commands and the controller;
3. `viewport.mount(#view)`, then the breadcrumb overlay, toolbar, tree, library, inspector, the right column's tabs and
   the chat panel, the MCP bridge (only if enabled), the status bar and the shortcuts;
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
