# 3Dica v0.1: implementation spec

> **Historical document.** This is the design spec that 3Dica v0.1 was built from, kept because code comments refer to
> its sections (`§4.5` and so on). It describes the plan, not necessarily the result: **the code is the source of
> truth.** Where the two differ, the code wins. The user manual (`docs/`, published at
> <https://feiteira.github.io/3dica/manual/>) describes what the app actually does.

Status: implemented in v0.1.0.
Pitch: **a JSCAD workbench with linked components.** Every object is a named JSCAD definition with its own code. Objects sit in a scene tree that you can copy around as live linked instances, and clicking an object isolates it in the center 3D view.

Facts marked **[verified]** were verified during development, before the implementation started, with small throwaway test programs on Node 20.19.6, the pinned packages and Playwright's Chromium. Those checks covered transform equivalence, the ZYX decomposition, the flattened scope, line calibration, all the sample code and vitest 4.1.12. The unit tests in `tests/unit/` now cover the same ground.

## Known deviations

The implementation differs from this spec in these ways (checked against the code for v0.1.0). Smaller wording
differences in messages and tooltips are not listed.

**Code API and evaluation (§3, §5)**
- **`staticRefs` ignores comments.** The `part()` scan runs on the code with every `//` and `/* */` comment blanked
  out (`blankComments` in `core/graph.ts`), so a commented-out call, or the blank template's own header, is not a
  dependency. String, template and regular-expression literals are skipped correctly, so a `//` or a quote inside a
  regex (`/\/\//`, `/"/g`) does not start a comment or a string. An unknown name is reported on the line of its `part()` call.
- **`minkowski` is in scope.** §3.1 says it is not among the flattened names. It is: `booleans.minkowski` is flattened
  like the other booleans (still 93 names, no collisions). The `minkowski` *namespace* (`minkowskiSum`) and `modifiers`
  are not flattened; reach them through `jscad`.
- **Out-of-memory guards.** A worker that runs out of memory takes the whole tab down before the 20 s timeout can act,
  so the engine adds limits that §3.1 and §5.4 do not have. A primitive or extrusion whose `segments` (or
  `twistSteps`, `frequency`, …) alone would exceed 2,000,000 triangles fails before it is built, and an evaluation that
  *creates* more than 2,000,000 polygons fails at once. Both report "Too much geometry: …" on the calling line. The
  creating namespaces are guarded also when reached as `jscad.primitives.x`.
- **Caches are bounded by size.** The worker memo is bounded by 2,000,000 polygon vertices as well as 200 entries.
  The main-thread mesh cache is bounded by 256 MB of vertex data as well as 300 entries. `MeshEntry` also carries `ms`
  and `warnings` for the inspector status line.
- **Selection outlines** are built by `eval/edges.ts`, a faster equivalent of three's `EdgesGeometry` (same 30°
  rule), and are skipped for results above 300,000 triangles.
- `EvalStatus` has a `fatal` field for "Evaluator keeps crashing — reload the page".

**Keyboard (§4.10, §4.13)**
- **Ctrl+Enter** (also Cmd+Enter, and `Mod-Enter` inside CodeMirror) is "run code": it flushes the editor, clears
  `evalPaused` if set (the same as the **Run code** button), and retries the jobs of the selected definition, or every
  failed job when nothing is selected.
- **Ctrl+C** with no occurrence selected is left to the browser, so copying page text still works. **Ctrl+V** is
  handled only when the internal clipboard holds something.
- While a modal dialog is open, the app's shortcuts are off.
- Cmd is treated like Ctrl on macOS.

**Tree and selection (§4.7, §4.8)**
- Double-clicking a tree row's *label* renames it. Double-clicking elsewhere on a group row expands or collapses it.
- The tree header has an **Unhide all** button and the Library header a **Purge** button (`data-testid` `unhide-all`
  and `purge`).

**Persistence (§6)**
- **"Open without running" survives a reload.** The autosave record is `{ savedAt, project, paused? }`. A paused
  project comes back paused, with the **Run code** button showing, so untrusted code never runs on reload.
- **Crash recovery.** While a job has been evaluating for 500 ms or more, `3dica:v1:evaluating` names it. If the page
  dies (a worker out of memory), the next boot finds the marker and restores the project with its code paused, naming
  the object that was running.
- **Backup ring.** The ring position is kept in `3dica:v1:backup-meta`. Only records that load (`parseProject`) are
  rotated into the ring, and when storage is full the backups make room for the current version. The project is also
  flushed on `pagehide` and when the tab is hidden, after the code editor's pending edit is committed.
- **Other tabs.** All tabs share one autosave slot, so `state/tabs.ts` detects another 3Dica tab (BroadcastChannel,
  with the `storage` event as fallback) and the app warns once.
- **STL export** skips objects whose evaluation already failed and names them in a toast, instead of running them again
  inside the STL request. It refuses while code is paused. Open accepts `.json`, `.3dica.json` and `application/json`.

**Interface (§4.1)**
- The toolbar starts with a "3Dica" brand mark and ends with a **Manual** link (`data-testid="manual"`) to the
  published manual. The Cylinder button is labelled "Cyl".

**Tooling and layout (§7, §8, §9)**
- `src/app/` (commands, controller and the cross-layer contract `context.ts`), `core/colors.ts`, `core/selection.ts`,
  `eval/edges.ts`, `state/tabs.ts`, `ui/dnd.ts` and `ui/icons.ts` are not in the §7 layout. There are more unit test
  files than §9.2 lists, and `tests/e2e/fixes.spec.ts` holds regression scenarios.
- `playwright.config.ts` reads `PW_PORT` so that several runs can use different ports (defaults 5173 and 4173).
- The test API has an extra `view()` (gizmo attachment, dragging, on-screen extent) for debugging and e2e.
- `package.json` has more scripts and dependencies than §8.1: the VitePress manual (`docs:*`, `build:site`), the MCP
  server (`mcp`, with `@modelcontextprotocol/sdk`, `ws` and `zod`) and project metadata. The install is a plain
  `npm ci`, followed by `npx playwright install chromium` once per machine.
- §11 lists AI features as out of scope. v0.1.0 nevertheless ships a local MCP server (`mcp/`) so that an AI assistant
  can drive a running 3Dica and take screenshots.

---

## 0. Decision

### 0.1 Scores (1–10)

| Proposal | Fidelity to idea | Feels more 3D than OpenSCAD | Buildable in one session | Robustness | Extensibility | **Total** |
|---|---|---|---|---|---|---|
| code-first | 8 | 7 | 5 | 8 | 9 | **37** |
| direct-manipulation | 9 | 9 | 5 | 7 | 8 | **38** |
| **lean-mvp** | 8 | 7 | 9 | 9 | 7 | **40** |

- **code-first.** Strongest code story (`part()`, Merkle keys, rename rewriting, isolate). It is also heavy: three Part kinds, a sync/rev protocol and dynamic dependency tracking.
- **direct-manipulation.** Best 3D feel: smart framing, purple tint on linked copies, reparenting that keeps world position, live gizmo preview, Q for space. It is the most UI to build. It has no way to reference another object from code, and its Ctrl+D (unique copy) conflicts with the core "copies are linked" idea.
- **lean-mvp.** Simplest model to ship: one Group kind with `op`, self-contained eval specs that survive worker respawn, structuredClone undo, a pure core that is unit-tested. One bug: it uses three's default Euler `XYZ`, which does not match OpenSCAD's `rotate([x,y,z])`.

### 0.2 Winner and grafts

The winner is **lean-mvp**, used as the skeleton. These ideas are grafted in:

- **From code-first:**
  - `part(name, overrides)` in code, resolved from statically scanned string literals. Dependencies are folded into the keys Merkle-style. The worker keeps a cycle and depth guard.
  - Rotation order is OpenSCAD's `T·Rz·Ry·Rx·S`. three's Euler `'ZYX'` matches it **[verified]**.
  - An Isolate mode that shows the definition alone at the origin.
  - Rename rewrites `part('Old')` references.
  - Delete is refused while code still references the definition.
  - `Math.random` is seeded per cache key.
- **From direct-manipulation:**
  - Smart framing on tree click, plus Home and the numpad views.
  - Linked copies get a purple tint and show the linked edit live while you drag.
  - Reparenting keeps the world position.
  - Tree drop zones split each row into thirds.
  - Q toggles world/local space. Holding Ctrl suspends snapping.
  - A toast says "N copies updated".
  - Imported code runs only after an explicit **Run code**.
- **From lean-mvp:** the inspector override UI is built now, not deferred, because the Bolt sample needs it.

---

## 1. Mental model

| Term | Meaning |
|---|---|
| **Definition** (def) | A reusable, named thing. It is either **Code**, a JSCAD function body with parameters, or a **Group** of child instances with `op`: `none` (plain assembly), `union`, `subtract` or `intersect`. Primitives are Code defs created from templates, so every object can be opened as code. |
| **Instance** | A placement of a def inside a parent Group def. It holds a transform, an optional label, an optional color, parameter overrides and a hidden flag. |
| **Scene** | The root Group def (`op: 'none'`). It is never instanced and is not listed in the Library. |
| **Occurrence** | One rendered copy of an instance, addressed by an **InstancePath** (the instance ids from root to leaf). Children of a linked group occur once per copy of the group. |
| **Library** | Every def except the root, with its occurrence count. |

Rules:
1. **Copying is linked by default** (Ctrl+D). Editing a def, which includes moving a child inside a group def, updates every occurrence. Make Unique and Ctrl+Shift+D break the link one level deep.
2. **The code is the truth for shape. Node data is the truth for placement.** The gizmo writes `Instance.xf` and never writes code text, so no code is ever parsed back.
3. **Selection is an InstancePath**, so it identifies which copy was clicked. Selecting a Library row selects a def instead.

---

## 2. Data model

### 2.1 Types: `src/core/types.ts` (exact)

