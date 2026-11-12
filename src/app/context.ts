// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE CROSS-LAYER CONTRACT. eval/, view/, ui/ and app/ code against these interfaces only.
// Spec references (§) point at docs/design/spec-v0.1.md. Pure logic already lives in core/ — use it instead of re-deriving:
//   core/graph.ts      expand (§5.1), Occurrence, pathKey, isPrefix, resolvePath, defAtPath, instanceAtPath,
//                      findInstance, worldMatrix, staticRefs, referrers, instancesOf, occurrenceCounts,
//                      wouldCycle, linkedChangeMessage ("Changed 'Fixture' — 2 copies updated"), ISOLATE_INSTANCE_ID
//   core/evalspec.ts   buildSpecs, makeJob, computeWantedJobs, isOccurrenceShown, computeDefStates,
//                      computeRowStatuses, computeStlItems, stlFileName, DefStatus, ENGINE
//   core/selection.ts  treeSelectPatch, librarySelectPatch, pickPatch, enterPatch, escapePatch, breadcrumbPath,
//                      breadcrumbPatch, shownOperandBools, isolateTarget, isolateLabel, isolateBanner
//   core/colors.ts     leafColor, boolColor, occurrenceColor, DEFAULT_COLOR (§2.4)
//   core/ops.ts        every project mutation (§7 list) + OpError, checkDefName, linkedOffset, normalizeColor
//   core/templates.ts  TEMPLATES, PALETTE, createTemplateDef, placementFor (§3.2, §4.2)
//   core/project-io.ts serialize, parseProject, emptyProject, hasCode (§2.3, §6)
//   core/transform.ts  toMatrix, fromMatrix, mul, invert, roundXf, Box, transformBox, unionBoxes
//   state/store.ts     Store (§4.12): project, ui, update, undo, redo, setUi, reset, subscribe, fixSelection
//   state/clipboard.ts Clipboard, clipFromPath;  state/autosave.ts Autosave (§6)
//
// Module ↔ export map (what each parallel team must export):
//   src/eval/client.ts      export class EvalClient implements EvalClientApi { constructor(opts: EvalClientOptions) }
//   src/eval/engine.ts      export function createEngine() (§5.4, exact)
//   src/eval/worker.ts      module worker shell (§5.4); created in src/main.ts (the URL is relative to the file
//                           that contains the expression) with
//                           new Worker(new URL('./eval/worker.ts', import.meta.url), { type: 'module' })
//   src/eval/mesh-cache.ts  internal to eval/
//   src/view/viewport.ts    export function createViewport(): ViewportApi          (CreateViewport)
//   src/app/commands.ts     export function createCommands(ctx: AppContext): Commands (CreateCommands)
//   src/app/controller.ts   export function createController(ctx: AppContext): ControllerApi (integrator)
//   src/ui/{toolbar,tree,library,inspector,breadcrumb,statusbar}.ts
//                           export const mount: MountPanel
//                           elements: #toolbar, #tree, #library, #inspector, #view (breadcrumb + isolate banner overlay), #status
//   src/ui/shortcuts.ts     export const install: InstallShortcuts
//   src/ui/dom.ts           export function h(...); export const toast: ToastFn; export const confirmDialog: ConfirmFn;
//                           export const problemsDialog: ProblemsFn
//   src/io/files.ts         the FilesApi functions as named exports (downloadBlob, pickFile, onWindowDrop)
//   src/main.ts             boot (integrator): Autosave.boot → Store → EvalClient → createViewport → createCommands →
//                           controller → panels → shortcuts → window.__3dica (TestApi)
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

import type * as THREE from 'three'
import type { GroupOp, Id, InstancePath, Mat4, ParamDef, ParamValue, Project, Transform, UiState, Vec3 } from '../core/types'
import type { Box } from '../core/transform'
import type { Occurrence } from '../core/graph'
import type { DefEvalState, DefStatus, Job, SpecSet, WantedJobs } from '../core/evalspec'
import type { PickMods } from '../core/selection'
import type { TemplateKind } from '../core/templates'
import type { EvalError } from '../eval/protocol'
import type { Store } from '../state/store'
import type { Clipboard } from '../state/clipboard'

export type { Box } from '../core/transform'
export type { Occurrence } from '../core/graph'
export type { DefEvalState, DefStatus, Job, SpecSet, WantedJobs } from '../core/evalspec'
export type { PickMods } from '../core/selection'
export type { TemplateKind } from '../core/templates'
export type { EvalError } from '../eval/protocol'

// ─────────────────────────────────────────── eval/ (§5.5) ───────────────────────────────────────────

/**
 * One evaluated result in the main-thread mesh cache (owned by eval/mesh-cache.ts), keyed by Job.resultKey.
 * Geometries are SHARED by every occurrence with the same key: view/ must never mutate or dispose them.
 */
