// §4.3 / §4.4 selection, context and isolate rules as pure UiState patches.
// Used by app/commands.ts (tree, library, breadcrumb, Enter, Esc) and view/picking.ts (via commands.pick).
// Every function returns a Partial<UiState> to pass to store.setUi(); none of them touch history.
import type { Definition, Id, InstancePath, ParamValue, Project, Selection, UiState } from './types'
import { defAtPath, isPrefix, resolvePath, type Occurrence } from './graph'
import { resolveParams } from './params'

const NONE: Selection = { kind: 'none' }

/** Tree row click (§4.3): select the occurrence, context = its parent; undo an auto-isolate from a Library click. */
export function treeSelectPatch(ui: UiState, path: InstancePath): Partial<UiState> {
  const patch: Partial<UiState> = { selection: { kind: 'occ', path: [...path] }, context: path.slice(0, -1) }
  if (ui.autoIsolatedFrom) { patch.viewMode = ui.autoIsolatedFrom; patch.autoIsolatedFrom = undefined }
  return patch
}

/** Library row click (§4.3): select the def and force isolate, remembering the previous mode once. */
export function librarySelectPatch(ui: UiState, defId: Id): Partial<UiState> {
  return { selection: { kind: 'def', def: defId }, viewMode: 'isolate', autoIsolatedFrom: ui.autoIsolatedFrom ?? ui.viewMode }
}

export interface PickMods { ctrl?: boolean; double?: boolean }

/**
 * Viewport click (§4.3, context mode only). `hit` is the picked mesh's userData.path, or null for empty space.
 * - empty space: selection none, context unchanged
 * - Ctrl: deepest leaf — selection = hit, context = hit.slice(0, -1)
 * - hit outside the context: context = [] and select hit.slice(0, 1) (then the double-click rule may apply at k = 0)
 * - plain: select hit.slice(0, k + 1) (k = context.length)
 * - double-click on a group occurrence at this level: context = hit.slice(0, k + 1), selection = hit.slice(0, k + 2) or none
 */
export function pickPatch(project: Project, ui: UiState, hit: InstancePath | null, mods: PickMods = {}): Partial<UiState> {
  if (!hit || hit.length === 0) return { selection: NONE }
  if (mods.ctrl) return { selection: { kind: 'occ', path: [...hit] }, context: hit.slice(0, -1) }
  let context = ui.context
  // the entered group's own mesh (a boolean result): select it and step out one level
  if (context.length > 0 && context.length === hit.length && isPrefix(context, hit)) {
    return { selection: { kind: 'occ', path: [...hit] }, context: hit.slice(0, -1) }
  }
  if (!isPrefix(context, hit)) context = []
  const k = context.length
  const target = hit.slice(0, k + 1)
  if (mods.double) {
    const def = defAtPath(project, target)
    if (def?.kind === 'group') {
      const sel: Selection = hit.length >= k + 2 ? { kind: 'occ', path: hit.slice(0, k + 2) } : NONE
      return { context: target, selection: sel }
    }
  }
  return { context, selection: { kind: 'occ', path: target } }
}

/** Enter (§4.3): with a group occurrence selected, enter it. null when not applicable. */
export function enterPatch(project: Project, ui: UiState): Partial<UiState> | null {
  if (ui.selection.kind !== 'occ') return null
  const def = defAtPath(project, ui.selection.path)
  if (def?.kind !== 'group') return null
  return { context: [...ui.selection.path], selection: NONE }
}

/** Esc (§4.3), in order: exit isolate; else pop the context (selecting it); else deselect. */
export function escapePatch(ui: UiState): Partial<UiState> {
  if (ui.viewMode === 'isolate') return { viewMode: 'context', autoIsolatedFrom: undefined }
  if (ui.context.length > 0) return { selection: { kind: 'occ', path: [...ui.context] }, context: ui.context.slice(0, -1) }
  return { selection: NONE }
}