```ts
export type Id = string            // defs: 'd_' + id body, instances: 'i_' + id body; id body = /[a-z0-9]{1,32}/
export type Vec3 = [number, number, number]
export type Mat4 = number[]        // length 16, column-major. three Matrix4.elements and jscad mat4 use the same layout [verified]

/** M = T(t) · Rz(r[2]) · Ry(r[1]) · Rx(r[0]) · S(s), the same as OpenSCAD translate(t) rotate(r) scale(s).
 *  r is in degrees. In three this is Object3D.rotation.order = 'ZYX' [verified equal element-wise to jscad]. */
export interface Transform { t: Vec3; r: Vec3; s: Vec3 }

export type ParamValue = number | boolean | string
export interface ParamDef {
  name: string                     // valid JS identifier, unique within the def
  type: 'number' | 'boolean' | 'choice'
  default: ParamValue              // number for 'number', boolean for 'boolean', one of options for 'choice'
  min?: number; max?: number; step?: number   // UI hints only, never clamped at eval time
  options?: string[]               // required for 'choice', length >= 1
}

export type GroupOp = 'none' | 'union' | 'subtract' | 'intersect'   // subtract = (union of child 0) minus all later children

interface DefBase { id: Id; name: string; color?: string /* '#rrggbb' lowercase */ }
export interface CodeDef  extends DefBase { kind: 'code';  code: string; params: ParamDef[] }
export interface GroupDef extends DefBase { kind: 'group'; op: GroupOp; children: Instance[] }
export type Definition = CodeDef | GroupDef

export interface Instance {
  id: Id
  def: Id                          // the definition it places
  name?: string                    // optional label; the tree shows name ?? def.name
  xf: Transform                    // local transform in the parent group's space
  color?: string                   // '#rrggbb'
  params?: Record<string, ParamValue>   // overrides for code defs; unknown keys are kept but ignored
  hidden?: boolean                 // excluded from render, booleans, part() flattening and STL
}

export interface Project {
  format: '3dica'
  version: 1
  name: string
  root: Id                         // a GroupDef with op 'none'
  defs: Record<Id, Definition>
  camera?: { position: Vec3; target: Vec3 }
}

export type InstancePath = Id[]
export type Selection =
  | { kind: 'none' }
  | { kind: 'occ'; path: InstancePath }
  | { kind: 'def'; def: Id }

export interface UiState {
  selection: Selection
  context: InstancePath            // the entered group occurrence; [] means the scene root
  viewMode: 'context' | 'isolate'
  ghostOthers: boolean             // default true
  gizmoMode: 'translate' | 'rotate' | 'scale'
  gizmoSpace: 'world' | 'local'
  snap: boolean                    // default true: 1 mm / 15° / 0.1
  expanded: Record<string, boolean>   // tree rows, keyed by path.join('/')
  evalPaused: boolean              // true after "Open without running"
  autoIsolatedFrom?: 'context' | 'isolate'   // set when a Library click forced isolate; restored on the next occurrence selection
}
export const IDENTITY_XF: Transform = { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }
```

### 2.2 Invariants (`parseProject` checks them all; ops keep them true)
- `defs[root]` exists, is a group with op `none`, and no instance references `root`.
- Each `Instance.def` exists. Instance ids are **unique across the project**. Def ids are unique map keys.
- Def names are unique (case-sensitive), trimmed, 1 to 64 characters, contain none of `' " \` \\` or a newline, and are not `Scene`. The root's name is `Scene`.
- The def graph is a DAG. Its edges are *group → child def* and *code def → each name in `staticRefs(code)`*.
- Each `xf` value is three finite numbers. Scale components may be negative (mirroring) but not 0; the UI rejects 0.
- ParamDef names are valid identifiers and unique within their def. Each default has the right type.

### 2.3 Project file `.3dica.json`
The file is the `Project` object plus two informational fields, `app: "3dica 0.1.0"` and `savedAt: ISO string`, which are ignored on load. It is written by `serialize()` with 2-space indentation and keys in this order: `format, version, app, name, savedAt, root, camera, defs`. `defs` keys are sorted by id. Inside each def the order is `id, name, kind, color, op|params, code|children`.

Loading:
1. `format !== '3dica'` → error.
2. `version > 1` → error "made by a newer 3Dica".
3. Otherwise run `MIGRATIONS[version]` in sequence (for v1 this is the identity, and the table exists for v0.2).
4. Validate (§2.2).

Excerpt:
```json
{ "format": "3dica", "version": 1, "app": "3dica 0.1.0", "name": "Bracket kit", "savedAt": "2026-11-11T12:00:00.000Z",
  "root": "d_root",
  "defs": {
    "d_bolt": { "id": "d_bolt", "name": "Bolt", "kind": "code", "color": "#aab4be",
      "params": [ { "name": "length", "type": "number", "default": 12, "min": 4, "max": 80, "step": 1 },
                  { "name": "diameter", "type": "number", "default": 5, "min": 2, "max": 20, "step": 0.5 } ],
      "code": "const { length, diameter } = params\n..." },
    "d_root": { "id": "d_root", "name": "Scene", "kind": "group", "op": "none",
      "children": [ { "id": "i_fx1", "def": "d_fixture", "name": "Fixture A", "xf": { "t": [0,0,0], "r": [0,0,0], "s": [1,1,1] } } ] }
  } }
```

### 2.4 Color resolution (render time; never part of a geometry key)
- **Code leaf mesh:** use the first of these that is set:
  1. the **outermost** instance on the path with `color`
  2. the color baked by code (`colorize`)
  3. `def.color`
  4. `#9aa4b2`
- **Boolean group result:** use the first of these that is set:
  1. the outermost instance color
  2. the group `def.color`
  3. the resolved color of the first visible operand (its instance color, else its def color)
  4. `#9aa4b2`

  jscad booleans drop colors **[verified]**.
- `part()` results carry only colors that code baked in. Instance and def colors are not applied.

---

## 3. The code-object API

### 3.1 Contract
A Code def's `code` is a **function body**. It must `return` a `Geom3`, or an array of them (nested arrays are flattened). It runs in the worker as follows:

```ts
new Function('params', 'part', 'jscad', 'Math', ...SHADOWED, ...FLAT_NAMES, '"use strict";\n' + code)
```

Names in scope:

| Name | Value |
|---|---|
| `params` | A frozen object. It holds the def's ParamDef defaults, merged with the instance overrides or the `part()` overrides. |
| `part(name, overrides?)` | Returns `Geom3[]`, another definition's geometry in that definition's **own local coordinates**. For a group target, the child transforms inside it are applied. It is the OpenSCAD-module-call analogue. |
| `jscad` | The whole `@jscad/modeling` default export. |
| `Math` | `Object.create(Math)` with `random` replaced by mulberry32, seeded from the result key. Re-running gives the same result. |
| Flattened jscad functions (93 names, **no collisions [verified]**) | Every key of `primitives, booleans, transforms, extrusions, hulls, expansions, colors, measurements, text, utils, curves`. For example: `cuboid, roundedCuboid, sphere, cylinder, torus, polyhedron, circle, rectangle, polygon, union, subtract, intersect, scission, translate, translateZ, rotate, rotateZ, scale, mirror, center, align, transform, extrudeLinear, extrudeRotate, extrudeHelical, hull, hullChain, expand, offset, colorize, hexToRgb, measureBoundingBox, vectorText, degToRad, bezier`. `minkowski` is not among them; it is reachable as `jscad.minkowski`. *(Not so in the code: `booleans.minkowski` is flattened; see Known deviations.)* |
| `self, globalThis, postMessage, importScripts, fetch, XMLHttpRequest, WebSocket` | Shadowed as `undefined`. This is hygiene, **not a sandbox**. |

`FLAT_NAMES` is computed once at worker start, by iterating those namespaces in that order with `Object.entries`.

**`part()` rules**
- `name` must be a string literal that appears in the code, in the form `part('Bolt'` or `part("Bolt"`. `staticRefs(code)` finds these with `/\bpart\(\s*(['"])((?:(?!\1).)+)\1/g`. At runtime, a name that is not in the def's static dependency set throws `part("X"): not a dependency of "Y" — call part with a string literal, e.g. part('Bolt')`. This keeps cache keys sound without dynamic tracking.
- `overrides` for a Code target are merged over its defaults, and unknown keys throw. For a Group target, passing non-empty overrides throws `groups have no parameters`.
- The returned array is fresh, but its geometries are shared. That is safe because jscad geometries are immutable.
- Hidden children of a group target are excluded.

**Return validation (worker)**
| Result | Outcome |
|---|---|
| A `geom2` or `path2` item | error `Returned 2D geometry — extrude it first (e.g. extrudeLinear)` |
| Any other non-geom3 item | error `Return a 3D geometry or an array of them; got <typeof/constructor>` |
| Empty | ok, with the warning `Returned nothing` |
| More than 2,000,000 triangles | error |
| Any NaN position | error |

**Error line numbers.** At start-up the worker calibrates `lineOffset`. It compiles `throw new Error("__probe")` with the same parameter list and prelude, finds the first `/<anonymous>:(\d+):(\d+)/` in the stack, and sets `lineOffset = L - 1` (3 in V8 **[verified]**). For a runtime error, the user line is `L - lineOffset`, taken from the first `<anonymous>:L:C` frame. This also works for errors thrown inside jscad, such as `roundRadius must be smaller…`, which map to the calling line **[verified]**. A `SyntaxError` from `new Function` carries no location **[verified]**. In that case the editor finds the first lezer error node and puts the diagnostic there, or on line 1 if there is none.

### 3.2 Templates (`src/core/templates.ts`)

Add a new object from a template like this:
1. Name it with `uniqueName(base)`.
2. Take its color from `PALETTE[n++ % 8]`, where `PALETTE = ['#4f8fd8','#e07a3a','#52b788','#c9a227','#b56ad8','#e05252','#3fb6c6','#9aa4b2']`.
3. Every primitive sits **on** the XY plane (z ≥ 0) and is centered in XY.

