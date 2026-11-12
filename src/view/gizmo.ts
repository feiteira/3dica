// §4.9 gizmo: a TransformControls wrapper. The controls are not an Object3D: scene.add(controls.getHelper()) [verified].
// - mode / space / snap come from UiState on every reconcile (W/E/R, Q, X); three forces local space for scale
// - holding Ctrl during a drag clears the snaps; Ctrl keyup restores them
// - dragging-changed: orbit.enabled = !value; → false commits ONE store update via the onCommit callback
// - objectChange: copies the dragged Group's local TRS onto every other Group with the same userData.instanceId
//   (the live linked preview; no store commit, no worker)
import * as THREE from 'three'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { Id, InstancePath, Transform, UiState, Vec3 } from '../core/types'
import { DEG, roundXf } from '../core/transform'
import type { OccUserData } from './scene-sync'

export const TRANSLATION_SNAP = 1
export const ROTATION_SNAP_DEG = 15
export const SCALE_SNAP = 0.1

export interface TrsLike {
  position: { x: number; y: number; z: number }
  quaternion: THREE.Quaternion
  scale: { x: number; y: number; z: number }
}
export interface TrsStart { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }

const same3 = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.z - b.z) < 1e-9

/**
 * The committed xf after a drag (§4.9): local position, rotation (order ZYX, degrees) and scale, each rounded to
 * 1e-4 with -0 → 0. Components the drag did not change keep the stored values verbatim (so a translate never
 * rewrites r through a quaternion round trip). `changed` is false when nothing moved.
 */
export function readXf(obj: TrsLike, stored: Transform, start: TrsStart): { xf: Transform; changed: boolean } {
  const tChanged = !same3(obj.position, start.position)
  const rChanged = Math.abs(Math.abs(obj.quaternion.dot(start.quaternion)) - 1) > 1e-12
  const sChanged = !same3(obj.scale, start.scale)
  const e = new THREE.Euler().setFromQuaternion(obj.quaternion, 'ZYX')
  const read = roundXf({
    t: [obj.position.x, obj.position.y, obj.position.z],
    r: [e.x / DEG, e.y / DEG, e.z / DEG],
    s: [obj.scale.x, obj.scale.y, obj.scale.z],
  })
  const xf: Transform = {
    t: tChanged ? read.t : ([...stored.t] as Vec3),
    r: rChanged ? read.r : ([...stored.r] as Vec3),
    s: sChanged ? read.s : ([...stored.s] as Vec3),
  }
  return { xf, changed: tChanged || rChanged || sChanged }
}

function inScene(o: THREE.Object3D): boolean {
  let p: THREE.Object3D = o
  while (p.parent) p = p.parent
  return (p as THREE.Scene).isScene === true
}

export interface GizmoDeps {
  camera: THREE.Camera
  dom: HTMLElement
  orbit: OrbitControls
  /** every Group of this instance id in the scene root (linked copies) */
  linkedGroups(instanceId: Id): Iterable<THREE.Object3D>
  /** dragging-changed → true */
  onDragStart(): void
  /** dragging-changed → false with a changed transform */
  onCommit(path: InstancePath, xf: Transform, mode: UiState['gizmoMode']): void
  /** after the commit (successful or refused): re-apply stored transforms to the dragged instance's groups. null: the
   *  dragged object vanished mid-drag (undo, delete…) and nothing was committed — re-attach to the current selection */
  onDragEnd(instanceId: Id | null): void
}

export class Gizmo {
  readonly controls: TransformControls
  readonly helper: THREE.Object3D
  private readonly deps: GizmoDeps
  private snap = true
  private ctrlHeld = false
  private start: TrsStart | null = null
  /** whether the last finished drag changed the transform (a press on a handle without motion does not) */
  private lastMoved = false
  private readonly onKey: (e: KeyboardEvent) => void
  private readonly onBlur: () => void
  private readonly onPointerMove: (e: PointerEvent) => void