export interface MeshEntry {
  /** one per MeshData: non-indexed 'position' + 'normal' attributes, computeBoundingSphere() done */
  geometries: THREE.BufferGeometry[]
  /** colorize() color per geometry, converted with color.setRGB(r, g, b, THREE.SRGBColorSpace); null if none */
  baked: (THREE.Color | null)[]
  tris: number
  /** def-local bbox (union of MeshData.bbox); an empty Box3 when there are no meshes */
  bbox: THREE.Box3
  /** lazy: view/ fills it on first need with new THREE.EdgesGeometry(g, 30) per geometry; mesh-cache disposes them with the entry */
  edges?: THREE.BufferGeometry[]
  /** worker time in ms (inspector status line "✓ 18 ms · 4,382 triangles") */
  ms: number
  /** e.g. 'Returned nothing', 'subtract: first child is empty' */
  warnings: string[]
}

export type ResultState =
  | { state: 'ready'; entry: MeshEntry }
  | { state: 'pending' }                 // queued or in flight
  | { state: 'failed'; error: EvalError } // failure memo (incl. timeout / crash)

/** §5.5 onStatus payload; also used by the status bar ("Evaluating 2 · last 60 ms (Plate)"). */
export interface EvalStatus {
  /** queued jobs, not counting the one in flight */
  queued: number
  running?: { defName: string; ms: number }
  last?: { defName: string; ms: number }
  /** a worker is up and has sent 'ready' */
  alive: boolean
  /** set after 3 crashes within 10 s: 'Evaluator keeps crashing — reload the page' (evaluation stops) */
  fatal?: string
}

/** For window.__3dica.stats() (§9.1) and debugging. */
export interface EvalClientStats {
  /** entries in the mesh cache */
  cacheEntries: number
  /** distinct resultKeys of the current wanted set that have a ready entry (TestApi stats().geometries) */
  entriesInUse: number
  queued: number
  /** 0 or 1 */
  inFlight: number
  /** wanted keys currently in the failure memo */
  failed: number
  /** workers created so far (1 after boot; +1 per respawn) */
  spawns: number
  crashes: number
}

export interface EvalClientOptions {
  /** 20000 by default; `?evalTimeout=<ms>` overrides (§9.1) */
  timeoutMs: number
  /** in src/main.ts: () => new Worker(new URL('./eval/worker.ts', import.meta.url), { type: 'module' })
   *  (keep the literal `new Worker(new URL(...))` form so Vite bundles the worker) */
  spawn: () => Worker
  /** STL export timeout, default 60000 */
  stlTimeoutMs?: number
}

/** The public surface of eval/client.ts `class EvalClient` (§5.5). */
export interface EvalClientApi {
  /**
   * Replace the wanted set. Queue = FIFO de-duplicated by resultKey; priorityKeys move to the front; queued keys no
   * longer wanted are dropped before each send; ready or failed keys are not re-queued (failures are never retried
   * until retry() or a new key). One job in flight at a time. An in-flight key that is no longer wanted and has run
   * > 1 s is terminated and the worker respawned without recording a failure. Calling with [] drops the queue.
   */
  want(jobs: Job[], priorityKeys: Set<string>): void
  /**
   * ready: in the mesh cache (wanted or not); failed: in the failure memo; pending: queued or in flight;
   * undefined: unknown (never wanted, or dropped from the queue). A failed error is stored as the worker sent it
   * (error.def = the innermost failing def; timeout / crash errors name the job's root def). The "depends on "Bolt"
   * (failed)" error for the job's root def is synthesized by core/evalspec computeDefStates, not by the client.
   */
  get(resultKey: string): ResultState | undefined
  /** Ctrl+Enter: forget failures of these keys and re-queue those that are still wanted. */
  retry(resultKeys: string[]): void
  /**
   * Serialize binary STL in the worker (timeout stlTimeoutMs). Waits for the in-flight job, jumps the queue.
   * Rejects with an Error whose message is user-readable (the EvalError message) on failure or timeout.
   */
  exportStl(items: { job: Job; matrix: Mat4 }[]): Promise<{ parts: ArrayBuffer[]; tris: number }>
  /** Results arrived or failed (keys changed state). Returns an unsubscribe function. */
  onChange(cb: (keys: string[]) => void): () => void
  /** Queue / worker status changes (also fired while a job runs, at least every 250 ms). Returns unsubscribe. */
  onStatus(cb: (s: EvalStatus) => void): () => void
  /** Latest status snapshot. */
  status(): EvalStatus
  /** Resolves when the queue is empty and nothing is in flight (immediately if already idle). */
  idle(): Promise<void>
  /**
   * Keys the view currently displays, including last-good fallbacks (§5.6). The mesh cache never evicts
   * wanted ∪ in-use keys; others are evicted LRU beyond 300 entries and their geometries disposed.
   */
  setInUse(keys: Iterable<string>): void
  stats(): EvalClientStats
  /** terminate the worker, drop timers and listeners */
  dispose(): void
}

export type CreateEvalClient = (opts: EvalClientOptions) => EvalClientApi