| Template | Params (default, min, max, step) | Code |
|---|---|---|
| Cube | width 10 (0.1, 500, 1), depth 10, height 10 | `const { width, depth, height } = params`<br>`return cuboid({ size: [width, depth, height], center: [0, 0, height / 2] })` |
| Sphere | radius 6 (0.1, 500, 0.5), segments 32 (4, 128, 1) | `const { radius, segments } = params`<br>`return sphere({ radius, segments, center: [0, 0, radius] })` |
| Cylinder | radius 5, height 10, segments 32 | `const { radius, height, segments } = params`<br>`return cylinder({ radius, height, segments, center: [0, 0, height / 2] })` |
| Torus | innerRadius 1.5 (0.1, 100, 0.1), outerRadius 6 (0.5, 500, 0.5) | `const { innerRadius, outerRadius } = params`<br>`return translateZ(innerRadius, torus({ innerRadius, outerRadius, innerSegments: 16, outerSegments: 48 }))` **[verified bbox ±7.5, z 0..3]** |
| Code (blank) "Object" | size 10 | the comment header below, then `const { size } = params`<br>`return roundedCuboid({ size: [size, size, size], roundRadius: size / 10, segments: 8, center: [0, 0, size / 2] })` |
| Group | none | an empty GroupDef with op `none` |

Comment header for the blank Code template:
```js
// params: this object's parameters (defaults + per-instance overrides)
// Every @jscad/modeling function is in scope: cuboid, sphere, cylinder, union, subtract, translate, rotate, extrudeLinear, …
// part('Name', { param: value }) returns another object's geometry, like calling an OpenSCAD module.
// Return a 3D shape or an array of shapes.
```

Nominal half-width for placement (§4.2): Cube 5, Sphere 6, Cylinder 5, Torus 7.5, Code 5, Group 0.

### 3.3 Sample project "Bracket kit" (`src/core/sample.ts`, fixed ids)

Every snippet below was run under jscad 2.13. Results **[verified]**: Bolt has 4,382 polygons and builds in 18 ms. Plate takes 60 ms and has bbox ±30 × ±20 × 0..4. The Washer boolean takes 18 ms. "Bolt sizes" has 10 geoms and 29k polygons.

**`d_bolt` "Bolt"** (code, color `#aab4be`; params: length 12 (4, 80, 1), diameter 5 (2, 20, 0.5)). The head sits on z = 0 and the shank points down.
```js
const { length, diameter } = params
const r = diameter / 2
const headH = 0.7 * diameter
// hex head: a 6-segment cylinder is a hexagonal prism
const head = cylinder({ radius: 0.9 * diameter, height: headH, segments: 6, center: [0, 0, headH / 2] })
// thread look without booleans: an off-centre circle twisted along the shank
const pitch = 0.8
const profile = translate([0.06 * r, 0, 0], circle({ radius: 0.94 * r, segments: 24 }))
const turns = length / pitch
const shank = translateZ(-length, extrudeLinear({ height: length, twistAngle: turns * 2 * Math.PI, twistSteps: Math.ceil(turns * 6) }, profile))
return [head, shank]
```
**`d_plate` "Plate"** (code, `#4f8fd8`; params: width 60 (20, 300, 1), depth 40 (20, 300, 1), thickness 4 (2, 20, 0.5), holeDiameter 5.5 (1, 20, 0.5), inset 7 (3, 50, 0.5)):
```js
const { width, depth, thickness, holeDiameter, inset } = params
const slab = roundedCuboid({ size: [width, depth, thickness], roundRadius: Math.min(1.5, thickness / 2 - 0.1), segments: 16, center: [0, 0, thickness / 2] })
const holes = []
for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
  holes.push(cylinder({ radius: holeDiameter / 2, height: thickness + 2, segments: 32,
    center: [sx * (width / 2 - inset), sy * (depth / 2 - inset), thickness / 2] }))
}
return subtract(slab, holes)
```
**`d_disc` "Disc"** (code, `#c9a227`; params: radius 5, thickness 1): `return cylinder({ radius: params.radius, height: params.thickness, segments: 48, center: [0, 0, params.thickness / 2] })`

**`d_hole` "Hole"** (code, `#e05252`; params: radius 2.75, height 3): `return cylinder({ radius: params.radius, height: params.height, segments: 32 })`

**`d_washer` "Washer"** (group, **op `subtract`**, color `#c9a227`): children `i_disc` → Disc and `i_hole` → Hole, both at identity.

**`d_fixture` "Fixture"** (group, op `none`). Children are listed in order. The four corner positions are P = (−23,−13), (23,−13), (−23,13), (23,13).
- `i_plate` → Plate at identity
- `i_w1`…`i_w4` → Washer at `t = [Px, Py, 4]`
- `i_b1`…`i_b4` → Bolt at `t = [Px, Py, 5]`. The head rests on the washer, and the shank passes through the hole.

**`d_boltsizes` "Bolt sizes"** (code, `#aab4be`; params: count 5 (1, 20, 1), start 8, step 4, spacing 12). It demonstrates `part()` with overrides and a loop:
```js
const out = []
for (let i = 0; i < params.count; i++) {
  const length = params.start + i * params.step
  out.push(translate([i * params.spacing, 0, length], part('Bolt', { length })))
}
return out
```
**`d_root` "Scene"** children:
- `i_fx1` → Fixture, label "Fixture A", at identity
- `i_fx2` → Fixture, label "Fixture B", `t [75,0,0]`, `r [0,0,15]`
- `i_bs` → Bolt sizes, `t [-24,-45,0]`

Project name: "Bracket kit". Expanded by default: `i_fx1` and `i_fx2`.

What the sample shows:
- Bolt occurs 8 times (`◆8`) with **one** geometry.
- Washer is a subtract group that is evaluated once and shared 8 times.
- Editing the Bolt's diameter changes 8 bolts plus the 5 in "Bolt sizes".
- Moving `i_b1` inside Fixture A moves it in Fixture B too.
- 4 distinct render jobs: Bolt(12,5), Plate, Washer and Bolt sizes.

---

## 4. UX behaviors

### 4.1 Layout (CSS grid, dark theme, min width 1100 px)
```
┌ toolbar 40px: [Cube][Sphere][Cyl][Torus][Code][Group] │ [∪][−][∩] │ [W][E][R] [World/Local] [Snap] │ [Ghost][Isolate][Frame] │ [↶][↷] │ [New][Sample][Open][Save][STL] │ [Run code]* ┐
├ left 280px ───────────────┬ viewport (flex) ───────────────────────┬ inspector 400px ───────────────┤
│ SCENE  (tree, 60%, scroll)│ breadcrumb (top-left)                   │ Occurrence: label · def · ◆N   │
│ ▾ Fixture A   ◆2      ●  👁│ isolate banner (top-center, isolate only)│ [Make unique]                  │
│   ▸ Plate     ◆2         │                                          │ Transform t/r/s · Color · Hidden│
│   ▸ Washer    ◆8         │                                          │ Parameters (overrides ● ↺)     │
│ LIBRARY (40%) [Purge]     │                                          │ ─ Definition (shared by N) ─   │
│   Bolt ×8  Plate ×2 …     │                                          │ Name · Color · op | Params table│
│                           │                                          │ CodeMirror · status line        │
└ status 24px: Evaluating 2 · last 60 ms (Plate) · 14 meshes · 61,234 tris · saved 12:01:33 ──────────────┘
```
\* **Run code** is visible only while `evalPaused`.

Every interactive control has a `data-testid`. Each tree row is `data-testid="tree-row"` with `data-path="<ids joined by '/'>"`, `data-def`, and `data-status="idle|pending|ok|error"`. Each Library row has `data-testid="lib-row"` and `data-def`. The toolbar ids are `add-cube`, `add-sphere`, `add-cylinder`, `add-torus`, `add-code`, `add-group`, `wrap-union`, `wrap-subtract`, `wrap-intersect`, `mode-translate`, `mode-rotate`, `mode-scale`, `space`, `snap`, `ghost`, `isolate`, `frame`, `undo`, `redo`, `new`, `sample`, `open`, `save`, `export-stl` and `run-code`. The code editor host is `data-testid="code-editor"`. In the inspector, the title is `inspector-title` and each parameter control is `param-<name>`; its reset button is `param-reset-<name>`. The transform inputs are `xf-t0` through `xf-s2`, and the inline rename input is `rename-input`.

### 4.2 Create an object (any Add button)
1. **Target group.** The target is the def of `ui.context`, or the root if the context is `[]`. If that def has more than one occurrence, show the toast `Added to 'Fixture' — 2 copies updated`.
2. **New def.**
   - Cube, Sphere, Cylinder, Torus and Code each get a new CodeDef from their template.
   - **Group** gets an empty GroupDef with op `none`.
3. **New instance.** Its placement is `xf.t = [ceil(maxX + 5 + halfW), 0, 0]`, where `maxX` is the max X of the evaluated parent-space bbox of the target's visible children. If nothing is evaluated or the group is empty, use `[0, 0, 0]`. The instance is appended to the target's children.
4. One undo step, labeled `Add Cube`. The new occurrence is selected and the gizmo attached. If it is off-screen, smart-frame it (§4.4).

**Wrap selection.** Ctrl+G or the [∪] [−] [∩] buttons need an occurrence selection.
1. Create a GroupDef named "Group", "Union", "Subtract" or "Intersect" (via `uniqueName`), with the matching op.
2. Move the selected Instance record (with its xf) into it as the only child.
3. Insert a new instance of the group at the same index in the old parent, with `IDENTITY_XF`, so the world position is unchanged.
4. Select the group occurrence and expand it.
5. One undo step. The user then drags or pastes the other operands in.

**Ungroup** (Ctrl+Shift+G, on a group occurrence):
1. Replace the group's instance with copies of its children, using new instance ids and `xf = fromMatrix(toMatrix(groupXf) · toMatrix(childXf))`.
2. If `fromMatrix` returns `null` (shear from non-uniform scale with rotation), refuse with a toast.
3. The group def stays in the Library.

