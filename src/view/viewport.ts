// §4.4 center view: renderer, camera, orbit, grid, lights, resize, loop, framing + tween, view presets, objectPixels().
// §4.3 picking (view/picking.ts), §4.9 gizmo (view/gizmo.ts), §5.6 scene sync (view/scene-sync.ts).
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { AppContext, Box, CameraState, CaptureOptions, CapturePreset, CaptureResult, CaptureViewInfo, RenderState, ViewPreset, ViewportApi, ViewportStats } from '../app/context'
import type { InstancePath, UiState, Vec3 } from '../core/types'
import { findInstance, ISOLATE_INSTANCE_ID, pathKey } from '../core/graph'
import { DEG, unionBoxes } from '../core/transform'
import { Materials, type StyleInput } from './materials'
import { SceneSync } from './scene-sync'
import { Picker } from './picking'
import { Gizmo } from './gizmo'

// Z-up (jscad / OpenSCAD) BEFORE any Object3D is created (§4.4). Module scope, so it runs on import.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1)

export const BACKGROUND = '#1f2329'
/** sRGB bytes of BACKGROUND as they land in the drawing buffer (THREE.Color would hold linear values) */
const BACKGROUND_RGB: [number, number, number] = [0x1f, 0x23, 0x29]
export const FRAME_MS = 300
export const FOV = 45
const DEFAULT_DIR: Vec3 = [0.55, -1, 0.75]
const SMART_FRAME_WAIT_MS = 10_000

// ───────────────────────────── pure helpers (unit-tested) ─────────────────────────────

/** §4.4: distance = 1.2 · radius / sin(fov / 2), fov in degrees (vertical). */
export function framingDistance(radius: number, fovDeg = FOV): number {
  return (1.2 * radius) / Math.sin((fovDeg * DEG) / 2)
}

export function easeOutCubic(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t))
  return 1 - u * u * u
}

/** Unit vector from the target to the camera for a preset: front looks along +Y, right along −X, top down −Z. */
export function presetDirection(preset: ViewPreset): Vec3 {
  if (preset === 'front') return [0, -1, 0]
  if (preset === 'right') return [1, 0, 0]
  // straight down; a hair of −Y keeps +Y up on screen (lookAt is degenerate exactly along the up axis)
  const k = 1 / Math.hypot(1e-3, 1)
  return [0, -1e-3 * k, k]
}

/**
 * Tree-click smart framing (§4.4): true when the box (as its 8 corners projected to NDC) is not fully inside the
 * frustum, or its projected height is less than 5% of the viewport height.
 */
export function needsSmartFrame(ndc: readonly { x: number; y: number; z: number }[]): boolean {
  if (ndc.length === 0) return false
  let minY = Infinity, maxY = -Infinity
  for (const p of ndc) {
    if (!(p.x >= -1 && p.x <= 1 && p.y >= -1 && p.y <= 1 && p.z >= -1 && p.z <= 1)) return true
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
  }
  return (maxY - minY) / 2 < 0.05
}

/** Pixels whose RGB differs from `bg` by more than `tol` in any channel (RGBA bytes). */
export function countObjectPixels(px: Uint8Array, bg: [number, number, number], tol = 12): number {
  let n = 0
  for (let i = 0; i < px.length; i += 4) {
    if (Math.abs(px[i] - bg[0]) > tol || Math.abs(px[i + 1] - bg[1]) > tol || Math.abs(px[i + 2] - bg[2]) > tol) n++
  }
  return n
}

// ───────────────────────────── MCP capture helpers (pure, unit-tested) ─────────────────────────────

/** Unit vector from the target to an orthographic capture camera, and the camera's up vector (Z-up; top view: +Y up). */
export function capturePresetDirection(preset: Exclude<CapturePreset, 'current'>): { dir: Vec3; up: Vec3 } {
  if (preset === 'front') return { dir: [0, -1, 0], up: [0, 0, 1] }
  if (preset === 'right') return { dir: [1, 0, 0], up: [0, 0, 1] }
  if (preset === 'top') return { dir: [0, 0, 1], up: [0, 1, 0] }
  const k = 1 / Math.sqrt(3)
  return { dir: [k, -k, k], up: [0, 0, 1] }
}