// ─────────────────────────────────────────── controller → view ───────────────────────────────────────────

/** What isolate mode shows (§4.4): a separate isolateRoot built from these occurrences, at the origin. */
export interface IsolateView {
  defId: Id
  /** the selected occurrence's overrides; undefined for a Library (def) selection = defaults */
  params?: Record<string, ParamValue>
  /** expand(project, { rootDef: defId, rootParams: params }): paths start with ISOLATE_INSTANCE_ID ('~iso') */
  occurrences: Occurrence[]
  /** isolateBanner(): "Isolated: Bolt (length 12, diameter 5) — I or Esc to return" */
  banner: string
}

/**
 * Everything one controller pass computed. Passed to viewport.reconcile() and emitted as the 'render' event.
 * Treat as immutable. A new object is produced on every pass; unchanged parts may be shared with the previous pass.
 */
export interface RenderState {
  /** increments every pass */
  version: number
  project: Project
  ui: UiState
  /** scene expansion (always computed, also while isolated) — §5.1 */
  occurrences: Occurrence[]
  /** scene AND isolate occurrences by key */
  byKey: Map<string, Occurrence>
  /** non-null iff ui.viewMode === 'isolate' and something valid is selected */
  isolate: IsolateView | null
  /** keys of boolean occurrences whose operands are shown (§4.4; core/selection shownOperandBools) */
  shownOperands: Set<string>
  specs: SpecSet
  /**
   * computeWantedJobs(...) result. wanted.resultKeyOf maps an occurrence key (scene or isolate) to the resultKey
   * whose mesh it shows: look it up with client.get(). Occurrences without an entry draw nothing of their own
   * ('none' groups, hidden things, operands not shown, defs with spec errors, everything while evalPaused).
   * Inspector status line ("✓ 18 ms · 4,382 triangles"): client.get(wanted.resultKeyOf.get(selectedOccKey)) for an
   * occurrence selection, or resultKeyOf.get(ISOLATE_INSTANCE_ID) for a def selection (isolate root).
   */
  wanted: WantedJobs
  /** status + error of every non-root def (§5.5 "Def status"); the Library, inspector and TestApi read this */
  defStates: Map<Id, DefEvalState>
  /** data-status of every scene tree row by occurrence key (groups show the worst of their subtree) */
  rowStatus: Map<string, DefStatus>
  /** occurrenceCounts(project): the ◆N badges and "shared by N copies" banner */
  counts: Map<Id, number>
}

/**
 * The integrator's src/app/controller.ts. Algorithm of one pass (run on a microtask after any store change,
 * and after client.onChange):
 *  1. if project changed since the last pass: specs = buildSpecs(project); occurrences = expand(project, { onCap })
 *     (onCap → one-time toast per session); counts = occurrenceCounts(project)
 *  2. t = isolateTarget(project, ui); isolate = t ? { ...t, occurrences: expand(project, { rootDef: t.defId, rootParams: t.params }), banner } : null
 *  3. shownOperands = shownOperandBools(occurrences, ui)
 *  4. wanted = computeWantedJobs(project, specs, occurrences, ui, shownOperands, isolate?.occurrences ?? [])
 *  5. if the pass was triggered by a store change and the wanted keys / priority differ from the last call:
 *     client.want(wanted.jobs, wanted.priorityKeys)   (while evalPaused this is want([], ∅))
 *  6. defStates = computeDefStates(project, wanted, specs.specErrors, (k) => client.get(k));
 *     rowStatus = computeRowStatuses(occurrences, defStates)
 *  7. viewport.reconcile(state); ctx.emit('render', state)
 */
export interface ControllerApi {
  /** latest RenderState (runs a pass synchronously if none exists yet) */
  current(): RenderState
  /** schedule a pass on the next microtask (multiple calls coalesce) */
  schedule(): void
  /** run a pass now and return it */
  run(): RenderState
  /** TestApi.idle(): await client.idle(), run a pass, await 2 animation frames */
  idle(): Promise<void>
}

// ─────────────────────────────────────────── view/ (§4.3, §4.4, §4.9, §5.6) ───────────────────────────────────────────

export type ViewPreset = 'front' | 'right' | 'top'
export interface CameraState { position: Vec3; target: Vec3 }
export interface ViewportStats {
  /** visible THREE.Mesh objects in the active root (scene root, or isolateRoot while isolated); edges/helpers excluded */
  meshes: number
  /** sum of triangles of those meshes */
  triangles: number
}