### 4.3 Select
- **Tree row click:** `selection = {occ, path}` and `context = path.slice(0, -1)`. If the view was auto-isolated from a Library click, `viewMode` returns to its previous value. Smart framing applies (§4.4).
- **Library row click:** `selection = {def}`. `viewMode` becomes `isolate`, and the previous mode is remembered. The def is shown with default params, and the inspector shows the Definition section only.
- **Viewport click** (pointerup within 4 px of pointerdown, not after a gizmo drag; context mode only): raycast against visible meshes, which include ghosts and visible operands. A hit mesh maps to its occurrence `path` through `userData.path`. Let `k = context.length`.
  - If the hit does not start with `context`, set `context = []` and select `hit.slice(0, 1)`. Clicking outside exits the context, as in SketchUp.
  - A plain click selects `hit.slice(0, k + 1)`, the outermost object at the current level.
  - **Ctrl+click** selects the deepest leaf: `selection = hit` and `context = hit.slice(0, -1)`.
  - Clicking empty space sets `selection = none`. The context is unchanged.
- **Double-click** on a group occurrence: `context = hit.slice(0, k + 1)` and `selection = hit.slice(0, k + 2)`, if that exists.
- **Enter** with a group selected: `context = selection.path` and `selection = none`.
- **Esc**, applied in this order:
  1. If the view is isolated, exit isolate.
  2. If the context is non-empty, `selection = context` and `context = context.slice(0, -1)`.
  3. Otherwise `selection = none`.
- **Breadcrumb** (`Scene › Fixture A ◆2 › Washer ◆8`): clicking segment *j* sets `context = path.slice(0, j)` and selects the next segment. `Scene` sets the context to `[]` and clears the selection.

### 4.4 Center view: context and isolate (toggle **I** or the toolbar button)
**Context mode** (the default) shows the whole scene at world positions.
- **Selected occurrence:** a solid material with emissive `#2255aa` at 0.35, plus an `EdgesGeometry` outline (threshold 30°, `#4da3ff`).
- **Other occurrences of the same def** get a **purple linked tint** (emissive `#7a3cff` at 0.25).
- **With `ghostOthers`** (G, default on) and a non-empty selection, everything outside the selected subtree uses the shared ghost material: transparent, opacity 0.15, `depthWrite: false`. Linked copies use a purple ghost at opacity 0.3.
- **Inside an entered context** with nothing selected, everything outside the context is ghosted.
- **Ghosts stay pickable.** This is what makes OpenSCAD's `%` behaviour interactive.

**Isolate mode** renders only the selected thing's **definition**, at the origin with identity transform. An occurrence selection uses that occurrence's resolved params; a def selection uses the defaults.
- It uses a separate `isolateRoot`; the scene root is hidden.
- The view auto-frames on entry and on every selection change.
- The gizmo and picking are off.
- A banner reads `Isolated: Bolt (length 12, diameter 5) — I or Esc to return`.
- Code edits update the view live.

**Boolean groups** render only their result mesh. If the boolean occurrence, or anything inside it, is selected or is the context, its operands are also shown and are pickable:
- operand 0 as a wireframe overlay in its resolved color at opacity 0.35
- subtract cutters as translucent red `#ff4d4d` at opacity 0.3, with `depthWrite` off
- union and intersect operands translucent in their own color at 0.25
- If an operand is selected, the result is ghosted.

**Framing.** `frame(box)` keeps the view direction, sets the target to the box center and the distance to `1.2 · radius / sin(fov/2)`, and tweens over 300 ms with cubic ease-out.
- **Tree click:** auto-frames only if the selection's bbox is not fully in the frustum, or projects to less than 5% of the viewport height.
- **F:** frames the selection, or everything if nothing is selected.
- **Home:** frames everything.
- **1 / 3 / 7** (numpad or digit keys) give front, right and top views. Front looks along +Y, right looks along −X, top looks down −Z.

**Scene.**
- `THREE.Object3D.DEFAULT_UP.set(0,0,1)` before any object is created.
- `PerspectiveCamera(45, aspect, 0.1, 10000)`.
- `GridHelper(200, 20)` rotated π/2 about X, with 10 mm cells. Short X (red) and Y (green) axis lines.
- Background `#1f2329`.
- `HemisphereLight(0xffffff, 0x444444, 2)`, `DirectionalLight(0xffffff, 2)` at (60, −80, 120), and `DirectionalLight(0xffffff, 0.8)` at (−60, 60, 40).
- `WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })` with pixel ratio `min(devicePixelRatio, 2)`. Size is tracked with a `ResizeObserver`.
- `OrbitControls` with damping. The render loop uses `setAnimationLoop` and `THREE.Timer`, not `Clock`.

### 4.5 Duplicate, linked instance, copy and paste, make unique
| Action | Key | Exact result |
|---|---|---|
| **Linked instance** | Ctrl+D | Inserts a new Instance (new id, same `def`, `name`, `params`, `color`, `hidden: false`) right after the selected one in the same parent. Its `xf` equals the original's, offset along the parent's +X by `dx = ceil(bboxWidthX + 5)`. `bboxWidthX` is the occurrence's evaluated bbox in parent space; use 10 if it is not available. The copy is selected with the gizmo attached. The def's `◆N` count goes up. One undo step. |
| **Unique duplicate** | Ctrl+Shift+D | `cloneDef(def)` makes a **shallow** clone: new id, `uniqueName` ("Fixture 2"), same code, params and color. A group clone copies its children with **new instance ids** and the **same child defs**, so the children stay linked. Then it inserts an instance of the clone exactly as Ctrl+D does. |
| **Copy** | Ctrl+C | The internal clipboard gets `{ def, xf, params, color, name }` of the selected instance. It is in memory only; the system clipboard is out of scope. |
| **Paste linked** | Ctrl+V | Adds an instance of `clipboard.def` to the current context group, appended at the end. `xf` is the clipboard xf plus the Ctrl+D offset, so it never lands exactly on the original. Refused if `wouldCycle(contextDef, clipboard.def)` (`Can't paste 'Fixture' inside itself`), or if the def no longer exists. |
| **Paste unique** | Ctrl+Shift+V | Same as paste linked, using `cloneDef(clipboard.def)`. |
| **Make unique** | U, or the inspector button | Points this Instance at `cloneDef(def)`. Enabled only when the def has two or more **instance records**. Otherwise the tooltip reads "Only instance of 'X'. To diverge a copy of a linked group's child, Make Unique the group first." |

If an edit changes a non-root group def with more than one occurrence, show the toast `Changed 'Fixture' — N copies updated`.

### 4.6 Delete
- **Del or Backspace on an occurrence** removes that **Instance record** from its parent def, so it disappears from every copy of that parent (with the linked toast). The **definition stays** in the Library. If it has no uses left, it is greyed out and shows "unused". Selection moves to the parent path, or none. One undo step.
- **Del on a Library selection** runs `deleteDefinition(id)`:
  - If code in other defs references it (`referrers(id)` is not empty), it is **refused**: `Can't delete 'Bolt': used by code in 'Bolt sizes'`.
  - Else, if it has instance records, a confirm dialog asks `Delete 'Bolt' and its 4 instances (8 copies in the scene)?` and offers **Delete** or **Cancel**. Confirming removes the def **and every Instance with `def === id` in every group**, in one undo step. Groups emptied this way remain, empty.
  - Else it deletes the def immediately.
  - The root cannot be deleted.
- **Purge unused** (Library header) repeatedly removes defs with 0 instance records and 0 referrers until nothing changes. One undo step. Toast: `Removed 3 unused definitions`.

### 4.7 Rename
- **Tree:** F2 or double-click on the row text opens an inline input. Enter or blur commits; Esc cancels. **What you rename is the text you see:**
  - If the instance has a `name` label, the label is edited. An empty value clears the label.
  - Otherwise the **definition** is renamed.
- **Library or inspector "Definition name":** always renames the def.
- **Def rename:**
  1. Validate (§2.2). Show an error inline, keep the input open, and change nothing.
  2. In every CodeDef, replace `part\(\s*(['"])Old\1` with `part($1New$1`.
  3. One undo step, `Rename Bolt → Screw`.
  4. If the open editor's code changed, it is reloaded.
- The inspector also has an "Instance label" field.

### 4.8 Tree drag and drop (HTML5 DnD; data type `application/x-3dica`)
- **Payloads:** `{kind:'occ', path}` from scene rows, or `{kind:'def', def}` from Library rows.
- **Drop zone** is chosen from the pointer's Y within the target row:
  - **Top third:** insert before the row's instance, in the same parent. A blue line is drawn above the row.
  - **Bottom third:** insert after it. A blue line is drawn below the row.
  - **Middle third** of a **group** row: append into that group. The row is highlighted. On a code row, the middle third counts as before or after, whichever half the pointer is in.
  - **Empty area below the rows:** append to the root.
- **Validity** is checked on every `dragover` and again inside the op.
  - A drop is invalid when the target parent path has the dragged path as a prefix (dropping onto itself or its own subtree), or when `wouldCycle(project, targetParentDefId, draggedDefId)` is true.
  - An invalid target shows a red line and `dropEffect = 'none'`.
- **Plain drop** moves the instance and **keeps its world position**:
  - `newXf = fromMatrix(inv(worldMatrix(targetParentPath)) · worldMatrix(draggedPath))`.
  - If `fromMatrix` returns `null` (shear), the local xf is kept and the toast `Kept local transform` is shown.
  - The instance keeps its id. Index adjustments account for removal before insertion in the same parent.
- **Ctrl held at drop:** inserts a **linked copy** (new instance, same def, world-preserved xf) and leaves the original where it is.
- **Library payload:** adds an instance at `IDENTITY_XF` at the drop position.
- Dropping into, or moving out of, a group with more than one occurrence shows the linked toast. One undo step: `Move Bolt` or `Copy Bolt`.

### 4.9 Gizmo (`three/addons/controls/TransformControls.js`)
- `scene.add(gizmo.getHelper())`. The controls themselves are not an Object3D **[verified]**.
- **Attach** to the selected occurrence's Object3D only when all of these hold: `viewMode === 'context'`, the selection is an occurrence, and it is not hidden. Otherwise detach.
- **W, E and R** set translate, rotate and scale. **Q** toggles world/local (three forces local for scale).
- **Snap** (X, or the toolbar button) defaults to on:
  - `setTranslationSnap(1)`, `setRotationSnap(degToRad(15))`, `setScaleSnap(0.1)`.
  - Holding **Ctrl** during a drag clears the snaps; they are restored on Ctrl keyup.