/**
 * Half height of an orthographic frustum that shows `box` from a camera with unit axes `right` / `up`, at `aspect`
 * (width / height), plus a margin. At least 1 mm.
 */
export function orthoHalfHeight(box: Box, right: Vec3, up: Vec3, aspect: number, margin = 1.08): number {
  const c = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]
  let hx = 0, hy = 0
  for (let i = 0; i < 8; i++) {
    const p = [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]]
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]
    hx = Math.max(hx, Math.abs(d[0] * right[0] + d[1] * right[1] + d[2] * right[2]))
    hy = Math.max(hy, Math.abs(d[0] * up[0] + d[1] * up[1] + d[2] * up[2]))
  }
  return Math.max(1, Math.max(hy, hx / Math.max(1e-6, aspect)) * margin)
}

/** Perspective framing distance that fits a sphere of `radius` for both the vertical fov and the horizontal one at `aspect`. */
export function captureDistance(radius: number, fovDeg: number, aspect: number): number {
  const v = (fovDeg * DEG) / 2
  const hh = Math.atan(Math.tan(v) * aspect)
  return (1.15 * Math.max(0.5, radius)) / Math.sin(Math.min(v, hh))
}

const FALLBACK_BOX: Box = { min: [-10, -10, 0], max: [10, 10, 10] }

// ───────────────────────────── viewport ─────────────────────────────

interface CamPose { target: THREE.Vector3; dir: THREE.Vector3; dist: number }
interface Tween { from: CamPose; to: CamPose; t0: number; ms: number }

const v3 = (v: THREE.Vector3, step = 1e-4): Vec3 => [v.x, v.y, v.z].map((x) => {
  const r = Math.round(x / step) * step
  return Number(r.toFixed(6)) + 0
}) as Vec3

export function createViewport(): ViewportApi {
  return new Viewport()
}

class Viewport implements ViewportApi {
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly materials = new Materials()
  private readonly sceneSync: SceneSync
  private readonly isoSync: SceneSync
  private readonly grid: THREE.GridHelper
  private readonly axes: THREE.LineSegments
  /** orbit target before mount (OrbitControls owns it afterwards) */
  private readonly initialTarget = new THREE.Vector3(0, 0, 0)

  private el: HTMLElement | null = null
  private ctx: AppContext | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private orbit: OrbitControls | null = null
  private gizmo: Gizmo | null = null
  private picker: Picker | null = null
  private timer: THREE.Timer | null = null
  private resizeObserver: ResizeObserver | null = null

  private lastState: RenderState | null = null
  private tween: Tween | null = null
  private cameraListeners = new Set<(c: CameraState) => void>()
  private cameraTimer: ReturnType<typeof setTimeout> | null = null
  /** frame everything once, when the first evaluation settles (unless a camera was set or the user moved it) */
  private autoFramePending = true
  private isoSig: string | null = null
  /** isolate auto-frame (§4.4): 'first' = frame as soon as something is drawn; 'fresh' = framed on a provisional
   *  (stale last-good / partial) view, frame once more when every result is in; 'none' = done (or the user orbited) */
  private isoFrame: 'none' | 'first' | 'fresh' = 'none'
  private savedCamera: CameraState | null = null
  private smartFrame: { key: string; until: number } | null = null