/** The path the breadcrumb shows: the selected occurrence if it lies in the context, else the context. */
export function breadcrumbPath(ui: UiState): InstancePath {
  if (ui.selection.kind === 'occ' && isPrefix(ui.context, ui.selection.path)) return ui.selection.path
  return ui.context
}

/**
 * Breadcrumb click (§4.3). Segment 0 is "Scene"; segment j ≥ 1 is breadcrumbPath(ui)[j - 1].
 * - 0: context = [], selection none
 * - j < path.length: context = path.slice(0, j), select path.slice(0, j + 1) (the next segment)
 * - j = path.length (the last segment): context = path.slice(0, -1), select path
 */
export function breadcrumbPatch(ui: UiState, j: number): Partial<UiState> {
  const p = breadcrumbPath(ui)
  if (j <= 0 || p.length === 0) return { context: [], selection: NONE }
  if (j < p.length) return { context: p.slice(0, j), selection: { kind: 'occ', path: p.slice(0, j + 1) } }
  return { context: p.slice(0, -1), selection: { kind: 'occ', path: [...p] } }
}

/**
 * The tooltip of breadcrumb segment j, saying what breadcrumbPatch does: `labels` are the shown names of
 * breadcrumbPath(ui) (segment j ≥ 1 is labels[j - 1]). A middle segment ENTERS that group and selects the next
 * segment (§4.3); the group itself is then one Esc away.
 */
export function breadcrumbTitle(labels: string[], j: number): string {
  if (j <= 0 || labels.length === 0) return 'Back to the whole scene (clears the selection)'
  if (j < labels.length) return `Enter '${labels[j - 1]}' and select '${labels[j]}' (then Esc selects '${labels[j - 1]}' itself)`
  return `Select '${labels[labels.length - 1]}'`
}

/**
 * Keys of boolean occurrences whose operands are shown (§4.4): the boolean occurrence, or anything inside it,
 * is selected or is the context. Only meaningful in context mode (isolate paths never match).
 */
export function shownOperandBools(occurrences: Occurrence[], ui: UiState): Set<string> {
  const out = new Set<string>()
  const sel = ui.selection.kind === 'occ' ? ui.selection.path : null
  for (const o of occurrences) {
    if (o.role !== 'bool') continue
    if ((sel && isPrefix(o.path, sel)) || (ui.context.length > 0 && isPrefix(o.path, ui.context))) out.add(o.key)
  }
  return out
}

export interface IsolateTarget {
  defId: Id
  /** overrides for the synthetic instance: the selected occurrence's instance.params; undefined for a def selection */
  params?: Record<string, ParamValue>
}

/**
 * What isolate mode shows (§4.4): the selected occurrence's def with that occurrence's params, or the selected
 * Library def with defaults. null when not in isolate mode or nothing (valid) is selected.
 * Feed it to expand(project, { rootDef: t.defId, rootParams: t.params }).
 */
export function isolateTarget(project: Project, ui: UiState): IsolateTarget | null {
  if (ui.viewMode !== 'isolate') return null
  const sel = ui.selection
  if (sel.kind === 'def') return project.defs[sel.def] && sel.def !== project.root ? { defId: sel.def } : null
  if (sel.kind === 'occ') {
    const steps = resolvePath(project, sel.path)
    if (!steps || steps.length === 0) return null
    const inst = steps[steps.length - 1].instance
    return inst.params ? { defId: inst.def, params: inst.params } : { defId: inst.def }
  }
  return null
}

/** "Bolt (length 12, diameter 5)" — the def name plus its resolved params (no parentheses when there are none). */
export function isolateLabel(def: Definition, params?: Record<string, ParamValue>): string {
  const p = resolveParams(def, params)
  const parts = Object.entries(p).map(([k, v]) => `${k} ${v}`)
  return parts.length ? `${def.name} (${parts.join(', ')})` : def.name
}

/** The isolate banner text (§4.4). */
export function isolateBanner(def: Definition, params?: Record<string, ParamValue>): string {
  return `Isolated: ${isolateLabel(def, params)} — I or Esc to return`
}