/**
 * src/view/viewport.ts → `export function createViewport(): ViewportApi`.
 * Scene setup per §4.4 "Scene" (Z-up via THREE.Object3D.DEFAULT_UP.set(0,0,1) BEFORE creating objects, camera
 * PerspectiveCamera(45, aspect, 0.1, 10000), grid, lights, background #1f2329, preserveDrawingBuffer: true, ResizeObserver,
 * OrbitControls with damping, setAnimationLoop + THREE.Timer).
 *
 * Responsibilities that stay INSIDE view/:
 * - scene-sync (§5.6): Object3D hierarchy mirrors the instance hierarchy; occurrence Group userData =
 *   { path, instanceId, defId, role }; each Mesh's userData.path = its occurrence path; last-good entry per
 *   occurrence key with 'stale' / 'error' materials; then client.setInUse(displayed keys).
 * - materials (§4.4, §5.6): selected / linked tint / ghost / operand states; colors via core/colors.ts.
 * - picking (§4.3, context mode only): pointerup within 4 px of pointerdown, not after a gizmo drag; raycast visible
 *   meshes (ghosts and shown operands included) → ctx.commands.pick(hitPath | null, { ctrl, double }).
 * - gizmo (§4.9): attach to the selected occurrence's Group iff ui.viewMode === 'context', selection is 'occ' and the
 *   occurrence is not hidden; mode/space/snap come from RenderState.ui on every reconcile; Ctrl held during a drag
 *   suspends snapping; objectChange copies local TRS to every Object3D with the same userData.instanceId (live, no
 *   store commit); on dragging-changed → false: ctx.commands.commitGizmo(path, xf, mode) with xf read from the
 *   dragged Group (rotation order 'ZYX', degrees, rounded 1e-4, -0 → 0). The Group being dragged is skipped by reconcile.
 * - isolate (§4.4): separate isolateRoot from RenderState.isolate; scene root hidden; auto-frame on entry and on every
 *   selection change; gizmo and picking off.
 */
export interface ViewportApi {
  /** Create renderer/canvas inside `el` (#view) and start the loop. Called once, after ctx.commands exists. */
  mount(el: HTMLElement, ctx: AppContext): void
  dispose(): void
  /** Sync the three scene to `state` (§5.6). Cheap when nothing changed; called after every controller pass. */
  reconcile(state: RenderState): void
  /**
   * §4.4 framing: keep the view direction, target = box center, distance = 1.2 · radius / sin(fov/2),
   * 300 ms cubic ease-out tween (animate: false → jump). `box` is in world coordinates.
   */
  frame(box: Box, opts?: { animate?: boolean }): void
  /** F: frame the selection (in isolate: the isolate root), or everything if nothing is selected. */
  frameSelection(): void
  /** Home: frame everything visible in the active root. */
  frameAll(): void
  /** Tree-click smart framing (§4.4): frame `path` only if its world bbox is not fully in the frustum or projects to < 5% of the viewport height. */
  frameIfNeeded(path: InstancePath): void
  /** 1 / 3 / 7: front looks along +Y, right looks along −X, top looks down −Z; keeps the target and framing distance. */
  viewPreset(preset: ViewPreset): void
  /**
   * Evaluated bbox of an occurrence (scene or isolate key path): the union of the meshes it currently displays
   * (incl. last-good fallbacks; a boolean's result only; hidden descendants excluded; a 'none' group = union of its
   * visible children). 'world' = world AABB; 'parent' = AABB in the occurrence's parent frame (i.e. including its
   * own xf), which is what §4.2 placement and §4.5 Ctrl+D offsets use. null when nothing is evaluated yet.
   */
  occurrenceBox(path: InstancePath, space: 'world' | 'parent'): Box | null
  getCamera(): CameraState
  /** jump (no tween); used when opening a file with project.camera and on boot from ui prefs */
  setCamera(camera: CameraState): void
  /** fires at the end of an orbit interaction / tween (for ui-prefs autosave); returns unsubscribe */
  onCameraChange(cb: (camera: CameraState) => void): () => void
  /** §9.1: hide grid/axes/gizmo, render, gl.readPixels the whole canvas, count px differing from #1f2329 by > 12 in any channel, restore */
  objectPixels(): number
  /** §9.1: client-space screen point `along` mm from the attached object's world position along world axis */
  gizmoAxisScreen(axis: 'X' | 'Y' | 'Z', along: number): { x: number; y: number }
  stats(): ViewportStats
  /** true while a gizmo drag is in progress */
  isDragging(): boolean
  /** debugging / e2e: the path key the gizmo is attached to (null when detached), whether a gizmo drag runs, and the NDC extent of everything
   *  visible in the active root (scene, or isolate) — outside [-1, 1] means off screen; null when nothing is drawn */
  debugView(): { gizmoAttached: string | null; dragging: boolean; ndc: { minX: number; maxX: number; minY: number; maxY: number } | null }
  /**
   * MCP screenshots (src/mcp): render offscreen-sized views and copy them to a new 2D canvas, all within one task, then
   * put the renderer, materials and visibility back — the user's camera, selection and view state are never touched
   * and nothing flickers. Throws when the view is not mounted yet.
   */
  capture(opts: CaptureOptions): CaptureResult
}

/** 'current' = the user's perspective camera; the others are orthographic (front looks along +Y, right along −X, top down −Z, iso from +X −Y +Z). */
export type CapturePreset = 'current' | 'front' | 'right' | 'top' | 'iso'

