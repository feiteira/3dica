// §4.4 / §5.6 materials: a cache keyed by (color, state), plus the PURE rules that pick a mesh's display state.
// Colors themselves come from core/colors.ts (§2.4); this module only decides how a resolved color is drawn.
import * as THREE from 'three'
import type { Id, InstancePath } from '../core/types'
import { isPrefix, pathKey, type OperandRole } from '../core/graph'

export type MaterialState =
  | 'normal' | 'selected' | 'linked' | 'ghost' | 'ghostLinked' | 'stale' | 'error'
  | 'operandBase' | 'operandCut' | 'operandOther'

/** How the displayed entry relates to the wanted key (§5.6): ready, pending (last good shown), failed (last good shown). */
export type EntryStatus = 'ok' | 'stale' | 'error'

export const SELECTED_EMISSIVE = '#2255aa'
export const SELECTED_EMISSIVE_INTENSITY = 0.35
export const LINKED_EMISSIVE = '#7a3cff'
export const LINKED_EMISSIVE_INTENSITY = 0.25
export const OUTLINE_COLOR = '#4da3ff'
export const CUT_COLOR = '#ff4d4d'
export const ERROR_EMISSIVE = '#ff2020'
export const ERROR_EMISSIVE_INTENSITY = 0.4
export const GHOST_OPACITY = 0.15
export const GHOST_LINKED_OPACITY = 0.3
export const STALE_OPACITY = 0.6

// ───────────────────────────── pure display rules ─────────────────────────────

/** Everything the display rules need about the current view, computed once per reconcile. */
export interface StyleInput {
  /** isolate root: always plain materials (no selection highlight, tint or ghosting) */
  isolate: boolean
  /** the selected occurrence path (scene), or null */
  selPath: InstancePath | null
  /** def id of the selected occurrence, or of the selected Library def; null for no selection */
  selDef: Id | null
  /** true when the selection is a Library def (context mode): every occurrence of it counts as selected */
  selIsDef: boolean
  context: InstancePath
  ghostOthers: boolean
  /** keys of boolean occurrences whose operands are shown */
  shownOperands: ReadonlySet<string>
  /** def id of the occurrence with this key (scene expansion) */
  defAt: (key: string) => Id | undefined
}

/** The occurrence fields the display rules look at (a subset of core/graph Occurrence). */
export interface StyledOccurrence {
  key: string
  path: InstancePath
  role: 'code' | 'group' | 'bool'
  operandOf?: string
  operandRole?: OperandRole
}

export interface DisplayState {
  state: MaterialState
  /** draw the EdgesGeometry outline (selected) */
  outline: boolean
}

/** Some occurrence on `path` (itself or an ancestor deeper than `minDepth`) places `defId` — and is not `exclude`. */
function onPathWithDef(path: InstancePath, defId: Id, s: StyleInput, exclude: InstancePath | null, minDepth = 0): boolean {
  for (let j = minDepth + 1; j <= path.length; j++) {
    if (exclude && j === exclude.length && isPrefix(path.slice(0, j), exclude)) continue
    if (s.defAt(pathKey(path.slice(0, j))) === defId) return true
  }
  return false
}

/**
 * The material state of the meshes an occurrence draws itself (a code leaf, or a boolean's result), §4.4:
 * - isolate: normal
 * - a shown boolean's result while one of its operands is selected: ghost (checked first: nested booleans too)
 * - operand of a shown boolean: selected if the selection is this operand (or an ancestor of it below the boolean),
 *   else operandBase / operandCut / operandOther
 * - inside the selected subtree: selected (+ outline)
 * - ghostOthers with a selection: everything else ghost (ghostLinked for other occurrences of the selected def);
 *   with nothing selected inside an entered context: everything outside the context ghost
 * - other occurrences of the selected def: linked (purple tint)
 * Then a stale / failed entry replaces normal / selected / linked with stale / error (the outline stays).
 */
