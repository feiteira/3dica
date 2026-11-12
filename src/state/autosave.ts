// §6 autosave + boot restore. Every storage access is wrapped; the first failure calls onUnavailable once
// (wire it to toast('Autosave unavailable')).
import type { Project, UiState, Vec3 } from '../core/types'
import { parseProject } from '../core/project-io'
import { sampleProject, SAMPLE_EXPANDED } from '../core/sample'

export const KEY_CURRENT = '3dica:v1:current'
export const KEY_UI = '3dica:v1:ui'
export const KEY_BACKUP_META = '3dica:v1:backup-meta'
/**
 * Present while a job has been evaluating for a while (see markEvaluating). It is removed when the job ends and on
 * pagehide, so finding it at boot means the last session died mid-evaluation (a worker out-of-memory takes the whole
 * tab down) — boot then restores the project with its code paused instead of crashing again.
 */
export const KEY_EVALUATING = '3dica:v1:evaluating'
export const BACKUP_SLOTS = 5
export const backupKey = (n: number): string => `3dica:v1:backup:${((n % BACKUP_SLOTS) + BACKUP_SLOTS) % BACKUP_SLOTS}`

/** What `current` and the backups hold. `paused`: the code must not run until an explicit Run code (§0.2, §6). */
interface SavedRecord { savedAt: string; project: Project; paused?: true }

export interface SaveOptions {
  /** the project's code has not been allowed to run yet (after "Open without running"); restored as ui.evalPaused */
  paused?: boolean
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** What goes to '3dica:v1:ui' (§6): expanded rows, gizmo mode and space, snap, ghost and the camera. */
export interface UiPrefs {
  expanded: Record<string, boolean>
  gizmoMode: UiState['gizmoMode']
  gizmoSpace: UiState['gizmoSpace']
  snap: boolean
  ghostOthers: boolean
  camera?: { position: Vec3; target: Vec3 }
}

export interface BootResult {
  project: Project
  source: 'fresh' | 'current' | 'backup' | 'sample'
  /** toast to show, e.g. after a restore from a backup */
  message?: string
  /** stored ui prefs (null with ?fresh or when none / unreadable) */
  prefs: UiPrefs | null
  /** UiState patch to apply at boot: prefs, or SAMPLE_EXPANDED for the sample */
  ui: Partial<UiState>
}

export interface AutosaveOptions {
  /** default: globalThis.localStorage (looked up lazily inside try/catch) */
  storage?: StorageLike | null
  delayMs?: number          // default 1000 (§6 "1 s after the last commit")
  backupEveryMs?: number    // default 60000
  now?: () => number
  onUnavailable?: () => void
  /** after each successful project write (status bar "saved 12:01:33") */
  onSaved?: (at: Date) => void
}

export function uiPrefsFrom(ui: UiState, camera?: { position: Vec3; target: Vec3 }): UiPrefs {
  const p: UiPrefs = { expanded: { ...ui.expanded }, gizmoMode: ui.gizmoMode, gizmoSpace: ui.gizmoSpace, snap: ui.snap, ghostOthers: ui.ghostOthers }
  if (camera) p.camera = { position: [...camera.position] as Vec3, target: [...camera.target] as Vec3 }
  return p
}

export function uiPatchFromPrefs(p: UiPrefs): Partial<UiState> {
  return { expanded: { ...p.expanded }, gizmoMode: p.gizmoMode, gizmoSpace: p.gizmoSpace, snap: p.snap, ghostOthers: p.ghostOthers }
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))

/** A stored record → its project if parseProject accepts it (plus savedAt and the paused flag), else null. */
function readRecord(raw: string | null): { project: Project; savedAt: string; paused: boolean } | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as { savedAt?: unknown; project?: unknown; paused?: unknown }
    const r = parseProject(o?.project)
    return r.ok ? { project: r.project, savedAt: typeof o.savedAt === 'string' ? o.savedAt : '', paused: o.paused === true } : null
  } catch { return null }
}

function recordText(project: Project, at: Date, paused: boolean): string {
  const rec: SavedRecord = { savedAt: at.toISOString(), project }
  if (paused) rec.paused = true
  return JSON.stringify(rec)
}

function readPrefs(raw: string | null): UiPrefs | null {
  if (!raw) return null
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    if (!o || typeof o !== 'object') return null
    const expanded: Record<string, boolean> = {}
    if (o.expanded && typeof o.expanded === 'object') for (const [k, v] of Object.entries(o.expanded as object)) if (typeof v === 'boolean') expanded[k] = v
    const p: UiPrefs = {
      expanded,
      gizmoMode: o.gizmoMode === 'rotate' || o.gizmoMode === 'scale' ? o.gizmoMode : 'translate',
      gizmoSpace: o.gizmoSpace === 'local' ? 'local' : 'world',
      snap: o.snap !== false,
      ghostOthers: o.ghostOthers !== false,
    }
    const cam = o.camera as Record<string, unknown> | undefined
    if (cam && isVec3(cam.position) && isVec3(cam.target)) p.camera = { position: cam.position, target: cam.target }
    return p
  } catch {
    return null
  }
}