- **`dragging-changed`:** `orbit.enabled = !e.value` **[verified]**.
- **`objectChange` (live, no store commit, no worker):** copy the dragged Object3D's local position, quaternion and scale onto **every other Object3D with the same `userData.instanceId`**. All linked copies move together, live. Boolean ancestors keep their stale result and are re-evaluated on commit.
- **`dragging-changed → false` (commit):**
  1. Read the local `position`, `rotation` (order `ZYX`, converted to degrees) and `scale`.
  2. Round each to 1e-4. Replace `-0` with 0.
  3. Run `store.update('Move'|'Rotate'|'Scale' + ' ' + name, d => setTransform(d, instanceId, xf))`.

  One drag is one undo step. If the change touched a linked def, show the linked toast.
- **Inspector Transform fields** are 9 `<input type=number>`: t (step 1), r (step 15), s (step 0.1). Each commits on `change` with `coalesce: 'xf:' + instanceId + ':' + field`. A scale of 0 is rejected. A "Reset" button applies `IDENTITY_XF`.

### 4.10 Parameters, overrides and color (inspector)
- **Occurrence of a code def:** one control per ParamDef.
  - `number` is a number input, plus a range slider when both `min` and `max` are set.
  - `boolean` is a checkbox. `choice` is a select.
  - Each control shows the effective value. Editing it sets `instance.params[name]`, the override, with `coalesce: 'param:' + instanceId + ':' + name` and a 500 ms window.
  - An overridden control shows a **●** and a **↺** button that removes the override.
  - Unknown override keys are listed as `stale override 'len' ✕`.
- **Definition section:**
  - **Parameter table editor:** each row has name, type, default, min, max, step, options (comma-separated) and ✕, with "+ Add parameter" at the end. Editing it changes `def.params`, which are the defaults. Invalid names show inline and are not committed.
  - **Group defs** have an op selector (`none`, `union`, `subtract`, `intersect`) instead of a parameter table.
- **Color:** `<input type=color>` plus "clear", for both the instance color and the def color. Color changes never re-evaluate, because they only swap materials.
- **Banner** when the def occurs more than once: `Definition shared by 8 copies — edits affect all`, followed by [Make unique].
- **Code editor** (CodeMirror 6, `basicSetup` + `javascript()` + `lintGutter()`):
  - **Switching defs** calls `view.setState(EditorState.create({ doc, extensions }))`, which gives a fresh history.
  - **Commit:** an `updateListener` debounces by 400 ms and then runs `store.update('Edit code', d => setCode(d, defId, text), { coalesce: 'code:' + defId, window: 2000 })`.
  - **Ctrl+Enter** commits immediately and calls `client.retry(keysOfDef)`.
  - **External code changes** (undo, rename): if the store's code differs from the editor doc and no debounce is pending, call `setState`.
  - **Diagnostics** use `setDiagnostics` from `@codemirror/lint`, built from the def's `EvalError` (line → `doc.line(n)`).
  - **Status line:** `✓ 18 ms · 4,382 triangles`, or the error message.

### 4.11 Hide
- **H, or the eye icon,** toggles `instance.hidden`. It is undoable.
- **Alt+H, or "Unhide all" in the tree header,** clears every `hidden`. One step.
- Hidden rows are dimmed. Hidden instances are excluded from render, booleans, `part()` and STL.

### 4.12 Undo and redo
- **Mechanism:** `store.update(label, recipe, opts)`.
  1. `draft = structuredClone(project)`, then `recipe(draft)`. If it throws `OpError`, show a toast and change nothing.
  2. Otherwise push `{label, before: project, coalesce, at}` to `past`, set `project = draft` and clear `future`.
  - **Coalescing:** if `opts.coalesce` equals the top entry's key and `now - top.at < (opts.window ?? 500)`, replace the current state without pushing a new entry, and refresh `at`.
  - The cap is 200 entries.
- **Keys:** Ctrl+Z undoes; Ctrl+Shift+Z or Ctrl+Y redoes. The toolbar buttons show `Undo Move Bolt` as a tooltip.
- **In the code editor**, Ctrl+Z belongs to CodeMirror.
- **Not in history:** selection, context, view mode, expanded rows and the camera.
- **After every undo or redo, and after every update,** `fixSelection()` runs:
  - An occurrence path is cut to its longest valid prefix, or becomes none.
  - A def selection becomes none if the def no longer exists.
  - The context is cut the same way.

### 4.13 Shortcuts
They are ignored while focus is in an input, textarea, select or CodeMirror, **except** Ctrl+Enter, Ctrl+S and Esc (Esc blurs the editor). Every handled key calls `preventDefault()`, which also overrides Chrome's Ctrl+D, Ctrl+S and Ctrl+O.

| Key | Action | Key | Action |
|---|---|---|---|
| Ctrl+D | linked instance | Ctrl+Shift+D | unique duplicate |
| Ctrl+C / Ctrl+V / Ctrl+Shift+V | copy / paste linked / paste unique | U | make unique |
| Del, Backspace | delete (§4.6) | F2 | rename |
| H / Alt+H | hide toggle / unhide all | Ctrl+G / Ctrl+Shift+G | wrap in group / ungroup |
| W / E / R | move / rotate / scale | Q | world/local |
| X | snap on/off | G | ghost others |
| I | isolate toggle | F / Home | frame selection / all |
| 1 / 3 / 7 | front / right / top | Enter / Esc | enter group / exit, deselect |
| Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y | undo / redo | Ctrl+S / Ctrl+O | save / open |
| Ctrl+Enter | run now (also inside the editor) | | |

---

## 5. Evaluation pipeline

### 5.1 Expansion (`core/graph.ts`, pure)
`expand(project, { rootDef?, rootParams? }) → Occurrence[]` walks the instances depth-first, starting at the root's children. Isolate mode starts from a synthetic identity instance of `rootDef`.

```ts
interface Occurrence {
  key: string                 // path.join('/')
  path: InstancePath; parentKey: string   // '' = top level
  instance: Instance; def: Definition
  role: 'code' | 'group' | 'bool'
  hidden: boolean             // effective: true if it or any ancestor is hidden
  operandOf?: string          // key of the nearest boolean ancestor
  world: Mat4                 // parentWorld · toMatrix(xf)
  params: Record<string, ParamValue>   // resolveParams(def, instance.params); {} for groups
  colorFromInstance?: string  // outermost instance color on the path
}
```
Caps: path depth 32 and 5,000 occurrences. Past either cap, expansion stops and a one-time warning toast is shown.

### 5.2 Specs and keys (`core/evalspec.ts`, `core/hash.ts`, `core/params.ts`; shared by both threads)
```ts
export const ENGINE = 'jscad-2.13.0/e1'
interface CodeSpec  { kind: 'code';  defKey: string; def: Id; name: string; code: string; paramDefs: ParamDef[]; deps: Record<string /*literal name*/, DefSpec> }
interface GroupSpec { kind: 'group'; defKey: string; def: Id; name: string; op: GroupOp; children: ChildSpec[] }  // visible children only
interface ChildSpec { spec: DefSpec; params: Record<string, ParamValue>; matrix: Mat4 }
type DefSpec = CodeSpec | GroupSpec
interface Job { resultKey: string; spec: DefSpec; params: Record<string, ParamValue> }
```

**Hashing**
- `stableStringify` sorts object keys and omits `undefined`, maps `-0` to 0, and rounds matrix entries to 1e-9.
- `hash(x)` is `'k' + cyrb53(s, 1).toString(16) + cyrb53(s, 2).toString(16)`, where `s = stableStringify(x)`.

**Keys**
| Spec | Key |
|---|---|
| CodeSpec | `defKey = hash(['code', ENGINE, code, paramDefs.map(p => [p.name, p.type, p.default]), sortedDeps.map(([n, s]) => [n, s.defKey])])` |
| GroupSpec | `defKey = hash(['group', ENGINE, op, children.map(c => [c.spec.defKey, c.params, c.matrix])])` |
| Result | `resultKey = hash([defKey, resolvedParams])` |

Names and colors are not in any key, and neither are a group's own label or color. A code key changes when a dependency changes, which gives Merkle invalidation. Linked copies with the same params share one key.

**`buildSpecs(project)`** memoizes `DefSpec` per def id within one build, so a DAG is never expanded twice. It runs a DFS with a stack.
- A def already on the stack throws `CycleError`. Its message is `Cycle: Bolt → Bolt sizes → Bolt`, built from def names.
- `staticRefs` naming a def that does not exist produces `Unknown part "Nut" — no definition with that name`.
- Either error is recorded in `specErrors: Map<defId, EvalError>` (kind `cycle` or `dependency`). The def and its dependents get no job.

**Wanted jobs**
- Each non-hidden `code` or `bool` occurrence not under a boolean.
- Operand occurrences, only while they are shown (§4.4).
- The isolate target. Isolating a code def or a boolean group gives one job. Isolating a `none` group uses `expand(project, { rootDef })`, and its contents follow these same rules.
- Top-level `none` groups are never evaluated; three composes them.

### 5.3 Worker protocol (`src/eval/protocol.ts`, exact)
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
Results are posted with transferables: `postMessage(msg, meshes.flatMap(m => [m.positions.buffer, m.normals.buffer]))`. STL parts transfer their ArrayBuffers too.

### 5.4 Worker (`eval/worker.ts` is a thin shell around `eval/engine.ts`)
`engine.ts` is pure. It imports `jscad` (default import **[verified]** under Vite and vitest), `@jscad/stl-serializer`, `core/hash`, `core/params` and `core/transform`. It runs in Node for the unit tests.

```ts
export function createEngine(): {
  lineOffset: number
  evaluate(spec: DefSpec, params: Record<string, ParamValue>): Geom3[]   // throws EvalFailure
  run(job: Job): { meshes: MeshData[]; tris: number; warnings: string[] }   // evaluate + validate + toMeshes
  stl(items: { job: Job; matrix: Mat4 }[]): { parts: ArrayBuffer[]; tris: number }
  stats(): { compiled: number; memo: number; hits: number; misses: number }
}
```