export function displayState(occ: StyledOccurrence, status: EntryStatus, s: StyleInput): DisplayState {
  let state: MaterialState
  let outline = false
  if (s.isolate) {
    state = 'normal'
  } else {
    const inSel = s.selIsDef
      ? (s.selDef !== null && onPathWithDef(occ.path, s.selDef, s, null))
      : (s.selPath !== null && isPrefix(s.selPath, occ.path))
    const hasSelection = s.selPath !== null || s.selIsDef
    if (occ.role === 'bool' && s.shownOperands.has(occ.key) && s.selPath !== null
      && s.selPath.length > occ.path.length && isPrefix(occ.path, s.selPath)) {
      // a shown boolean's result while one of its operands (or something inside one) is selected: ghost — also when
      // this boolean is itself an operand of an outer boolean (nested booleans)
      state = 'ghost'
    } else if (occ.operandOf !== undefined) {
      // highlighted only when the selection reaches INTO the boolean (an operand, or something inside one);
      // selecting the boolean itself shows its operands with the operand materials
      const boolDepth = occ.operandOf.split('/').length
      const intoOperand = s.selIsDef
        ? (s.selDef !== null && onPathWithDef(occ.path, s.selDef, s, null, boolDepth))
        : (inSel && s.selPath!.length > boolDepth)
      if (intoOperand) { state = 'selected'; outline = true }
      else state = occ.operandRole === 'base' ? 'operandBase' : occ.operandRole === 'cut' ? 'operandCut' : 'operandOther'
    } else if (inSel) {
      state = 'selected'
      outline = true
    } else {
      const linked = !s.selIsDef && s.selDef !== null && onPathWithDef(occ.path, s.selDef, s, s.selPath)
      const ghost = s.ghostOthers && (hasSelection || (s.context.length > 0 && !isPrefix(s.context, occ.path)))
      if (ghost) state = linked ? 'ghostLinked' : 'ghost'
      else state = linked ? 'linked' : 'normal'
    }
  }
  if (status !== 'ok' && (state === 'normal' || state === 'selected' || state === 'linked')) state = status
  return { state, outline }
}

// ───────────────────────────── material cache ─────────────────────────────

function normHex(color: string): string {
  const c = color.trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(c) ? c : '#9aa4b2'
}

/** Mix two '#rrggbb' colors in sRGB space. */
function mixHex(a: string, b: string, t: number): string {
  const ca = new THREE.Color(a), cb = new THREE.Color(b)
  return '#' + ca.lerp(cb, t).getHexString()
}

/**
 * Materials shared by every mesh with the same (color, state). The base is
 * MeshStandardMaterial({ metalness: 0.1, roughness: 0.7 }); solid faces get a small polygon offset so the
 * selection outline (EdgesGeometry) draws cleanly on top.
 */
export class Materials {
  private readonly cache = new Map<string, THREE.Material>()
  readonly outline: THREE.LineBasicMaterial

  constructor() {
    this.outline = new THREE.LineBasicMaterial({ color: OUTLINE_COLOR })
  }

  get(color: string, state: MaterialState): THREE.Material {
    const hex = state === 'operandCut' ? CUT_COLOR : normHex(color)
    const key = hex + '|' + state
    let m = this.cache.get(key)
    if (!m) {
      m = create(hex, state)
      this.cache.set(key, m)
    }
    return m
  }

  /** number of cached materials (debugging) */
  size(): number { return this.cache.size }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose()
    this.cache.clear()
    this.outline.dispose()
  }
}

function create(hex: string, state: MaterialState): THREE.Material {
  const m = new THREE.MeshStandardMaterial({ color: hex, metalness: 0.1, roughness: 0.7 })
  m.polygonOffset = true
  m.polygonOffsetFactor = 1
  m.polygonOffsetUnits = 1
  const translucent = (opacity: number) => { m.transparent = true; m.opacity = opacity; m.depthWrite = false }
  // jscad CSG results have T-junctions, which rasterize as pin-hole cracks on flat faces. Drawing the back faces of
  // opaque solids fills those cracks with the (similarly lit) inside instead of the dark background. Translucent
  // states stay front-sided so ghosts and operands do not double their layers.
  if (state === 'normal' || state === 'selected' || state === 'linked' || state === 'error') m.side = THREE.DoubleSide
  switch (state) {
    case 'normal':
      break
    case 'selected':
      m.emissive.set(SELECTED_EMISSIVE)
      m.emissiveIntensity = SELECTED_EMISSIVE_INTENSITY
      break
    case 'linked':
      m.emissive.set(LINKED_EMISSIVE)
      m.emissiveIntensity = LINKED_EMISSIVE_INTENSITY
      break
    case 'ghost':
      translucent(GHOST_OPACITY)
      break
    case 'ghostLinked':
      m.color.set(mixHex(hex, LINKED_EMISSIVE, 0.6))
      m.emissive.set(LINKED_EMISSIVE)
      m.emissiveIntensity = LINKED_EMISSIVE_INTENSITY
      translucent(GHOST_LINKED_OPACITY)
      break
    case 'stale':
      m.transparent = true
      m.opacity = STALE_OPACITY
      break
    case 'error':
      m.emissive.set(ERROR_EMISSIVE)
      m.emissiveIntensity = ERROR_EMISSIVE_INTENSITY
      break
    case 'operandBase':
      m.wireframe = true
      m.polygonOffset = false
      translucent(0.35)
      break
    case 'operandCut':
      translucent(0.3)
      break
    case 'operandOther':
      translucent(0.25)
      break
  }
  return m
}