export interface CaptureOptions {
  /** whole image in px (1–2048) */
  width: number
  height: number
  /** one rectangle per rendered view, in image px from the top-left (a 2×2 multi view has four) */
  views: { preset: CapturePreset; x: number; y: number; width: number; height: number }[]
  /**
   * What to draw: 'screen' = the root the user sees (scene or isolate) with its current materials; 'scene' = the scene
   * root; 'isolate' = a separate expansion (expand(project, { rootDef })) drawn alone at the origin, from these result keys.
   */
  root: { kind: 'screen' } | { kind: 'scene' } | { kind: 'isolate'; occurrences: Occurrence[]; resultKeyOf: Map<string, string> }
  /** no selection highlight, linked tint, ghosting, operands or gizmo (plain materials) */
  clean: boolean
  grid: boolean
  /** show the gizmo (only meaningful with clean false and the 'current' preset) */
  gizmo?: boolean
  /** world box to frame; omitted = everything the chosen root draws ('current' without it keeps the user's camera exactly) */
  frame?: Box | null
}

export interface CaptureViewInfo {
  preset: CapturePreset
  x: number; y: number; width: number; height: number
  projection: 'perspective' | 'orthographic'
  camera: { position: Vec3; target: Vec3; up: Vec3 }
  /** orthographic only: millimetres per image pixel */
  mmPerPx?: number
  /** screen-space direction (+x right, +y down) of each world axis; length < 1 means it points partly at the viewer */
  axes: { X: [number, number]; Y: [number, number]; Z: [number, number] }
}

export interface CaptureResult {
  /** a 2D canvas of width × height with the rendered pixels (sRGB, exactly as the on-screen pipeline draws them) */
  canvas: HTMLCanvasElement
  views: CaptureViewInfo[]
  /** the box that was framed (world mm), null when nothing was drawn */
  box: Box | null
  /** meshes / triangles drawn by the captured root */
  meshes: number
  triangles: number
}

export type CreateViewport = () => ViewportApi

// ─────────────────────────────────────────── ui/ + app/commands (§4.2–§4.13, §6) ───────────────────────────────────────────

export type ToastKind = 'info' | 'warn' | 'error'
export type ToastFn = (message: string, kind?: ToastKind) => void

export interface ConfirmOptions {
  title?: string
  message: string
  /** confirm button text, e.g. 'Delete', 'Run code' */
  ok: string
  /** cancel button text, default 'Cancel' (e.g. 'Open without running') */
  cancel?: string
  /** style the ok button as destructive */
  danger?: boolean
}
/** Modal <dialog>; resolves true for ok, false for cancel / Esc / close. */
export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>
/** Modal <dialog> listing every problem (Open parse errors, §6). */
export type ProblemsFn = (title: string, problems: string[]) => void

/** What an inline rename edits (§4.7). */
export type RenameTarget = { kind: 'occ'; path: InstancePath } | { kind: 'def'; def: Id }
/** Tree DnD payload (§4.8), JSON under data type 'application/x-3dica'. */
export type DragPayload = { kind: 'occ'; path: InstancePath } | { kind: 'def'; def: Id }
/** Where a tree drop lands: insert into the group at `parentPath` ([] = root) at `index` (children index BEFORE any removal; -1 = append). */
export interface DropTarget { parentPath: InstancePath; index: number }

/**
 * src/app/commands.ts → `export function createCommands(ctx: AppContext): Commands`.
 * One method per user action. Shortcuts, toolbar, tree, library, inspector and viewport all call these; none of
 * them call store.update directly (except where noted). Every project edit is ONE store.update (one undo step) with
 * the label shown in parentheses; OpErrors become error toasts through store.onError. After an edit that changes a
 * non-root group def with > 1 occurrence, toast linkedChangeMessage(...) (§4.5). Methods that need a selection
 * do nothing (or toast a hint) without one.
 */
export interface Commands {
  // ── create / structure (§4.2)
  /** Add Cube/Sphere/Cylinder/Torus/Code/Group into the context group (root if []): createTemplateDef + addDef +
   *  addInstance at placementFor(kind, maxX) where maxX = max X of union(occurrenceBox(child, 'parent')) over the
   *  context's visible children; toast "Added to 'Fixture' — 2 copies updated" if the target has > 1 occurrence;
   *  select the new occurrence, frameIfNeeded. ('Add Cube') */
  addTemplate(kind: TemplateKind): void
  /** Ctrl+G = wrap('none'); [∪][−][∩] = union/subtract/intersect. ops.wrapInGroup; select the group, expand it. ('Wrap in Union') */
  wrap(op: GroupOp): void
  /** Ctrl+Shift+G on a group occurrence: ops.ungroup; select the parent or the first child. ('Ungroup Fixture') */
  ungroup(): void