  constructor(deps: GizmoDeps) {
    this.deps = deps
    this.controls = new TransformControls(deps.camera, deps.dom)
    this.helper = this.controls.getHelper()
    this.controls.addEventListener('dragging-changed', (e) => {
      const dragging = !!e.value
      deps.orbit.enabled = !dragging
      if (dragging) {
        const o = this.controls.object
        this.start = o ? { position: o.position.clone(), quaternion: o.quaternion.clone(), scale: o.scale.clone() } : null
        this.applySnaps()
        deps.onDragStart()
      } else {
        this.applySnaps()
        this.commit()
      }
    })
    this.controls.addEventListener('objectChange', () => {
      const o = this.controls.object
      if (!o) return
      const id = (o.userData as OccUserData).instanceId
      for (const g of deps.linkedGroups(id)) {
        if (g === o) continue
        g.position.copy(o.position)
        g.quaternion.copy(o.quaternion)
        g.scale.copy(o.scale)
      }
    })
    this.onKey = (e) => {
      if (e.key !== 'Control') return
      const held = e.type === 'keydown'
      if (held !== this.ctrlHeld) { this.ctrlHeld = held; this.applySnaps() }
    }
    this.onBlur = () => { if (this.ctrlHeld) { this.ctrlHeld = false; this.applySnaps() } }
    this.onPointerMove = (e) => {
      if (this.controls.dragging && e.ctrlKey !== this.ctrlHeld) { this.ctrlHeld = e.ctrlKey; this.applySnaps() }
    }
    window.addEventListener('keydown', this.onKey)
    window.addEventListener('keyup', this.onKey)
    window.addEventListener('blur', this.onBlur)
    deps.dom.addEventListener('pointermove', this.onPointerMove)
  }

  /** Attach to `target` (or detach with null) and apply mode / space / snap. Ignored while dragging. */
  update(target: THREE.Object3D | null, ui: Pick<UiState, 'gizmoMode' | 'gizmoSpace' | 'snap'>): void {
    if (this.controls.dragging) {
      // the dragged occurrence vanished mid-drag (undo, delete…): drop it; the pointerup then commits nothing
      const o = this.controls.object
      if (o && !inScene(o)) { this.start = null; this.controls.detach() }
      return
    }
    this.snap = ui.snap
    if ((this.controls.object ?? null) !== target) {
      if (target) this.controls.attach(target)
      else this.controls.detach()
    }
    if (this.controls.getMode() !== ui.gizmoMode) this.controls.setMode(ui.gizmoMode)
    if (this.controls.space !== ui.gizmoSpace) this.controls.setSpace(ui.gizmoSpace)
    this.applySnaps()
  }

  isDragging(): boolean { return this.controls.dragging }

  /** The last finished drag changed the transform (false for a press-and-release on a handle without motion). */
  lastDragMoved(): boolean { return this.lastMoved }

  attached(): THREE.Object3D | null { return this.controls.object ?? null }

  /** The dragged instance id while a drag is running (reconcile skips its groups). */
  draggingInstanceId(): Id | null {
    const o = this.controls.object
    return this.controls.dragging && o ? (o.userData as OccUserData).instanceId ?? null : null
  }

  private applySnaps(): void {
    const on = this.snap && !(this.controls.dragging && this.ctrlHeld)
    this.controls.setTranslationSnap(on ? TRANSLATION_SNAP : null)
    this.controls.setRotationSnap(on ? ROTATION_SNAP_DEG * DEG : null)
    this.controls.setScaleSnap(on ? SCALE_SNAP : null)
  }

  private commit(): void {
    const o = this.controls.object
    const start = this.start
    this.start = null
    this.lastMoved = false
    // detached mid-drag: no store change follows, so nothing else would re-attach the gizmo to the selection
    if (!o || !start) { this.deps.onDragEnd(null); return }
    const ud = o.userData as OccUserData
    if (!ud.path || !ud.xf) return
    const { xf, changed } = readXf(o, ud.xf, start)
    this.lastMoved = changed
    try {
      if (changed) this.deps.onCommit([...ud.path], xf, this.controls.getMode())
    } finally {
      this.deps.onDragEnd(ud.instanceId)
    }
  }

  /** §9.1 gizmoAxisScreen: client-space point `along` mm from the attached object's world position along a world axis. */
  axisScreen(axis: 'X' | 'Y' | 'Z', along: number, camera: THREE.Camera, rect: DOMRect): { x: number; y: number } {
    const o = this.controls.object
    const p = new THREE.Vector3()
    if (o) { o.updateWorldMatrix(true, false); o.getWorldPosition(p) }
    p.add(new THREE.Vector3(axis === 'X' ? along : 0, axis === 'Y' ? along : 0, axis === 'Z' ? along : 0))
    camera.updateMatrixWorld()
    p.project(camera)
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey)
    window.removeEventListener('keyup', this.onKey)
    window.removeEventListener('blur', this.onBlur)
    this.deps.dom.removeEventListener('pointermove', this.onPointerMove)
    this.controls.detach()
    this.controls.dispose()
  }
}
