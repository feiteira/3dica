// §4.12 undo/redo history: snapshot stacks with coalescing and a 200-entry cap.
import type { Project } from '../core/types'

export interface HistoryEntry {
  label: string
  /** past entries: the project BEFORE the step; future entries: the project AFTER the step (to redo to) */
  project: Project
  coalesce?: string
  at: number
}

export interface UpdateOpts {
  /** coalescing key, e.g. 'xf:' + instanceId + ':' + field, 'param:' + instanceId + ':' + name, 'code:' + defId */
  coalesce?: string
  /** coalescing window in ms (default 500; code edits use 2000) */
  window?: number
}

export const HISTORY_CAP = 200
export const DEFAULT_COALESCE_WINDOW = 500

export class History {
  past: HistoryEntry[] = []
  future: HistoryEntry[] = []
  readonly cap: number

  constructor(cap = HISTORY_CAP) {
    this.cap = cap
  }

  /**
   * Record a committed change whose previous state was `before`. Clears the redo stack.
   * Coalescing: if opts.coalesce equals the top entry's key and now - top.at < (opts.window ?? 500), no entry is
   * pushed (undo still returns to the state before the whole run) and the top entry's `at` is refreshed.
   */
  record(label: string, before: Project, opts: UpdateOpts = {}, now = Date.now()): 'pushed' | 'coalesced' {
    this.future = []
    const top = this.past[this.past.length - 1]
    if (opts.coalesce !== undefined && top && top.coalesce === opts.coalesce && now - top.at < (opts.window ?? DEFAULT_COALESCE_WINDOW)) {
      top.at = now
      return 'coalesced'
    }
    const e: HistoryEntry = { label, project: before, at: now }
    if (opts.coalesce !== undefined) e.coalesce = opts.coalesce
    this.past.push(e)
    while (this.past.length > this.cap) this.past.shift()
    return 'pushed'
  }

  /** Undo from `current`: returns the project to restore and the undone step's label, or null. */
  undo(current: Project, now = Date.now()): { project: Project; label: string } | null {
    const e = this.past.pop()
    if (!e) return null
    this.future.push({ label: e.label, project: current, at: now })
    return { project: e.project, label: e.label }
  }

  /** Redo from `current`: returns the project to restore and the redone step's label, or null. */
  redo(current: Project, now = Date.now()): { project: Project; label: string } | null {
    const e = this.future.pop()
    if (!e) return null
    // no coalesce key: a later edit never merges into a redone step
    this.past.push({ label: e.label, project: current, at: now })
    return { project: e.project, label: e.label }
  }

  clear(): void { this.past = []; this.future = [] }
  canUndo(): boolean { return this.past.length > 0 }
  canRedo(): boolean { return this.future.length > 0 }
  /** label of the step Ctrl+Z would undo (toolbar tooltip "Undo Move Bolt") */
  undoLabel(): string | undefined { return this.past[this.past.length - 1]?.label }
  redoLabel(): string | undefined { return this.future[this.future.length - 1]?.label }
  /** past: oldest → newest (past.at(-1) is the next undo); future: stack order (future.at(-1) is the next redo). */
  labels(): { past: string[]; future: string[] } {
    return { past: this.past.map((e) => e.label), future: this.future.map((e) => e.label) }
  }
}