  // ── duplicate / clipboard (§4.5)
  /** Ctrl+D: ops.duplicateLinked(path, linkedOffset(width of occurrenceBox(path,'parent'))); select the copy. ('Duplicate Bolt') */
  duplicateLinked(): void
  /** Ctrl+Shift+D: ops.duplicateUnique, same offset; select the copy. ('Duplicate unique Fixture') */
  duplicateUnique(): void
  /** Ctrl+C: ctx.clipboard.set(clipFromPath(project, selection.path)); also remember
   *  dx = linkedOffset(width of occurrenceBox(path, 'parent')) for paste (kept inside commands). No history. */
  copy(): void
  /** Ctrl+V (false) / Ctrl+Shift+V (true): ops.pasteInstance(d, ui.context, clip, unique, dx remembered at copy time
   *  or linkedOffset(null)); select the new occurrence. Refusals become toasts via OpError. ('Paste Bolt') */
  paste(unique: boolean): void
  /** U / inspector button: ops.makeUnique(path ?? selection). ('Make unique Bolt') */
  makeUnique(path?: InstancePath): void

  // ── delete (§4.6)
  /** Del/Backspace: occurrence → ops.removeInstance, select the parent path or none ('Delete Bolt');
   *  def selection → deleteDefinition(def). */
  deleteSelection(): Promise<void>
  /** Refuse with toast if referrers; confirm "Delete 'Bolt' and its 4 instances (8 copies in the scene)?" [Delete]/[Cancel]
   *  when it has instances; then ops.deleteDefinition. ('Delete definition Bolt') */
  deleteDefinition(defId: Id): Promise<void>
  /** Library header: ops.purgeUnused; toast "Removed 3 unused definitions" (or "Nothing to purge"). ('Purge unused') */
  purgeUnused(): void

  // ── rename (§4.7)
  /** F2 / double-click: ctx.emit('rename', target ?? selection) so the tree (or library) opens its inline input. */
  startRename(target?: RenameTarget): void
  /** Commit an inline rename input. occ target: if the instance has a label, set/clear the label, else rename the def.
   *  def target: rename the def. Returns null on success, or the validation error to show inline (input stays open, nothing changes). */
  commitRename(target: RenameTarget, text: string): string | null
  /** Library / inspector "Definition name": ops.renameDef (validation via checkDefName first). Returns null or the error. ('Rename Bolt → Screw') */
  renameDef(defId: Id, name: string): string | null
  /** Inspector "Instance label": ops.setInstanceLabel (empty clears). ('Label Bolt') */
  setLabel(path: InstancePath, label: string | undefined): void

  // ── hide (§4.11)
  /** H / eye icon: toggle ops.setHidden on path ?? selection. ('Hide Bolt' / 'Show Bolt') */
  hideToggle(path?: InstancePath): void
  /** Alt+H / tree header "Unhide all": ops.unhideAll. ('Unhide all') */
  unhideAll(): void

  // ── selection & navigation (§4.3) — ui only, never in history
  /** Tree row click: store.setUi(treeSelectPatch(ui, path)); then viewport.frameIfNeeded(path). */
  selectFromTree(path: InstancePath): void
  /** Library row click: store.setUi(librarySelectPatch(ui, defId)). */
  selectDef(defId: Id): void
  /** Breadcrumb segment j (0 = Scene): store.setUi(breadcrumbPatch(ui, j)). */
  selectBreadcrumb(j: number): void
  /** Viewport click / double-click (called by view/picking): store.setUi(pickPatch(project, ui, hit, mods)). */
  pick(hit: InstancePath | null, mods: PickMods): void
  /** Enter: enterPatch (no-op unless a group occurrence is selected). */
  enterGroup(): void
  /** Esc: escapePatch (exit isolate → pop context → deselect). */
  escape(): void
  /** Tree disclosure triangle: ui.expanded[pathKey(path)] = expanded ?? !current. */
  toggleExpanded(path: InstancePath, expanded?: boolean): void

  // ── view (§4.4, §4.9) — ui only
  /** W / E / R */
  setGizmoMode(mode: UiState['gizmoMode']): void
  /** Q */
  toggleSpace(): void
  /** X */
  toggleSnap(): void
  /** G */
  toggleGhost(): void
  /** I / toolbar: context ↔ isolate (clears autoIsolatedFrom); toast "Select something to isolate" with nothing selected. */
  toggleIsolate(): void
  /** F */
  frame(): void
  /** Home */
  frameAll(): void
  /** 1 / 3 / 7 */
  viewPreset(preset: ViewPreset): void