**Compile.** `compiled: Map<code, Function>`, LRU of 100.

**Evaluate a code spec**
1. `key = hash([defKey, params])`. On a memo hit, return it (`results`: LRU of 200 entries, `Map<key, Geom3[]>`).
2. Push onto the eval stack. If it is deeper than 64, throw a cycle error.
3. Call the compiled function with `params` (frozen), `part` (bound to `spec.deps`), `jscad`, the seeded `Math`, the shadows and the flattened values.
4. Flatten the result, filter and validate it, and store it in the memo.

**Evaluate a group spec**
- Each child is `transform(child.matrix, …evaluate(child.spec, child.params))` (jscad `transforms.transform(mat, geom)`).
- `none`: concatenate.
- `union`: `union(all)`.
- `subtract`: `subtract(unionIfMany(child0), ...restFlattened)`. An empty child 0 gives `[]` and the warning `subtract: first child is empty`.
- `intersect`: `intersect(...children.map(unionIfMany))`.

Negative-scale matrices keep outward normals, because `poly3.transform` reverses winding when mirroring **[verified]**.

**Errors.** Each exception is wrapped once, at the innermost code def, into `EvalFailure`, which carries `{kind, def, defName, message, line, col, trace}`. It is then rethrown unchanged through outer `part()` calls. When the job's root def differs from `error.def`, the client also gives the root def `{kind: 'dependency', message: 'depends on "Bolt" (failed)'}`.

**toMeshes.** Use the verified `geom3ToArrays` (toPolygons → fan triangulation → `poly3.plane` normals), then add `bbox`.

**STL.** For each item, `transform(item.matrix, evaluate(...))`. Then `stl.serialize({ binary: true }, ...geoms)`. Solids are not unioned.

**Worker shell**
- On load: create the engine and post `{type: 'ready', lineOffset, flatNames}`.
- `onmessage`: handle `eval` or `stl` inside try/catch and post the result. Requests are processed **one at a time**; the client never sends a second before the first answers.

### 5.5 Client (`eval/client.ts` + `eval/mesh-cache.ts`, main thread)
```ts
class EvalClient {
  constructor(opts: { timeoutMs: number /*20000; ?evalTimeout=ms overrides*/; spawn: () => Worker })
  want(jobs: Job[], priorityKeys: Set<string>): void          // replaces the wanted set
  get(resultKey: string): { state: 'ready'; entry: MeshEntry } | { state: 'pending' } | { state: 'failed'; error: EvalError } | undefined
  retry(resultKeys: string[]): void                           // forget failures, re-queue
  exportStl(items: { job: Job; matrix: Mat4 }[]): Promise<{ parts: ArrayBuffer[]; tris: number }>  // timeout 60 s
  onChange(cb: (keys: string[]) => void): void                // results arrived or failed
  onStatus(cb: (s: { queued: number; running?: { defName: string; ms: number }; last?: { defName: string; ms: number }; alive: boolean }) => void): void
  idle(): Promise<void>                                       // queue empty and nothing in flight
}
interface MeshEntry { geometries: THREE.BufferGeometry[]; baked: (THREE.Color | null)[]; tris: number; bbox: THREE.Box3; edges?: THREE.BufferGeometry[] /* lazy */ }
```

**Queue**
- The queue is FIFO, de-duplicated by `resultKey`.
- `priorityKeys` (jobs of the selected def or the selected subtree) move to the front.
- Before each send, queued keys that are no longer wanted are dropped.
- One job is in flight at a time.

**Mesh cache**
- `Map<resultKey, MeshEntry>`. A `MeshData` becomes a `BufferGeometry` (position + normal attributes, `computeBoundingSphere`).
- Baked colors are converted with `color.setRGB(r, g, b, THREE.SRGBColorSpace)`.
- Entries no current occurrence references are evicted LRU beyond 300 entries, and their geometries disposed.
- The cache survives worker respawns.

**Failure memo.** `Map<resultKey, EvalError>`. A failed key is **never retried until its content changes** (a new key) or `retry()` is called (Ctrl+Enter).

**Timeouts, kills and respawn**
| Event | Handling |
|---|---|
| In-flight job passes `timeoutMs` | `terminate()`. Record the failure `{kind: 'timeout', message: 'Timed out after 20 s (infinite loop or very slow boolean?)'}`. Respawn. Continue the queue. |
| In-flight key no longer wanted, running for more than 1 s | Terminate and respawn **without** recording a failure. This lets a user fix a `while(true)` they just typed without waiting 20 s. |
| `worker.onerror` or `onmessageerror` | Fatal. Mark the in-flight key `{kind: 'crash'}` and respawn. |
| Before `ready` | Retry the spawn up to 3 times with a 500 ms back-off. |
| 3 crashes within 10 s | Stop. The status bar shows `Evaluator keeps crashing — reload the page`. |
| A new worker | Waits for `ready` before it receives jobs. Specs are self-contained, so a cold memo only costs time and never gives wrong results. |

**Def status** (tree dot, `data-status`): `error` if any wanted job of the def failed, or any failure names it as `error.def`, or `specErrors` has it. Otherwise `pending` if any of its jobs is queued or in flight. Otherwise `ok`. A group row shows the worst status in its subtree.

**When evaluation runs:** after every committed project change (code is already debounced 400 ms), and on a selection change, for priority. It is skipped entirely while `evalPaused`.

### 5.6 Scene sync (`view/scene-sync.ts`)
`reconcile(occurrences, client, ui)` keeps a `Map<occKey, THREE.Group>`. The Object3D hierarchy mirrors the instance hierarchy exactly, so a gizmo's local TRS *is* `Instance.xf`.
- Each occurrence Group gets `position = t`, `rotation.set(rx, ry, rz, 'ZYX')` (radians) and `scale = s`. The Group being dragged is skipped. `userData` is `{ path, instanceId, defId, role }`.
- **Code occurrence:** one `Mesh` per entry geometry, **shared** across all occurrences with the same key. Each mesh's `userData.path` is the occurrence path.
- **Bool occurrence:** a `result` child holding the result meshes. Its operand subtrees are child Groups that are visible only when shown (§4.4).
- **Materials** come from `view/materials.ts`, cached by `(color, state)`. The states are `normal`, `selected`, `linked`, `ghost`, `ghostLinked`, `stale`, `error`, `operandBase`, `operandCut` and `operandOther`. The base is `MeshStandardMaterial({ metalness: 0.1, roughness: 0.7 })`.
- **A key that is pending or failed** shows the occurrence's **last good entry**, remembered per occurrence key:
  - **pending:** `stale` (opacity 0.6)
  - **failed:** `error` (red emissive 0.4)

  With no last good entry, it shows nothing. The viewport never blanks while you type.
- **Removed keys** are detached. Geometries are not disposed here; the mesh cache owns them.

---

## 6. Persistence and I/O
- **Autosave**
  - **When:** 1 s after the last commit.
  - **Where:** `localStorage['3dica:v1:current'] = JSON.stringify({ savedAt, project })`.
  - **Backups:** if the last backup is more than 60 s old, first copy the previous `current` to `3dica:v1:backup:<n % 5>`.
  - **UI preferences** go to `3dica:v1:ui`: expanded rows, gizmo mode and space, snap, ghost and the camera.
  - Every access is wrapped in try/catch. A failure shows one toast `Autosave unavailable`.
- **Boot**
  1. `?fresh` in the URL loads the sample (used by tests).
  2. Otherwise try `current`, then backups from newest to oldest, each through `parseProject`.
  3. Otherwise load the sample.
  4. A restore from a backup shows a toast.
- **Save** (Ctrl+S, or the button) downloads `<project.name>.3dica.json`.
- **Open** (Ctrl+O, or the button) uses a hidden `<input type=file accept=".json">` or a file dropped on the window.
  - Parse errors open a `<dialog>` that lists every problem, and the current project is untouched.
  - On success, if the file contains any code def, a dialog says `This file contains code that runs on your computer. Run it?` and offers **[Run code]** and **[Open without running]**. The second sets `evalPaused` and shows the **Run code** toolbar button.
  - The undo history is reset on open.
- **New:** confirm, then load `{root only, name 'Untitled'}`. **Sample:** confirm, then load the sample.
- **Export STL**
  - **Items:**
    - With an occurrence selected, the selected occurrence: its def's job, with `matrix = occurrence.world`.
    - Otherwise, every visible top-level instance, with world matrices.
    - Group defs are flattened through GroupSpec.
  - **Output:** the worker serializes binary STL. The file `<project.name>-<selection name | 'scene'>.stl` is downloaded via a Blob (`type: 'model/stl'`) and an `<a download>` click.
  - **Empty:** toast `Nothing to export`.

---

