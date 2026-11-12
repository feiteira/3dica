// §4.3 viewport picking. The rules are PURE (unit-tested in tests/unit/picking.test.ts):
//   classifyClick: pointerup within 4 px of pointerdown, left button, context mode only, never after a gizmo drag;
//                  a second click within 400 ms / 4 px of the previous one is a double-click
//   chooseHit:     nearest intersection; among coincident ones (a boolean result and its base operand) the deepest path
// The selection/context path arithmetic itself is core/selection pickPatch, applied by commands.pick(hit, mods).
// The Picker class below only wires DOM pointer events and the raycaster to these rules.
import * as THREE from 'three'
import type { InstancePath, UiState } from '../core/types'
import type { PickMods } from '../core/selection'

export const CLICK_THRESHOLD_PX = 4
export const DOUBLE_CLICK_MS = 400

export interface PointerSample { x: number; y: number; t: number }

/** pointerup within `threshold` px (Euclidean, client pixels) of pointerdown */
export function isClick(down: PointerSample, up: PointerSample, threshold = CLICK_THRESHOLD_PX): boolean {
  return Math.hypot(up.x - down.x, up.y - down.y) <= threshold
}

/** `cur` is the second click of a double-click when the previous click was < 400 ms earlier and within 4 px */
export function isDoubleClick(prev: PointerSample | null, cur: PointerSample, maxMs = DOUBLE_CLICK_MS, maxPx = CLICK_THRESHOLD_PX): boolean {
  if (!prev) return false
  return cur.t - prev.t >= 0 && cur.t - prev.t <= maxMs && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= maxPx
}

export interface ClickInput {
  viewMode: UiState['viewMode']
  /** PointerEvent.button of the pointerup (0 = left) */
  button: number
  down: PointerSample | null
  up: PointerSample
  /** a gizmo drag started since pointerdown (or is still running) */
  gizmoDragged: boolean
  /** the previous accepted click (for double-click detection), or null */
  prevClick: PointerSample | null
  ctrl: boolean
}

export type ClickDecision = { pick: false } | { pick: true; mods: PickMods }

/** Should this pointerup pick, and with which modifiers? (§4.3) */
export function classifyClick(c: ClickInput): ClickDecision {
  if (c.viewMode !== 'context') return { pick: false }
  if (c.button !== 0 || !c.down || c.gizmoDragged) return { pick: false }
  if (!isClick(c.down, c.up)) return { pick: false }
  const mods: PickMods = {}
  if (c.ctrl) mods.ctrl = true
  if (isDoubleClick(c.prevClick, c.up)) mods.double = true
  return { pick: true, mods }
}

export interface Hit { distance: number; path: InstancePath }

/**
 * The picked occurrence path from raycast hits (any order): the nearest one; when several hits lie within `eps`
 * of the nearest distance (coincident surfaces, e.g. a shown boolean's result and its base operand), the deepest
 * path wins so operands stay pickable. null for no hits (empty space).
 */
export function chooseHit(hits: readonly Hit[], eps = 1e-3): InstancePath | null {
  if (hits.length === 0) return null
  let near = Infinity
  for (const h of hits) if (h.distance < near) near = h.distance
  let best: Hit | null = null
  for (const h of hits) {
    if (h.distance - near > eps * Math.max(1, near)) continue
    if (!best || h.path.length > best.path.length) best = h
  }
  return best ? [...best.path] : null
}

// ───────────────────────────── DOM wiring ─────────────────────────────

export interface PickerDeps {
  dom: HTMLElement
  camera: THREE.Camera
  viewMode(): UiState['viewMode']
  /** meshes to raycast: every visible mesh of the scene root (ghosts and shown operands included) */
  pickables(): THREE.Object3D[]
  /** true while the gizmo is dragging */
  gizmoDragging(): boolean
  /**
   * Did the gizmo drag of this press change the transform? A press-and-release on a handle without motion is a
   * click, not a drag, so it still picks (double-clicking a group whose gizmo sits under the pointer enters it).
   * Omitted: every gizmo press counts as a drag.
   */
  gizmoMoved?(): boolean
  onPick(hit: InstancePath | null, mods: PickMods): void
}

export class Picker {
  private readonly deps: PickerDeps
  private readonly raycaster = new THREE.Raycaster()
  private down: PointerSample | null = null
  private prevClick: PointerSample | null = null
  private gizmoDragged = false
  private readonly onDown: (e: PointerEvent) => void
  private readonly onUp: (e: PointerEvent) => void
  private readonly onCancel: () => void

  constructor(deps: PickerDeps) {
    this.deps = deps
    this.onDown = (e) => {
      if (!e.isPrimary) return
      this.down = { x: e.clientX, y: e.clientY, t: e.timeStamp }
      this.gizmoDragged = false
    }
    this.onUp = (e) => {
      if (!e.isPrimary) return
      const up: PointerSample = { x: e.clientX, y: e.clientY, t: e.timeStamp }
      // TransformControls' own pointerup ran first (it was attached to the canvas earlier), so a drag has committed
      const gizmoPress = deps.gizmoDragging() || this.gizmoDragged
      const gizmoDragged = deps.gizmoDragging() || (this.gizmoDragged && (deps.gizmoMoved?.() ?? true))
      const d = classifyClick({
        viewMode: deps.viewMode(), button: e.button, down: this.down, up,
        gizmoDragged, prevClick: this.prevClick, ctrl: e.ctrlKey || e.metaKey,
      })
      this.down = null
      // a motionless press on a gizmo handle does not pick on its own — but it is remembered as a first click, so
      // double-clicking a selected group whose gizmo sits under the pointer still enters it (§4.3)
      if (d.pick && gizmoPress && !d.mods.double) { this.prevClick = up; return }
      if (!d.pick) return
      this.prevClick = d.mods.double ? null : up
      deps.onPick(this.raycast(e.clientX, e.clientY), d.mods)
    }
    this.onCancel = () => { this.down = null }
    // capture phase: runs before TransformControls' own pointerdown on the same element, so the drag flag it
    // raises (via notifyGizmoDrag) belongs to this press
    deps.dom.addEventListener('pointerdown', this.onDown, { capture: true })
    deps.dom.addEventListener('pointerup', this.onUp)
    deps.dom.addEventListener('pointercancel', this.onCancel)
  }

  /** the gizmo started a drag (dragging-changed → true): the current press is not a click */
  notifyGizmoDrag(): void { this.gizmoDragged = true }

  /** Occurrence path under a client-space point, or null. */
  raycast(clientX: number, clientY: number): InstancePath | null {
    const rect = this.deps.dom.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.deps.camera)
    const hits: Hit[] = []
    for (const i of this.raycaster.intersectObjects(this.deps.pickables(), false)) {
      const path = i.object.userData.path as InstancePath | undefined
      if (path && path.length > 0) hits.push({ distance: i.distance, path })
    }
    return chooseHit(hits)
  }

  dispose(): void {
    this.deps.dom.removeEventListener('pointerdown', this.onDown, { capture: true })
    this.deps.dom.removeEventListener('pointerup', this.onUp)
    this.deps.dom.removeEventListener('pointercancel', this.onCancel)
  }
}
