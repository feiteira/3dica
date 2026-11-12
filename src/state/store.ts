// §4.12 Store: the single source of truth for the project (undoable) and the UI state (not in history).
import type { InstancePath, Project, Selection, UiState } from '../core/types'
import { OpError } from '../core/ops'
import { defAtPath, samePath, validPrefix } from '../core/graph'
import { History, type UpdateOpts } from './history'

export type { UpdateOpts } from './history'

export interface StoreChange {
  /** the project object changed (update / undo / redo / reset) */
  project: boolean
  /** ui changed (setUi, or fixSelection after a project change) */
  ui: boolean
  source: 'update' | 'undo' | 'redo' | 'ui' | 'reset'
  /** history label for update / undo / redo */
  label?: string
}

export type UpdateResult<T> = { ok: true; value: T; changed: boolean } | { ok: false; error: string }

export interface StoreOptions {
  /** called with OpError messages (wire to ctx.toast(msg, 'error')); default: no-op */
  onError?: (message: string) => void
  now?: () => number
  cap?: number
}

export function defaultUi(): UiState {
  return {
    selection: { kind: 'none' }, context: [], viewMode: 'context', ghostOthers: true,
    gizmoMode: 'translate', gizmoSpace: 'world', snap: true, expanded: {}, evalPaused: false,
  }
}

/**
 * Treat `store.project` and `store.ui` as immutable snapshots: never mutate them. Change the project only through
 * update(); change ui only through setUi(). Subscribers run synchronously after every change.
 */
export class Store {
  project: Project
  ui: UiState
  readonly history: History
  onError: (message: string) => void
  private readonly now: () => number
  private listeners: ((change: StoreChange) => void)[] = []

  constructor(project: Project, ui: Partial<UiState> = {}, opts: StoreOptions = {}) {
    this.project = project
    this.ui = { ...defaultUi(), ...ui }
    this.history = new History(opts.cap)
    this.onError = opts.onError ?? (() => {})
    this.now = opts.now ?? (() => Date.now())
    this.fixSelection()
  }

  /**
   * §4.12: draft = structuredClone(project); recipe(draft). OpError → onError(message), nothing changes, {ok:false}.
   * Any other exception propagates (a bug) and nothing changes. A recipe that leaves the project equal is a no-op
   * (no history entry, no notification; changed: false). Otherwise push history (with coalescing), set project,
   * fixSelection(), notify. Returns the recipe's value (e.g. a new path).
   */
  update<T>(label: string, recipe: (draft: Project) => T, opts: UpdateOpts = {}): UpdateResult<T> {
    const before = this.project
    const draft = structuredClone(before)
    let value: T
    try {
      value = recipe(draft)
    } catch (e) {
      if (e instanceof OpError) { this.onError(e.message); return { ok: false, error: e.message } }
      throw e
    }
    if (JSON.stringify(draft) === JSON.stringify(before)) return { ok: true, value, changed: false }
    this.history.record(label, before, opts, this.now())
    this.project = draft
    const ui = this.fixSelection(true)
    this.emit({ project: true, ui, source: 'update', label })
    return { ok: true, value, changed: true }
  }

  undo(): boolean {
    const r = this.history.undo(this.project, this.now())
    if (!r) return false
    this.project = r.project
    const ui = this.fixSelection(true)
    this.emit({ project: true, ui, source: 'undo', label: r.label })
    return true
  }

  redo(): boolean {
    const r = this.history.redo(this.project, this.now())
    if (!r) return false
    this.project = r.project
    const ui = this.fixSelection(true)
    this.emit({ project: true, ui, source: 'redo', label: r.label })
    return true
  }

  /** Shallow-merge a ui patch (keys set to undefined are removed), validate selection/context, notify. */
  setUi(patch: Partial<UiState> | ((ui: UiState) => Partial<UiState>)): void {
    const p = typeof patch === 'function' ? patch(this.ui) : patch
    const next = { ...this.ui, ...p } as UiState & Record<string, unknown>
    for (const [k, v] of Object.entries(p)) if (v === undefined) delete next[k]
    this.ui = next
    this.fixSelection(true)
    this.emit({ project: false, ui: true, source: 'ui' })
  }

  /** Replace the project (New, Sample, Open, boot): history is reset, ui patched and validated. */
  reset(project: Project, ui: Partial<UiState> = {}): void {
    this.project = project
    this.history.clear()
    const next = { ...this.ui, ...ui } as UiState & Record<string, unknown>
    for (const [k, v] of Object.entries(ui)) if (v === undefined) delete next[k]
    this.ui = next
    this.fixSelection(true)
    this.emit({ project: true, ui: true, source: 'reset' })
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(cb: (change: StoreChange) => void): () => void {
    this.listeners.push(cb)
    return () => { this.listeners = this.listeners.filter((l) => l !== cb) }
  }

  /**
   * §4.12 fixSelection: an occurrence selection is cut to its longest valid prefix (or none); a def selection becomes
   * none when the def is gone (or is the root); the context is cut the same way and further until it names a group.
   * Returns whether ui changed. With `silent` it does not notify (callers emit one combined change);
   * called directly it notifies when something changed.
   */
  fixSelection(silent = false): boolean {
    const ui = this.ui
    let selection: Selection = ui.selection
    if (selection.kind === 'occ') {
      const p = validPrefix(this.project, selection.path)
      if (p.length === 0) selection = { kind: 'none' }
      else if (p.length !== selection.path.length) selection = { kind: 'occ', path: p }
    } else if (selection.kind === 'def') {
      if (!this.project.defs[selection.def] || selection.def === this.project.root) selection = { kind: 'none' }
    }
    let context: InstancePath = validPrefix(this.project, ui.context)
    while (context.length > 0 && defAtPath(this.project, context)?.kind !== 'group') context = context.slice(0, -1)
    if (context.length === ui.context.length && samePath(context, ui.context)) context = ui.context
    if (selection === ui.selection && context === ui.context) return false
    const next: UiState = { ...ui, selection, context }
    // the isolated thing is gone (undo of its Add, Delete…): isolate has nothing to show, so return to the scene
    // instead of a frozen view that looks like context mode but cannot be picked
    if (ui.viewMode === 'isolate' && selection.kind === 'none' && ui.selection.kind !== 'none') {
      next.viewMode = 'context'
      delete next.autoIsolatedFrom
    }
    this.ui = next
    if (!silent) this.emit({ project: false, ui: true, source: 'ui' })
    return true
  }

  canUndo(): boolean { return this.history.canUndo() }
  canRedo(): boolean { return this.history.canRedo() }

  private emit(change: StoreChange): void {
    for (const l of [...this.listeners]) l(change)
  }
}