  // ── edits from the gizmo and the inspector (§4.9, §4.10)
  /** Gizmo drag end (called by view/gizmo): ops.setTransform; label 'Move ' | 'Rotate ' | 'Scale ' + (label ?? def name); linked toast. */
  commitGizmo(path: InstancePath, xf: Transform, mode: UiState['gizmoMode']): void
  /** Inspector transform field (xf-t0 … xf-s2): ops.setTransform with coalesce 'xf:' + instanceId + ':' + field (e.g. 't0'). Scale 0 is refused. ('Move Bolt') */
  setTransform(path: InstancePath, xf: Transform, field?: string): void
  /** Inspector "Reset": IDENTITY_XF. ('Reset transform Bolt') */
  resetTransform(path: InstancePath): void
  /** Inspector param control: ops.setOverride, coalesce 'param:' + instanceId + ':' + name, window 500; undefined = ↺ reset / ✕ stale. ('Set length') */
  setOverride(path: InstancePath, name: string, value: ParamValue | undefined): void
  /** Instance color ({ path }) or def color ({ def }); undefined clears. Never re-evaluates. ('Color Bolt') */
  setColor(target: { path: InstancePath } | { def: Id }, color: string | undefined): void
  /** Code editor commit (after its 400 ms debounce): ops.setCode with coalesce 'code:' + defId, window 2000. ('Edit code') */
  setCode(defId: Id, code: string): void
  /** Inspector parameter table: ops.setParamDefs. Returns null or the first problem (shown inline, not committed). ('Edit parameters') */
  setParamDefs(defId: Id, params: ParamDef[]): string | null
  /** Group op selector. ('Set op union') */
  setGroupOp(defId: Id, op: GroupOp): void

  // ── tree drag and drop (§4.8)
  /** dragover validity: false if target.parentPath has payload.path as a prefix, or wouldCycle(project, targetDef, draggedDef). */
  canDrop(payload: DragPayload, target: DropTarget): boolean
  /** occ payload: ops.moveInstance (copy = Ctrl held) ('Move Bolt' / 'Copy Bolt'); toast 'Kept local transform' when keptLocal;
   *  def payload: addInstance at IDENTITY_XF ('Add Bolt'); linked toast when the source or target group has > 1 occurrence; select the result. */
  drop(payload: DragPayload, target: DropTarget, opts: { copy: boolean }): void

  // ── history (§4.12)
  undo(): void
  redo(): void

  // ── files (§6)
  /** confirm, then store.reset(emptyProject()) with ui reset (selection none, context [], context mode, not paused). */
  newProject(): Promise<void>
  /** confirm, then store.reset(sampleProject(), { expanded: SAMPLE_EXPANDED, … }). */
  loadSample(): Promise<void>
  /** Ctrl+O / button / window drop: pickFile when `file` is omitted; parseProject → problems dialog on failure (current
   *  project untouched); with code → confirm "This file contains code that runs on your computer. Run it?" [Run code] /
   *  [Open without running] (→ evalPaused: true); store.reset (history reset); setCamera if project.camera. */
  open(file?: File): Promise<void>
  /** Ctrl+S: flush the code editor (ctx.emit('flushCode')), serialize({ ...project, camera: viewport.getCamera() }),
   *  downloadBlob as `<project.name>.3dica.json`. */
  save(): void
  /** computeStlItems → client.exportStl → downloadBlob(new Blob(parts, { type: 'model/stl' }), stlFileName(...));
   *  toast "Nothing to export" when empty, error toast on failure. */
  exportStl(): Promise<void>
  /** Ctrl+Enter / toolbar "Run code": ctx.emit('flushCode'); setUi({ evalPaused: false }) if paused; client.retry(keys)
   *  where keys = wanted.jobsOfDef of `defId` (default: the selected def), or every failed wanted key when none. */
  runCode(defId?: Id): void
}

export type CreateCommands = (ctx: AppContext) => Commands

// ─────────────────────────────────────────── io/files.ts ───────────────────────────────────────────

export interface FilesApi {
  /** URL.createObjectURL + hidden <a download> click + revoke */
  downloadBlob(blob: Blob, filename: string): void
  /** hidden <input type=file accept=…>; resolves null when cancelled */
  pickFile(accept: string): Promise<File | null>
  /** a file dropped anywhere on the window (ignores the tree's application/x-3dica drags); returns unsubscribe */
  onWindowDrop(cb: (file: File) => void): () => void
}

// ─────────────────────────────────────────── app context, events, panels ───────────────────────────────────────────

/** Synchronous app-wide events (ctx.on / ctx.emit). */
export interface AppEvents {
  /** after every controller pass — panels that show eval status / counts re-render from it */
  render: RenderState
  /** forwarded from client.onStatus */
  evalStatus: EvalStatus
  /** autosave wrote the project (status bar "saved 12:01:33") */
  saved: Date
  /** commands.startRename → the tree (occ / def) or library (def) opens its inline input */
  rename: RenameTarget
  /** the code editor must commit its pending debounced text NOW (synchronously, via commands.setCode) */
  flushCode: void
  /** the code editor must reload its doc if the store's code differs and no debounce is pending (§4.10 "External code changes") */
  codeChanged: { defIds: Id[] }
}

export type AppEventName = keyof AppEvents

export interface UrlParams {
  /** ?fresh — load the sample, ignore autosave */
  fresh: boolean
  /** ?evalTimeout=<ms>, default 20000 */
  evalTimeoutMs: number
}