export class Autosave {
  private readonly opts: AutosaveOptions
  private readonly delayMs: number
  private readonly backupEveryMs: number
  private readonly now: () => number
  private timer: ReturnType<typeof setTimeout> | null = null
  private uiTimer: ReturnType<typeof setTimeout> | null = null
  private pending: { project: Project; paused: boolean } | null = null
  private pendingUi: UiPrefs | null = null
  private warned = false
  /** last value written by markEvaluating (undefined = unknown, so the first call always writes) */
  private evaluating: string | null | undefined = undefined

  constructor(opts: AutosaveOptions = {}) {
    this.opts = opts
    this.delayMs = opts.delayMs ?? 1000
    this.backupEveryMs = opts.backupEveryMs ?? 60_000
    this.now = opts.now ?? (() => Date.now())
  }

  private storage(): StorageLike {
    if (this.opts.storage) return this.opts.storage
    if (this.opts.storage === null) throw new Error('no storage')
    return globalThis.localStorage
  }

  private fail(): void {
    if (this.warned) return
    this.warned = true
    this.opts.onUnavailable?.()
  }

  /** Debounced save: writes `project` delayMs after the last call (call it after every committed change). */
  schedule(project: Project, opts: SaveOptions = {}): void {
    this.pending = { project, paused: !!opts.paused }
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, this.delayMs)
  }

  /** Write a pending project (and pending ui prefs) now. */
  flush(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    const p = this.pending
    this.pending = null
    if (p) this.saveNow(p.project, { paused: p.paused })
    if (this.uiTimer !== null) { clearTimeout(this.uiTimer); this.uiTimer = null }
    const u = this.pendingUi
    this.pendingUi = null
    if (u) this.saveUiNow(u)
  }

  /** Drop pending writes (tests / teardown). */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.uiTimer !== null) clearTimeout(this.uiTimer)
    this.timer = this.uiTimer = null
    this.pending = null
    this.pendingUi = null
  }

  /**
   * Write `current` = JSON.stringify({ savedAt, project, paused? }). If the last backup is more than backupEveryMs old,
   * first copy the previous `current` to backup:<n % 5> — but only when parseProject accepts it, so an unloadable
   * state never rotates over the good backups. The backup copy is best effort and never blocks the write of
   * `current`; when `current` itself does not fit, backups are dropped oldest first to make room.
   * Returns false when `current` could not be written.
   */
  saveNow(project: Project, opts: SaveOptions = {}): boolean {
    let s: StorageLike
    try { s = this.storage() } catch { this.fail(); return false }
    const now = this.now()
    let meta = { n: 0, at: 0 }
    try {
      const m = JSON.parse(s.getItem(KEY_BACKUP_META) ?? 'null') as { n?: unknown; at?: unknown } | null
      if (m && typeof m.n === 'number' && Number.isInteger(m.n) && typeof m.at === 'number') meta = { n: ((m.n % BACKUP_SLOTS) + BACKUP_SLOTS) % BACKUP_SLOTS, at: m.at }
    } catch { /* corrupt or unreadable meta: start over */ }
    if (now - meta.at > this.backupEveryMs) {
      try {
        const prev = s.getItem(KEY_CURRENT)
        if (prev) {
          // (an unloadable prev is skipped, and not parsed again before the next backup is due)
          const next = { n: meta.n, at: now }
          if (readRecord(prev)) {
            const key = backupKey(meta.n)
            let ok = this.trySet(s, key, prev)
            if (!ok) {
              // the slot being replaced is the oldest backup: free it and try once more
              try { s.removeItem(key) } catch { /* ignore */ }
              ok = this.trySet(s, key, prev)
            }
            if (ok) next.n = (meta.n + 1) % BACKUP_SLOTS
          }
          meta = next
          s.setItem(KEY_BACKUP_META, JSON.stringify(meta))
        }
      } catch { /* the backup is best effort; `current` below matters more */ }
    }
    const at = new Date(now)
    const text = recordText(project, at, !!opts.paused)
    let written = this.trySet(s, KEY_CURRENT, text)
    // out of room: give up backups, oldest first (meta.n is the next slot to write = the oldest)
    for (let i = 0; !written && i < BACKUP_SLOTS; i++) {
      try { s.removeItem(backupKey(meta.n + i)) } catch { /* ignore */ }
      written = this.trySet(s, KEY_CURRENT, text)
    }
    if (!written) { this.fail(); return false }
    this.opts.onSaved?.(at)
    return true
  }

  private trySet(s: StorageLike, key: string, value: string): boolean {
    try { s.setItem(key, value); return true } catch { return false }
  }

  /**
   * Crash marker (§12.5 "work is lost"): call with the def name while a job has been running for a while, and with
   * null when nothing runs (and on pagehide). Writes only on change.
   */
  markEvaluating(defName: string | null): void {
    if (defName === this.evaluating) return
    this.evaluating = defName
    try {
      const s = this.storage()
      if (defName === null) s.removeItem(KEY_EVALUATING)
      else s.setItem(KEY_EVALUATING, JSON.stringify({ defName, at: new Date(this.now()).toISOString() }))
    } catch { /* best effort */ }
  }

  /** Debounced write of ui prefs (camera moves call this often). */
  scheduleUi(prefs: UiPrefs): void {
    this.pendingUi = prefs
    if (this.uiTimer !== null) clearTimeout(this.uiTimer)
    this.uiTimer = setTimeout(() => {
      this.uiTimer = null
      const u = this.pendingUi
      this.pendingUi = null
      if (u) this.saveUiNow(u)
    }, this.delayMs)
  }

  saveUiNow(prefs: UiPrefs): boolean {
    try { this.storage().setItem(KEY_UI, JSON.stringify(prefs)); return true } catch { this.fail(); return false }
  }

  loadUi(): UiPrefs | null {
    try { return readPrefs(this.storage().getItem(KEY_UI)) } catch { this.fail(); return null }
  }

  /**
   * Boot (§6): `?fresh` → the sample (autosave and ui prefs ignored). Otherwise `current`, then backups newest to
   * oldest, each through parseProject; otherwise the sample. A restore from a backup sets `message`.
   * A record saved while the code was paused (after "Open without running") boots paused again (ui.evalPaused), and so
   * does any project when the last session died while evaluating (KEY_EVALUATING still set): imported or crashing
   * code never runs again without an explicit Run code. Pass location.search.
   */
  boot(search: string): BootResult {
    const params = new URLSearchParams(search)
    const sampleUi: Partial<UiState> = { expanded: { ...SAMPLE_EXPANDED } }
    if (params.has('fresh')) return { project: sampleProject(), source: 'fresh', prefs: null, ui: sampleUi }
    let s: StorageLike
    try { s = this.storage() } catch { this.fail(); return { project: sampleProject(), source: 'sample', prefs: null, ui: sampleUi } }
    const prefs = this.loadUi()
    const withPrefs = (fallback: Partial<UiState>): Partial<UiState> => (prefs ? uiPatchFromPrefs(prefs) : fallback)
    let crashedIn: string | null = null
    try {
      const raw = s.getItem(KEY_EVALUATING)
      if (raw) {
        try { const o = JSON.parse(raw) as { defName?: unknown }; crashedIn = typeof o?.defName === 'string' && o.defName ? o.defName : '?' } catch { crashedIn = '?' }
        s.removeItem(KEY_EVALUATING)
      }
    } catch { /* unreadable: treat as no marker */ }
    const crashNote = crashedIn === null ? undefined
      : `3Dica stopped while evaluating ${crashedIn === '?' ? 'an object' : `'${crashedIn}'`} last time (out of memory?). Its code is paused — fix it, then click Run code.`
    const join = (...m: (string | undefined)[]) => m.filter(Boolean).join(' ') || undefined
    const restore = (rec: { project: Project; paused: boolean }, source: 'current' | 'backup', message?: string): BootResult => {
      const paused = rec.paused || crashedIn !== null
      const ui: Partial<UiState> = withPrefs({})
      if (paused) {
        ui.evalPaused = true
        // keep the paused flag with the project, so a second reload does not run the code either
        if (!rec.paused) this.trySet(s, KEY_CURRENT, recordText(rec.project, new Date(this.now()), true))
      }
      const out: BootResult = { project: rec.project, source, prefs, ui }
      const msg = join(message, crashNote)
      if (msg) out.message = msg
      return out
    }
    try {
      const cur = readRecord(s.getItem(KEY_CURRENT))
      if (cur) return restore(cur, 'current')
      const backups: { project: Project; savedAt: string; paused: boolean }[] = []
      for (let n = 0; n < BACKUP_SLOTS; n++) { const b = readRecord(s.getItem(backupKey(n))); if (b) backups.push(b) }
      backups.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0))
      if (backups.length) {
        const b = backups[0]
        const when = b.savedAt ? new Date(b.savedAt).toLocaleString() : 'an earlier session'
        return restore(b, 'backup', `Restored an autosave backup from ${when}`)
      }
    } catch {
      this.fail()
    }
    return { project: sampleProject(), source: 'sample', prefs, ui: withPrefs(sampleUi) }
  }
}