  constructor() {
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1)
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(BACKGROUND)
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 10000)
    this.camera.position.set(DEFAULT_DIR[0], DEFAULT_DIR[1], DEFAULT_DIR[2]).normalize().multiplyScalar(220)
    this.camera.lookAt(this.initialTarget)

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2))
    const key = new THREE.DirectionalLight(0xffffff, 2)
    key.position.set(60, -80, 120)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xffffff, 0.8)
    fill.position.set(-60, 60, 40)
    this.scene.add(fill)

    // GridHelper lies in XZ; rotate it into XY for Z-up. 200 mm, 20 divisions = 10 mm cells.
    this.grid = new THREE.GridHelper(200, 20, 0x5a626e, 0x363c45)
    this.grid.rotation.x = Math.PI / 2
    this.scene.add(this.grid)
    const axesGeom = new THREE.BufferGeometry()
    axesGeom.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.02, 25, 0, 0.02, 0, 0, 0.02, 0, 25, 0.02], 3))
    axesGeom.setAttribute('color', new THREE.Float32BufferAttribute([1, 0.25, 0.25, 1, 0.25, 0.25, 0.3, 0.85, 0.3, 0.3, 0.85, 0.3], 3))
    this.axes = new THREE.LineSegments(axesGeom, new THREE.LineBasicMaterial({ vertexColors: true }))
    this.axes.raycast = () => {}
    this.scene.add(this.axes)

    this.sceneSync = new SceneSync(this.materials, { name: 'sceneRoot' })
    this.isoSync = new SceneSync(this.materials, { name: 'isolateRoot', lastGoodSameDef: true })
    this.isoSync.root.visible = false
    this.scene.add(this.sceneSync.root, this.isoSync.root)
  }

  // ── lifecycle ──

  mount(el: HTMLElement, ctx: AppContext): void {
    if (this.renderer) return
    this.el = el
    this.ctx = ctx
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.renderer = renderer
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    const canvas = renderer.domElement
    canvas.dataset.testid = 'viewport-canvas'
    Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', display: 'block', outline: 'none' })
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
    el.prepend(canvas)
    this.resize()

    const orbit = new OrbitControls(this.camera, canvas)
    this.orbit = orbit
    orbit.enableDamping = true
    orbit.dampingFactor = 0.12
    orbit.target.copy(this.initialTarget)
    orbit.update()
    orbit.addEventListener('start', () => { this.tween = null; this.autoFramePending = false; this.isoFrame = 'none' })
    orbit.addEventListener('change', () => this.cameraMoved())

    // gizmo after orbit: orbit's pointerdown runs first, then dragging-changed disables it [verified]
    const gizmo = new Gizmo({
      camera: this.camera,
      dom: canvas,
      orbit,
      linkedGroups: (id) => this.sceneSync.groupsOfInstance(id),
      onDragStart: () => { this.picker?.notifyGizmoDrag(); this.tween = null },
      onCommit: (path, xf, mode) => ctx.commands.commitGizmo(path, xf, mode),
      onDragEnd: (id) => {
        if (id) this.restoreInstance(id)
        else if (this.lastState) this.reconcile(this.lastState) // re-attach to what is selected now
      },
    })
    this.gizmo = gizmo
    this.scene.add(gizmo.helper)

    this.picker = new Picker({
      dom: canvas,
      camera: this.camera,
      // what is on screen decides: the scene root is pickable whenever no isolate view replaces it
      viewMode: () => (this.lastState ? (this.lastState.isolate ? 'isolate' : 'context') : ctx.store.ui.viewMode),
      pickables: () => this.sceneSync.root.visible ? this.sceneSync.visibleMeshes() : [],
      gizmoDragging: () => gizmo.isDragging(),
      gizmoMoved: () => gizmo.lastDragMoved(),
      onPick: (hit, mods) => ctx.commands.pick(hit, mods),
    })

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(el)

    const timer = new THREE.Timer()
    this.timer = timer
    timer.connect(document)
    renderer.setAnimationLoop((time) => {
      timer.update(time)
      this.stepTween()
      orbit.update()
      renderer.render(this.scene, this.camera)
    })

    if (this.lastState) this.reconcile(this.lastState)
  }

  dispose(): void {
    this.renderer?.setAnimationLoop(null)
    this.resizeObserver?.disconnect()
    this.picker?.dispose()
    this.gizmo?.dispose()
    this.orbit?.dispose()
    this.timer?.dispose()
    if (this.cameraTimer) clearTimeout(this.cameraTimer)
    this.sceneSync.clear()
    this.isoSync.clear()
    this.materials.dispose()
    this.grid.geometry.dispose()
    ;(this.grid.material as THREE.Material).dispose()
    this.axes.geometry.dispose()
    ;(this.axes.material as THREE.Material).dispose()
    if (this.renderer) {
      this.renderer.domElement.remove()
      this.renderer.dispose()
    }
    this.renderer = this.orbit = this.gizmo = this.picker = this.timer = this.resizeObserver = null
    this.cameraListeners.clear()
  }

  private resize(): void {
    const el = this.el, r = this.renderer
    if (!el || !r) return
    const w = el.clientWidth, h = el.clientHeight
    if (w <= 0 || h <= 0) return
    r.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // ── reconcile (§5.6) ──

  reconcile(state: RenderState): void {
    this.lastState = state
    const ctx = this.ctx
    if (!ctx || !this.gizmo) return
    const ui = state.ui
    const lookup = (k: string) => ctx.client.get(k)
    const sel = ui.selection
    const style: StyleInput = {
      isolate: false,
      selPath: sel.kind === 'occ' ? sel.path : null,
      selDef: sel.kind === 'occ' ? state.byKey.get(pathKey(sel.path))?.def.id ?? null : sel.kind === 'def' ? sel.def : null,
      selIsDef: sel.kind === 'def',
      context: ui.context,
      ghostOthers: ui.ghostOthers,
      shownOperands: state.shownOperands,
      defAt: (k) => state.byKey.get(k)?.def.id,
    }
    const skipInstanceId = this.gizmo.draggingInstanceId()
    this.sceneSync.sync({
      project: state.project, occurrences: state.occurrences, resultKeyOf: state.wanted.resultKeyOf, lookup, style,
      shownOperands: state.shownOperands, evalPaused: ui.evalPaused, skipInstanceId,
    })
    const iso = state.isolate
    if (iso) {
      this.isoSync.sync({
        project: state.project, occurrences: iso.occurrences, resultKeyOf: state.wanted.resultKeyOf, lookup,
        style: { ...style, isolate: true, shownOperands: new Set() }, shownOperands: new Set(), evalPaused: ui.evalPaused,
        skipInstanceId: null,
      })
    } else if (!this.isoSync.isEmpty()) {
      this.isoSync.clear()
    }
    this.sceneSync.root.visible = !iso
    this.isoSync.root.visible = !!iso

    const inUse = new Set<string>()
    this.sceneSync.displayedKeys(inUse)
    this.isoSync.displayedKeys(inUse)
    ctx.client.setInUse(inUse)

    // gizmo (§4.9): context mode (the scene root is what is shown), an occurrence selection, not hidden
    let target: THREE.Object3D | null = null
    if (!iso && sel.kind === 'occ') {
      const key = pathKey(sel.path)
      const occ = this.sceneSync.occurrence(key)
      if (occ && !occ.hidden) target = this.sceneSync.group(key) ?? null
    }
    this.gizmo.update(target, ui)

    this.reconcileFraming(state, ui)
  }

  private reconcileFraming(state: RenderState, ui: UiState): void {
    const iso = state.isolate
    // isolate: auto-frame on entry and on every selection change; restore the context camera on exit
    const selKey = ui.selection.kind === 'occ' ? 'o:' + pathKey(ui.selection.path) : ui.selection.kind === 'def' ? 'd:' + ui.selection.def : 'n'
    const sig = iso ? iso.defId + '|' + selKey : null
    if (sig !== this.isoSig) {
      if (sig && !this.isoSig) this.savedCamera = this.getCamera()
      if (!sig && this.isoSig && this.savedCamera) {
        const c = this.savedCamera
        this.savedCamera = null
        this.startTween(this.poseOf(c), FRAME_MS)
      }
      this.isoSig = sig
      this.isoFrame = sig ? 'first' : 'none'
    }
    if (iso && this.isoFrame !== 'none') {
      const b = this.isoSync.boxAll()
      const provisional = this.isoSync.hasPending()
      if (b && (this.isoFrame === 'first' || !provisional)) {
        this.frame(b)
        this.isoFrame = this.isoFrame === 'first' && provisional ? 'fresh' : 'none'
      }
    }

    // boot: frame everything once the first evaluation has settled
    if (this.autoFramePending && !iso && this.ctx) {
      const st = this.ctx.client.stats()
      if (st.queued === 0 && st.inFlight === 0) {
        const b = this.sceneSync.boxAll()
        if (b) { this.autoFramePending = false; this.frame(b, { animate: false }) }
      }
    }

    // a smart-frame request whose box was not evaluated yet (§4.2 step 4)
    if (this.smartFrame) {
      const sf = this.smartFrame
      const selected = ui.selection.kind === 'occ' && pathKey(ui.selection.path) === sf.key
      if (!selected || performance.now() > sf.until || iso) this.smartFrame = null
      else {
        const b = this.sceneSync.box(sf.key.split('/'), 'world')
        if (b) { this.smartFrame = null; if (this.boxNeedsFrame(b)) this.frame(b) }
      }
    }
  }

  /** after a gizmo drag: put the instance's groups back to the stored xf (a refused commit must not leave them moved) */
  private restoreInstance(instanceId: string): void {
    const ctx = this.ctx
    if (!ctx) return
    const found = findInstance(ctx.store.project, instanceId)
    if (!found) return
    const { t, r, s } = found.instance.xf
    for (const g of this.sceneSync.groupsOfInstance(instanceId)) {
      g.position.set(t[0], t[1], t[2])
      g.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'ZYX')
      g.scale.set(s[0], s[1], s[2])
    }
  }

  // ── camera & framing (§4.4) ──

  /** ms on the render loop's THREE.Timer clock (performance.now() before mount) */
  private now(): number { return this.timer ? this.timer.getElapsed() * 1000 : performance.now() }

  private target(): THREE.Vector3 { return this.orbit ? this.orbit.target : this.initialTarget }

  private currentPose(): CamPose {
    const target = this.target().clone()
    const off = this.camera.position.clone().sub(target)
    let dist = off.length()
    if (!(dist > 1e-6)) { off.set(...DEFAULT_DIR); dist = 100 }
    return { target, dir: off.normalize(), dist }
  }

  private poseOf(c: CameraState): CamPose {
    const target = new THREE.Vector3(...c.target)
    const off = new THREE.Vector3(...c.position).sub(target)
    let dist = off.length()
    if (!(dist > 1e-6)) { off.set(...DEFAULT_DIR); dist = 100 }
    return { target, dir: off.normalize(), dist }
  }

  private applyPose(p: CamPose): void {
    this.target().copy(p.target)
    this.camera.position.copy(p.dir).multiplyScalar(p.dist).add(p.target)
    this.camera.lookAt(p.target)
    this.camera.updateMatrixWorld()
  }

  private startTween(to: CamPose, ms: number): void {
    if (ms <= 0 || !this.renderer) {
      this.tween = null
      this.applyPose(to)
      this.orbit?.update()
      this.cameraMoved()
      return
    }
    this.tween = { from: this.currentPose(), to, t0: this.now(), ms }
  }

  private stepTween(): void {
    const tw = this.tween
    if (!tw) return
    const k = easeOutCubic((this.now() - tw.t0) / tw.ms)
    const dir = tw.from.dir.clone().lerp(tw.to.dir, k)
    if (dir.lengthSq() < 1e-12) dir.copy(tw.to.dir)
    dir.normalize()
    this.applyPose({
      target: tw.from.target.clone().lerp(tw.to.target, k),
      dir,
      dist: tw.from.dist + (tw.to.dist - tw.from.dist) * k,
    })
    if (k >= 1) { this.tween = null; this.cameraMoved() }
  }

  private cameraMoved(): void {
    if (this.cameraTimer) clearTimeout(this.cameraTimer)
    this.cameraTimer = setTimeout(() => {
      this.cameraTimer = null
      if (this.tween) return
      const c = this.getCamera()
      for (const cb of [...this.cameraListeners]) cb(c)
    }, 250)
  }

  frame(box: Box, opts: { animate?: boolean } = {}): void {
    const min = new THREE.Vector3(...box.min), max = new THREE.Vector3(...box.max)
    if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)) return
    const center = min.clone().add(max).multiplyScalar(0.5)
    const radius = Math.max(0.5, max.distanceTo(min) / 2)
    const pose = this.currentPose()
    this.autoFramePending = false
    this.startTween({ target: center, dir: pose.dir, dist: framingDistance(radius, this.camera.fov) }, opts.animate === false ? 0 : FRAME_MS)
  }

  frameSelection(): void {
    const st = this.lastState
    if (!st) return
    if (st.isolate) { const b = this.isoSync.boxAll(); if (b) this.frame(b); return }
    const sel = st.ui.selection
    let box: Box | null = null
    if (sel.kind === 'occ') box = this.sceneSync.box(sel.path, 'world')
    else if (sel.kind === 'def') {
      box = unionBoxes(st.occurrences.filter((o) => o.def.id === sel.def).map((o) => this.sceneSync.box(o.path, 'world')))
    }
    if (box) this.frame(box)
    else this.frameAll()
  }

  frameAll(): void {
    const b = this.lastState?.isolate ? this.isoSync.boxAll() : this.sceneSync.boxAll()
    if (b) this.frame(b)
  }

  frameIfNeeded(path: InstancePath): void {
    if (this.lastState?.isolate) return
    const b = this.sceneSync.box(path, 'world')
    if (!b) { this.smartFrame = { key: pathKey(path), until: performance.now() + SMART_FRAME_WAIT_MS }; return }
    this.smartFrame = null
    if (this.boxNeedsFrame(b)) this.frame(b)
  }

  private boxNeedsFrame(b: Box): boolean {
    this.camera.updateMatrixWorld()
    const corners: THREE.Vector3[] = []
    for (let i = 0; i < 8; i++) {
      corners.push(new THREE.Vector3(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]).project(this.camera))
    }
    return needsSmartFrame(corners)
  }

  viewPreset(preset: ViewPreset): void {
    const pose = this.currentPose()
    this.autoFramePending = false
    this.startTween({ target: pose.target, dir: new THREE.Vector3(...presetDirection(preset)), dist: pose.dist }, FRAME_MS)
  }

  occurrenceBox(path: InstancePath, space: 'world' | 'parent'): Box | null {
    if (path.length === 0) return null
    return path[0] === ISOLATE_INSTANCE_ID ? this.isoSync.box(path, space) : this.sceneSync.box(path, space)
  }

  getCamera(): CameraState {
    return { position: v3(this.camera.position), target: v3(this.target()) }
  }

  setCamera(camera: CameraState): void {
    this.tween = null
    this.autoFramePending = false
    this.applyPose(this.poseOf(camera))
    this.orbit?.update()
  }

  onCameraChange(cb: (camera: CameraState) => void): () => void {
    this.cameraListeners.add(cb)
    return () => { this.cameraListeners.delete(cb) }
  }

  // ── test API (§9.1) ──

  objectPixels(): number {
    const r = this.renderer
    if (!r) return 0
    const helper = this.gizmo?.helper
    const prev = [this.grid.visible, this.axes.visible, helper?.visible ?? false] as const
    this.grid.visible = false
    this.axes.visible = false
    if (helper) helper.visible = false
    try {
      r.render(this.scene, this.camera)
      const gl = r.getContext()
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
      const px = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
      return countObjectPixels(px, BACKGROUND_RGB)
    } finally {
      this.grid.visible = prev[0]
      this.axes.visible = prev[1]
      if (helper) helper.visible = prev[2]
    }
  }

  gizmoAxisScreen(axis: 'X' | 'Y' | 'Z', along: number): { x: number; y: number } {
    const r = this.renderer
    if (!r || !this.gizmo) return { x: NaN, y: NaN }
    return this.gizmo.axisScreen(axis, along, this.camera, r.domElement.getBoundingClientRect())
  }

  stats(): ViewportStats {
    const root = this.lastState?.isolate ? this.isoSync : this.sceneSync
    let meshes = 0, triangles = 0
    for (const m of root.visibleMeshes()) {
      meshes++
      const g = m.geometry
      triangles += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3)
    }
    return { meshes, triangles }
  }

  isDragging(): boolean { return this.gizmo?.isDragging() ?? false }

  debugView(): ReturnType<ViewportApi['debugView']> {
    const o = this.gizmo?.attached()
    const path = (o?.userData as { path?: InstancePath } | undefined)?.path
    const gizmoAttached = path ? pathKey(path) : null
    const b = this.lastState?.isolate ? this.isoSync.boxAll() : this.sceneSync.boxAll()
    const dragging = this.isDragging()
    if (!b) return { gizmoAttached, dragging, ndc: null }
    this.camera.updateMatrixWorld()
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let i = 0; i < 8; i++) {
      const v = new THREE.Vector3(i & 1 ? b.max[0] : b.min[0], i & 2 ? b.max[1] : b.min[1], i & 4 ? b.max[2] : b.min[2]).project(this.camera)
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y)
    }
    return { gizmoAttached, dragging, ndc: { minX, maxX, minY, maxY } }
  }

  // ── MCP screenshots (src/mcp) ──

  /** separate root for isolate captures (never shown on screen; emptied after every capture) */
  private captureSync: SceneSync | null = null

  capture(opts: CaptureOptions): CaptureResult {
    const r = this.renderer, st = this.lastState, ctx = this.ctx
    if (!r || !st || !ctx || !this.gizmo) throw new Error('The 3D view is not ready yet')
    const W = Math.max(1, Math.min(2048, Math.round(opts.width)))
    const H = Math.max(1, Math.min(2048, Math.round(opts.height)))
    const helper = this.gizmo.helper
    const prev = {
      grid: this.grid.visible, axes: this.axes.visible, helper: helper.visible,
      scene: this.sceneSync.root.visible, iso: this.isoSync.root.visible, pr: r.getPixelRatio(), size: r.getSize(new THREE.Vector2()),
    }
    const lookup = (k: string) => ctx.client.get(k)
    const clean: StyleInput = {
      isolate: false, selPath: null, selDef: null, selIsDef: false, context: [], ghostOthers: false, shownOperands: new Set(), defAt: () => undefined,
    }
    let sync: SceneSync
    let resync = false
    let usedCapture = false
    try {
      // 1. what to draw
      if (opts.root.kind === 'isolate') {
        const cs = this.captureSync ?? (this.captureSync = new SceneSync(this.materials, { name: 'captureRoot' }))
        this.scene.add(cs.root)
        usedCapture = true
        cs.root.visible = true
        cs.sync({
          project: st.project, occurrences: opts.root.occurrences, resultKeyOf: opts.root.resultKeyOf, lookup,
          style: { ...clean, isolate: true }, shownOperands: new Set(), evalPaused: false, skipInstanceId: null,
        })
        this.sceneSync.root.visible = false
        this.isoSync.root.visible = false
        sync = cs
      } else if (opts.root.kind === 'scene') {
        this.sceneSync.root.visible = true
        this.isoSync.root.visible = false
        if (opts.clean) {
          resync = true
          this.sceneSync.sync({
            project: st.project, occurrences: st.occurrences, resultKeyOf: st.wanted.resultKeyOf, lookup, style: clean,
            shownOperands: new Set(), evalPaused: st.ui.evalPaused, skipInstanceId: this.gizmo.draggingInstanceId(),
          })
        }
        sync = this.sceneSync
      } else {
        sync = st.isolate ? this.isoSync : this.sceneSync
      }
      this.grid.visible = opts.grid
      this.axes.visible = opts.grid
      const drawn = sync.boxAll()
      const box = opts.frame === undefined ? drawn : opts.frame
      const target = box ?? drawn ?? FALLBACK_BOX

      // 2. cameras
      const center = new THREE.Vector3((target.min[0] + target.max[0]) / 2, (target.min[1] + target.max[1]) / 2, (target.min[2] + target.max[2]) / 2)
      const radius = Math.max(0.5, new THREE.Vector3(...target.min).distanceTo(new THREE.Vector3(...target.max)) / 2)
      const views: { cam: THREE.Camera; info: CaptureViewInfo }[] = opts.views.map((v) => {
        const vw = Math.max(1, Math.round(v.width)), vh = Math.max(1, Math.round(v.height))
        const aspect = vw / vh
        let cam: THREE.PerspectiveCamera | THREE.OrthographicCamera
        let look: THREE.Vector3
        let mmPerPx: number | undefined
        if (v.preset === 'current') {
          const c = this.camera.clone()
          c.aspect = aspect
          look = this.target().clone()
          if (opts.frame !== undefined || opts.root.kind === 'isolate') {
            const dir = this.camera.position.clone().sub(this.target())
            if (dir.lengthSq() < 1e-12) dir.set(...DEFAULT_DIR)
            dir.normalize()
            look = center.clone()
            c.position.copy(dir.multiplyScalar(captureDistance(radius, c.fov, aspect)).add(center))
            c.lookAt(center)
          }
          c.updateProjectionMatrix()
          cam = c
        } else {
          const { dir, up } = capturePresetDirection(v.preset)
          const dist = radius * 2 + 500
          const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, dist + radius * 2 + 5000)
          c.up.set(...up)
          c.position.set(...dir).multiplyScalar(dist).add(center)
          c.lookAt(center)
          c.updateMatrixWorld()
          const e = c.matrixWorld.elements
          const right: Vec3 = [e[0], e[1], e[2]], upAxis: Vec3 = [e[4], e[5], e[6]]
          const hh = orthoHalfHeight(target, right, upAxis, aspect)
          c.top = hh; c.bottom = -hh; c.left = -hh * aspect; c.right = hh * aspect
          c.updateProjectionMatrix()
          mmPerPx = (2 * hh) / vh
          look = center.clone()
          cam = c
        }
        cam.updateMatrixWorld()
        const inv = cam.matrixWorldInverse
        const axis = (x: number, y: number, z: number): [number, number] => {
          // camera space: +x right, +y up, +z towards the viewer; the 2D length is the foreshortening
          const d = new THREE.Vector3(x, y, z).transformDirection(inv)
          return [Number(d.x.toFixed(4)) + 0, Number((-d.y).toFixed(4)) + 0]
        }
        const info: CaptureViewInfo = {
          preset: v.preset, x: Math.round(v.x), y: Math.round(v.y), width: vw, height: vh,
          projection: v.preset === 'current' ? 'perspective' : 'orthographic',
          camera: { position: v3(cam.position), target: v3(look), up: v3(cam.up) },
          axes: { X: axis(1, 0, 0), Y: axis(0, 1, 0), Z: axis(0, 0, 1) },
        }
        if (mmPerPx !== undefined) info.mmPerPx = mmPerPx
        return { cam, info }
      })

      // 3. render every view into the resized drawing buffer, then copy it out (same task: never composited)
      // TransformControls shows its helper only while attached: keep that, and only in an as-seen capture
      helper.visible = prev.helper && !opts.clean && !!opts.gizmo
      r.setPixelRatio(1)
      r.setSize(W, H, false)
      r.setScissorTest(true)
      for (const { cam, info } of views) {
        const y = H - info.y - info.height
        r.setViewport(info.x, y, info.width, info.height)
        r.setScissor(info.x, y, info.width, info.height)
        r.render(this.scene, cam)
      }
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const g = canvas.getContext('2d')
      if (!g) throw new Error('No 2D canvas available')
      g.drawImage(r.domElement, 0, 0)

      let meshes = 0, triangles = 0
      for (const m of sync.visibleMeshes()) {
        meshes++
        const geo = m.geometry
        triangles += Math.floor((geo.index ? geo.index.count : geo.attributes.position.count) / 3)
      }
      return { canvas, views: views.map((v) => v.info), box, meshes, triangles }
    } finally {
      r.setScissorTest(false)
      r.setPixelRatio(prev.pr)
      r.setSize(prev.size.x, prev.size.y, false)
      this.grid.visible = prev.grid
      this.axes.visible = prev.axes
      helper.visible = prev.helper
      this.sceneSync.root.visible = prev.scene
      this.isoSync.root.visible = prev.iso
      if (usedCapture && this.captureSync) {
        this.captureSync.clear()
        this.scene.remove(this.captureSync.root)
      }
      // put the user's materials / operand visibility back (a no-op for everything else), then repaint the canvas
      if (resync) this.reconcile(st)
      r.render(this.scene, this.camera)
    }
  }
}