export interface AppContext {
  store: Store
  client: EvalClientApi
  viewport: ViewportApi
  commands: Commands
  controller: ControllerApi
  clipboard: Clipboard
  files: FilesApi
  toast: ToastFn
  confirm: ConfirmFn
  problems: ProblemsFn
  /** subscribe to an app event; returns unsubscribe */
  on<K extends AppEventName>(type: K, cb: (payload: AppEvents[K]) => void): () => void
  emit<K extends AppEventName>(type: K, payload: AppEvents[K]): void
  params: UrlParams
  /** the local MCP bridge (src/mcp/bridge.ts) — only when enabled with ?mcp on localhost; the status bar shows its pill */
  mcp?: McpBridgeApi | null
}

// ─────────────────────────────────────────── MCP bridge (src/mcp/bridge.ts) ───────────────────────────────────────────

/** off = disabled from the pill; superseded = a newer tab took over the MCP server */
export type McpState = 'off' | 'connecting' | 'connected' | 'superseded'

export interface McpBridgeApi {
  readonly port: number
  state(): McpState
  /** history label of the last request that changed something ("MCP: Add Cube"), with its time */
  lastAction(): { label: string; at: Date } | null
  /** called on every state change and after every handled request; returns unsubscribe */
  onChange(cb: () => void): () => void
  /** superseded tab: become the active one again (reconnects if needed) */
  claim(): void
  /** disconnect, forget the ?mcp opt-in (localStorage) and stop reconnecting */
  disable(): void
}

/**
 * Panels: plain TS, no framework (§7). `mount` builds the DOM inside `el`, subscribes to ctx.store / ctx.on('render'),
 * and re-renders itself. The inspector rebuilds on selection change and PATCHES values on project change (a focused
 * input keeps focus); the tree re-renders rows keyed by data-path and preserves scroll. data-testid's per §4.1.
 * Mount order in main.ts: viewport.mount(#view) first, then the breadcrumb panel on the same #view element; the
 * breadcrumb/banner overlay is absolutely positioned (styles.css makes #view `position: relative`).
 */
export type MountPanel = (el: HTMLElement, ctx: AppContext) => void
/** src/ui/shortcuts.ts: window keydown handler per §4.13; returns uninstall. */
export type InstallShortcuts = (ctx: AppContext) => () => void

// ─────────────────────────────────────────── window.__3dica (§9.1) ───────────────────────────────────────────

export interface TestApi {
  /** true after boot + first reconcile */
  ready: boolean
  /** controller.idle(): client.idle(), then reconcile, then 2 animation frames */
  idle(): Promise<void>
  /** structuredClone(store.project) */
  project(): Project
  ui(): Pick<UiState, 'selection' | 'context' | 'viewMode' | 'ghostOthers' | 'gizmoMode' | 'snap'>
  /** occurrences = scene occurrences; meshes/triangles = viewport.stats(); geometries = client.stats().entriesInUse;
   *  pending = client.stats().queued + inFlight; failed = client.stats().failed */
  stats(): { occurrences: number; meshes: number; geometries: number; triangles: number; pending: number; failed: number }
  /** counts.get(def id of the def with that name) */
  occurrencesOf(defName: string): number
  /** defStates.get(id).status */
  defStatus(defName: string): DefStatus
  /** defStates.get(id).error */
  defError(defName: string): EvalError | undefined
  objectPixels(): number
  gizmoAxisScreen(axis: 'X' | 'Y' | 'Z', along: number): { x: number; y: number }
  /** store.history.labels() */
  history(): { past: string[]; future: string[] }
  /** beyond §9.1 (debugging / e2e): viewport.debugView() */
  view(): ReturnType<ViewportApi['debugView']>
}

// ─────────────────────────────────────────── small runtime helpers ───────────────────────────────────────────

export const DEFAULT_EVAL_TIMEOUT_MS = 20_000

/** Parse location.search into UrlParams. */
export function readUrlParams(search: string): UrlParams {
  const p = new URLSearchParams(search)
  const t = Number(p.get('evalTimeout'))
  return { fresh: p.has('fresh'), evalTimeoutMs: Number.isFinite(t) && t > 0 ? t : DEFAULT_EVAL_TIMEOUT_MS }
}

/** A tiny synchronous event bus implementing AppContext.on / emit. Listener exceptions propagate. */
export function createEvents(): Pick<AppContext, 'on' | 'emit'> {
  const map = new Map<AppEventName, Set<(payload: never) => void>>()
  return {
    on(type, cb) {
      let s = map.get(type)
      if (!s) map.set(type, (s = new Set()))
      s.add(cb as (payload: never) => void)
      return () => { s!.delete(cb as (payload: never) => void) }
    },
    emit(type, payload) {
      const s = map.get(type)
      if (!s) return
      for (const cb of [...s]) (cb as (p: typeof payload) => void)(payload)
    },
  }
}