## 7. File and module layout
```
3Dica/
  index.html                  #app grid: #toolbar #left(#tree,#library) #view #inspector #status
  package.json  package-lock.json  tsconfig.json  vite.config.ts  playwright.config.ts  .gitignore
  src/
    main.ts                   boot: load project → Store → EvalClient → Viewport → panels; subscribe loop; window.__3dica
    styles.css                dark theme CSS variables, grid layout, rows, toasts, dialogs
    core/                     PURE (no DOM, three or Worker; three only in tests). Unit-tested.
      types.ts                §2.1
      ids.ts                  newId('d'|'i') = prefix + '_' + 10 base36 chars (crypto.getRandomValues); uniqueName(base, taken)
      transform.ts            toMatrix(xf), fromMatrix(m) → Transform | null (ZYX decompose, sign from det, null on shear > 1e-6), mul, invert, roundXf
      graph.ts                staticRefs, referrers, instancesOf(defId), occurrenceCount, wouldCycle, findCycle, resolvePath, worldMatrix, expand
      params.ts               resolveParams(def, overrides), isValidParamValue
      ops.ts                  draft-mutating ops, throw OpError (list below)
      hash.ts                 stableStringify, cyrb53, hash
      evalspec.ts             buildSpecs(project) → { specOf(defId), jobFor(defId, params), specErrors }
      project-io.ts           serialize, parseProject (migrate → validate) → { ok, project } | { ok: false, problems: string[] }
      templates.ts            TEMPLATES, PALETTE, BLANK_CODE_HEADER
      sample.ts               sampleProject()
    state/
      store.ts                Store (§4.12): project, ui, update, undo, redo, setUi, subscribe, fixSelection
      history.ts              past/future, coalescing, cap 200
      autosave.ts             debounce, ring, boot restore
      clipboard.ts            in-memory clipboard
    eval/
      protocol.ts             §5.3
      engine.ts               §5.4 (pure, runs in Node)
      worker.ts               /// <reference lib="webworker" />, shell around engine
      client.ts               §5.5
      mesh-cache.ts           MeshEntry map, LRU, dispose, edges
    view/
      viewport.ts             renderer, camera, orbit, grid, lights, resize, loop, frame(), tween, view presets, objectPixels()
      scene-sync.ts           §5.6
      materials.ts            material cache
      picking.ts              pointer → path rules (§4.3)
      gizmo.ts                TransformControls wrapper (§4.9)
    ui/
      dom.ts                  h() element helper, toast(), confirmDialog(), problemsDialog()
      toolbar.ts  tree.ts  library.ts  inspector.ts  param-editor.ts  code-editor.ts  breadcrumb.ts  statusbar.ts  shortcuts.ts
    io/files.ts               downloadBlob, pickFile, window drop
    types/stl-serializer.d.ts the verified shim
  tests/
    unit/*.test.ts            vitest (node environment)
    e2e/app.spec.ts           Playwright
```

**`core/ops.ts`** (each one is `(draft: Project, …) => result`, and throws `OpError(message)`):
- `addDef(d, def)`
- `addInstance(d, parentDefId, index, inst)`
- `duplicateLinked(d, path, dx) → newPath`
- `duplicateUnique(d, path, dx) → newPath`
- `cloneDef(d, defId) → newDefId`
- `makeUnique(d, path)`
- `pasteInstance(d, contextPath, clip, unique, dx) → newPath`
- `moveInstance(d, fromPath, toParentPath, index, { copy }) → newPath` (world-preserving)
- `removeInstance(d, path)`
- `deleteDefinition(d, defId)` (cascade; throws if it has referrers)
- `purgeUnused(d) → count`
- `renameDef(d, defId, newName)` (rewrites `part()` refs)
- `setInstanceLabel`
- `setTransform(d, instanceId, xf)`
- `setOverride(d, instanceId, name, value | undefined)`
- `setColor(d, target: { instance: Id } | { def: Id }, color | undefined)`
- `setHidden`
- `unhideAll`
- `setCode(d, defId, code)`
- `setParamDefs(d, defId, params)`
- `setGroupOp(d, defId, op)`
- `wrapInGroup(d, path, op) → newPath`
- `ungroup(d, path) → newPaths`

Every op that adds a child calls `wouldCycle` first.

**Panels** are plain TS with no framework. Each exports `mount(el, store, deps)` and re-renders in its store subscription. The inspector rebuilds on selection change and **patches values** on project change, so a focused input keeps focus. The tree re-renders rows keyed by `data-path` and preserves scroll.

---

## 8. Dependencies, configuration, scripts

### 8.1 `package.json` (exact versions, no `^`)
```json
{
  "name": "3dica", "version": "0.1.0", "private": true, "type": "module",
  "engines": { "node": ">=20.19.0" },
  "scripts": {
    "dev": "vite",
    "build": "tsc -p . && vite build",
    "preview": "vite preview --port 4173 --strictPort",
    "typecheck": "tsc -p .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "test:e2e:preview": "npm run build && PW_PREVIEW=1 playwright test",
    "test:all": "npm run typecheck && npm test && npm run test:e2e"
  },
  "dependencies": {
    "three": "0.187.0",
    "@jscad/modeling": "2.13.0",
    "@jscad/stl-serializer": "2.1.23",
    "codemirror": "6.0.2",
    "@codemirror/lang-javascript": "6.2.5",
    "@codemirror/state": "6.7.6",
    "@codemirror/view": "6.43.15",
    "@codemirror/lint": "6.9.7",
    "@codemirror/language": "6.13.1"
  },
  "devDependencies": {
    "vite": "8.3.8",
    "typescript": "7.0.2",
    "@types/three": "0.187.0",
    "@playwright/test": "1.62.1",
    "vitest": "4.1.12"
  }
}
```

Notes on the pins:
- **`@codemirror/lint` and `@codemirror/language`** are the versions already deduplicated in the verified install tree (`npm ls`). They are pinned because the app imports them directly.
- **`vitest` 4.1.12** (published 2026-10-15) was **[verified]** with Node 20.19.6, a single deduplicated vite 8.3.8, the `vitest/config` `defineConfig` call, and type-checking with tsc 7. **Do not use vitest 5.x**; it requires Node ≥ 22.12.
- **`@playwright/test` 1.62.1** expects its own Chromium build. Keep it pinned, and upgrade it only together with its browser (`npx playwright install chromium`).

**Install:** `npm ci`, then `npx playwright install chromium` once per machine for the e2e tests.
**`.gitignore`:** `node_modules dist test-results playwright-report` (the repository's `.gitignore` now lists more).

### 8.2 `vite.config.ts`
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  base: './',
  optimizeDeps: { include: ['@jscad/modeling', '@jscad/stl-serializer'] }, // worker-only deps found late on a cold start; this fixes the hung first request [verified]
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 1500 },  // three + CodeMirror are expected to be > 500 kB
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
})
```
Vite 8 uses `build.rolldownOptions`, not `rollupOptions`, if one is ever needed.
Create the worker with `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.

### 8.3 `tsconfig.json`
This is the config verified during the tech-stack check, plus `"strict": true`. `lib ["ES2023","DOM"]`, `types ["vite/client"]`, `moduleResolution "bundler"`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `skipLibCheck`, `noEmit`, `allowImportingTsExtensions`, `noUnusedLocals`, `noUnusedParameters`, and `"include": ["src", "tests/unit"]`.

Do not use TS `enum` or parameter properties (`erasableSyntaxOnly`).

The e2e tests and the config files are not type-checked, because they would need `@types/node`, which is not pinned. Playwright transpiles them itself.

### 8.4 `playwright.config.ts`
```ts
import { defineConfig, devices } from '@playwright/test'
const preview = process.env.PW_PREVIEW === '1'
const port = preview ? 4173 : 5173
export default defineConfig({
  testDir: 'tests/e2e', timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, fullyParallel: false,
  use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${port}`, viewport: { width: 1440, height: 900 }, acceptDownloads: true },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],   // Playwright's own Chromium / headless shell; no `channel`
  webServer: { command: preview ? `npx vite preview --port ${port} --strictPort` : `npx vite --port ${port} --strictPort`,
               url: `http://localhost:${port}`, reuseExistingServer: false, timeout: 60_000 },
})
```

---

## 9. Test plan

### 9.1 Test API (`window.__3dica`, always installed by `main.ts`)
```ts
interface TestApi {
  ready: boolean                                  // true after boot + first reconcile
  idle(): Promise<void>                           // client.idle(), then reconcile, then 2 animation frames
  project(): Project                              // structuredClone
  ui(): Pick<UiState, 'selection' | 'context' | 'viewMode' | 'ghostOthers' | 'gizmoMode' | 'snap'>
  stats(): { occurrences: number; meshes: number; geometries: number /* mesh-cache entries in use */; triangles: number; pending: number; failed: number }
  occurrencesOf(defName: string): number
  defStatus(defName: string): 'idle' | 'pending' | 'ok' | 'error'
  defError(defName: string): EvalError | undefined
  objectPixels(): number                          // hide grid/axes/gizmo, render, gl.readPixels the whole canvas, count px differing from #1f2329 by > 12 in any channel, restore
  gizmoAxisScreen(axis: 'X' | 'Y' | 'Z', along: number): { x: number; y: number }   // screen point `along` mm from the attached object's world position
  history(): { past: string[]; future: string[] }
}
```
URL parameters: `?fresh` (load the sample and ignore autosave) and `?evalTimeout=<ms>`.

### 9.2 Unit tests: vitest, `tests/unit/` (node environment)
- **`transform.test.ts`**
  - For 50 random TRS values (including a negative scale), `toMatrix(xf)` equals three's `Matrix4.compose(t, quat(Euler(r·D,'ZYX')), s).elements` to 1e-9. It also equals the jscad product `T·fromTaitBryanRotation(rz, ry, rx)·S`.
  - jscad `rotate([x,y,z])` applied to a point equals `toMatrix` applied to it.
  - `fromMatrix(toMatrix(xf))` round-trips for |ry| < 89°, and gimbal lock (ry = ±90°) gives `rx = 0`.
  - `fromMatrix` returns `null` for a sheared matrix.
- **`graph.test.ts`**
  - `staticRefs` handles quotes, spaces and duplicates, and ignores `part(name)` with a variable.
  - `wouldCycle`: a group into itself, A⊃B then B into A, and a `part()` edge (Leg code references Table, Table contains Leg).
  - `occurrenceCount` on the sample: Bolt 8, Washer 8, Plate 2, Disc 8.
  - `expand` resolves the outermost-instance color, propagates `hidden`, sets `operandOf`, and enforces the caps.
  - `worldMatrix` of `[i_fx2, i_b1]` puts it at the expected world xy.
- **`ops.test.ts`**
  - `duplicateLinked`: same def, new id, inserted after the original, offset applied.
  - `duplicateUnique`: new def `Fixture 2`, children get new instance ids but the same child defs (shallow).
  - `makeUnique`: refused when there is a single record.
  - `pasteInstance`: refused on a cycle.
  - `moveInstance`: preserves world position across a rotated parent, Ctrl-copy keeps the original, the index is correct when reordering within the same parent, and a move into a descendant is refused.
  - `removeInstance`: keeps the def.
  - `deleteDefinition`: refused when referenced by `part()`; otherwise it cascades and removes all instances.
  - `purgeUnused`: reaches a fixpoint.
  - `renameDef`: rewrites `part('Bolt'` and `part("Bolt"`, and rejects a duplicate, a name containing a quote, and `Scene`.
  - `wrapInGroup` and `ungroup`: world positions are unchanged.
  - Every op keeps the §2.2 invariants. Run `validate` after each one.
- **`project-io.test.ts`**
  - The sample survives `serialize → parse` deep-equal.
  - These are rejected with readable problems: a wrong `format`; `version: 2`; a dangling `def`; a duplicate instance id; a duplicate def name; a cycle; a zero scale.
  - `serialize` key order is stable.
- **`evalspec.test.ts`**
  - Keys are stable across two builds.
  - Linked occurrences share a `resultKey`, and an override gives a different key.
  - Editing Bolt code changes the Bolt key and the "Bolt sizes" key (Merkle), but not the Plate key.
  - A color, label or name change leaves keys unchanged.
  - Moving the Washer's Hole changes the Washer `defKey`.
  - A `part()` cycle and an unknown name each go into `specErrors` and produce no job.
- **`engine.test.ts`** (real jscad in Node)
  - Every sample job evaluates to more than 0 triangles.
  - `part('Bolt', {length: 20})` gives a shank 20 long (bbox z min = −20).
  - Error cases:
    - `part('Nope')` → runtime error naming the def.
    - A non-literal name → error.
    - `null.x` on user line 3 → `line === 3`, kind `runtime`.
    - `return (` → kind `syntax`.
    - Returning `circle()` → the 2D error.
    - Returning `[]` → ok with a warning.
  - Nested failure: Bolt throws, and "Bolt sizes" fails with `error.def === d_bolt` and `trace ['Bolt sizes','Bolt']`.
  - `Math.random` is deterministic for the same key.
  - The memo hits on a second `run` (`stats().hits` increases).
  - Depth over 64 throws.
  - Subtract of a group whose child 0 has two geoms unions them first.
  - STL output size equals `84 + 50·n`, where n is read from bytes 80..83.
- **`history.test.ts`**
  - undo and redo; redo is cleared after a new update.
  - Coalescing inside and outside the window, and the 2 s code window.
  - The cap of 200.
  - `fixSelection` truncates a path after undoing an add.

### 9.3 E2E: Playwright `tests/e2e/app.spec.ts` (Chromium; `npm run test:e2e`)
Each test:
- runs `page.goto('/?fresh')`
- waits with `waitForFunction(() => window.__3dica?.ready)` and then `evaluate(() => __3dica.idle())`
- collects `pageerror` and `console` messages of type `error`, and asserts there are none at the end. "GPU stall due to ReadPixels" is a warning, so it is ignored.

1. **Boot renders.**
   - The tree shows rows for `i_fx1`, `i_fx2` and `i_bs`.
   - The Library has Bolt, Plate, Washer, Disc, Hole, Fixture and Bolt sizes.
   - `objectPixels() > 5000`.
   - Bolt, Plate, Washer and Bolt sizes have status `ok`. No def is `error` or `pending`. Disc, Hole and Fixture are `idle`, because hidden operands and `none` groups have no jobs.
   - `stats().geometries === 4`.
2. **Click selects and isolates.**
   - Click `[data-path="i_fx1/i_plate"]`. The UI selection is that path, the inspector shows "Plate", and `.cm-content` contains `roundedCuboid`.
   - Press `I`. `viewMode === 'isolate'` and `objectPixels() > 2000`.
   - Press `Escape`. The mode is back to `context`.
   - Click the Library row "Bolt". The mode is `isolate` and the editor contains `extrudeLinear`.
3. **Linked instance, unique duplicate, copy and paste.**
   - Click `[data-path="i_fx1"]`, then press `Control+D`. `occurrencesOf('Fixture') === 3`, `occurrencesOf('Bolt') === 12`, and **`stats().geometries` is still 4**.
   - Press `Control+Shift+D`. A Library row "Fixture 2" exists, and `occurrencesOf('Bolt') === 16`.
   - Click `[data-path="i_bs"]`, then press `Control+C` and `Control+V`. `occurrencesOf('Bolt sizes') === 2`.
   - Press `Control+Z` once. Bolt sizes is back to 1.
4. **Editing code updates linked copies, and errors keep the mesh.**
   - Click `[data-path="i_fx1/i_b1"]` and record `stats().triangles`.
   - Click `.cm-content`, press `Control+A`, then `keyboard.insertText(boltCode.replace('segments: 6', 'segments: 8'))`.
   - After `idle()`: the Bolt def code contains `segments: 8`, and triangles have changed.
   - Insert `throw new Error("boom")` as the code. After `idle()` (wait for debounce plus result, using `expect.poll`):
     - `defStatus('Bolt') === 'error'`
     - `defError('Bolt').line === 1`
     - a tree row with `data-def="d_bolt"` has `data-status="error"`
     - `.cm-lint-marker-error` or `.cm-diagnostic` is visible
     - `objectPixels() > 5000`, because the last good mesh is still shown
     - `defStatus('Bolt sizes') === 'error'`, as a dependency
   - `Control+Z` (with focus outside the editor) restores a status of `ok`.
5. **Gizmo drag is one undo step.**
   - Click `[data-path="i_bs"]` and press `w`.
   - Move to `gizmoAxisScreen('X', d)`, trying d = 4…12 until it moves. Then `mouse.down`, 10 moves of +8 px, `mouse.up`.
   - Afterwards `i_bs.xf.t[0] !== -24`, `history().past.at(-1)` starts with `Move`, and the value is a multiple of 1 (snap).
   - `Control+Z` restores −24.
6. **A runaway loop is contained** (`/?fresh&evalTimeout=1500`).
   - Click the add-code button, then set the code to `while (true) {}`.
   - Within 6 s, `defError('Object').kind === 'timeout'`.
   - Then click `[data-path="i_bs"]`, fill `[data-testid="param-count"]` with 3 and press Enter. After `idle()`, `defStatus('Bolt sizes') === 'ok'` and `project()` shows `i_bs.params.count === 3`. The worker respawned and the app is responsive.
7. **STL export.**
   - Press Escape to deselect. `const dl = page.waitForEvent('download')`, then click the `export-stl` button.
   - `(await dl).suggestedFilename()` ends with `.stl`.
   - Read it with `fs.readFileSync(await download.path())`. Then `n = buf.readUInt32LE(80)`, `buf.length === 84 + 50 * n` and `n > 10000`.
8. **Autosave restore.**
   - Rename "Bolt sizes" to "Rack" (F2, type, Enter).
   - Wait 1.5 s, then `page.goto('/')` (without `?fresh`).
   - The Library contains "Rack".

**Definition of done:** `npm run typecheck`, `npm test` and `npm run test:e2e` all pass, and `npm run test:e2e:preview` passes. The sample loads in under 3 s on a typical development machine.

---

## 10. Build order (checkpoints for a single session)
1. Scaffold: package.json, configs, index.html and the stl shim. `npm install`. The first two unit tests pass: `transform` and `hash`.
2. Core: types, ids, graph, params, ops, project-io, templates, sample. Unit tests green.
3. Eval: evalspec, engine (`engine.test.ts` green in Node), worker, client, mesh-cache.
4. View: viewport, scene-sync, materials. The sample renders (e2e test 1).
5. UI: store and history, tree, library, inspector with params, CodeMirror, toolbar, shortcuts, breadcrumb, status bar.
6. Interaction: picking with drill-down, isolate and ghost, framing, gizmo with the live linked preview, drag and drop.
7. I/O: autosave, open and save, STL. Then all e2e tests, then the preview run.

If time runs short, cut from the end of §4 in this order. These are the only allowed cuts:
1. numpad views
2. Purge unused
3. wrap/ungroup buttons (keep Ctrl+G)
4. the parameter **schema** editor (keep the override fields)

---

## 11. Out of scope for v0.1
- Multi-select, box select, a multi-object gizmo, and keyboard navigation in the tree (arrow keys).
- The system clipboard, and pasting between projects or browser tabs.
- Group parameters, parameters flowing from parent to child, and override expressions (`"=w/2"`).
- Array and pattern instances, and InstancedMesh.
- Per-node `! # % *` toggles beyond hide, ghost and isolate.
- "Enter definition" editing mode, and editing children while isolated.
- Live boolean re-evaluation during a drag (booleans re-evaluate on release).
- Drag from the Library into the viewport, snapping to surfaces or faces, a measuring tool, and section or clipping planes.
- Exporting a single `.jscad` or `.scad` file, OpenSCAD import or code parts (openscad-wasm), 3MF, OBJ, GLB, and colors in exports.
- The manifold-3d kernel, a worker pool, and a quality slider (`$fn`).
- A real sandbox for user code (iframe or opaque origin). Imported code is gated by a confirm prompt only.
- npm or ESM imports inside user code, shared helper libraries, a console output panel (`console.log` goes to devtools), and rendering 2D geometry.
- Multiple projects, IndexedDB, File System Access API saving, a git-friendly folder format, and per-object version history.
- Light theme, mobile or touch, Firefox and WebKit, and accessibility beyond basic focus handling and `aria-live` toasts.
- Collaboration and AI features.

## 12. Top risks and mitigations
1. **The preview and the STL disagree on transforms.**
   - One `core/transform.ts`, using `ZYX` everywhere. Unit tests compare it with three and with jscad.
   - STL uses `occurrence.world`, the same matrices the scene uses.
2. **Slow CSG and runaway code.**
   - Everything runs in the worker, with Merkle keys and a memo, the selection evaluated first, and the last good mesh kept on screen.
   - Kill and respawn with no retry loops. An abandoned job older than 1 s is killed.
   - Templates default to 32 segments.
3. **Linked edits surprise people.**
   - `◆N` badges, a purple tint on linked copies, a live linked preview while dragging, a shared-definition banner and toasts.
   - One-click Make Unique, and cheap undo.
4. **Name references break.**
   - Rename rewrites them, and delete is refused while they exist.
   - Only literal names are accepted, and the error message says so.
5. **The store and the scene drift apart, or work is lost.**
   - The scene comes only from `reconcile`; the gizmo mutates three objects only until the drag ends.
   - `fixSelection` runs after every update.
   - The autosave ring is validated on boot, and bad files never replace the current project.
