import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { Autosave, KEY_CURRENT, KEY_EVALUATING, KEY_UI, backupKey, uiPrefsFrom, type StorageLike } from '../../src/state/autosave'
import { Store } from '../../src/state/store'
import * as ops from '../../src/core/ops'
import { sampleProject, SAMPLE_EXPANDED } from '../../src/core/sample'
import { emptyProject } from '../../src/core/project-io'
import { defaultUi } from '../../src/state/store'
import { Clipboard, clipFromPath } from '../../src/state/clipboard'

class MemStorage implements StorageLike {
  map = new Map<string, string>()
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null }
  setItem(k: string, v: string) { this.map.set(k, v) }
  removeItem(k: string) { this.map.delete(k) }
}
const broken: StorageLike = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }

describe('autosave', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  test('debounces 1 s after the last commit, then boot restores current', () => {
    const storage = new MemStorage()
    let now = 1_000_000
    const saved: Date[] = []
    const a = new Autosave({ storage, now: () => now, onSaved: (d) => saved.push(d) })
    const p = sampleProject()
    p.name = 'Mine'
    a.schedule(p)
    vi.advanceTimersByTime(900)
    a.schedule(p)
    vi.advanceTimersByTime(900)
    expect(storage.getItem(KEY_CURRENT)).toBeNull()
    vi.advanceTimersByTime(200)
    expect(JSON.parse(storage.getItem(KEY_CURRENT)!).project.name).toBe('Mine')
    expect(saved.length).toBe(1)
    const b = new Autosave({ storage }).boot('')
    expect(b.source).toBe('current')
    expect(b.project.name).toBe('Mine')
    now += 1
  })

  test('?fresh loads the sample and ignores autosave; nothing stored → sample', () => {
    const storage = new MemStorage()
    new Autosave({ storage }).saveNow(emptyProject('X'))
    const f = new Autosave({ storage }).boot('?fresh')
    expect(f.source).toBe('fresh')
    expect(f.project.name).toBe('Bracket kit')
    expect(f.ui.expanded).toEqual(SAMPLE_EXPANDED)
    const s = new Autosave({ storage: new MemStorage() }).boot('')
    expect(s.source).toBe('sample')
  })

  test('backup ring every 60 s; a corrupt current falls back to the newest valid backup', () => {
    const storage = new MemStorage()
    let now = 100_000
    const a = new Autosave({ storage, now: () => now })
    for (let i = 0; i < 8; i++) { a.saveNow(emptyProject(`P${i}`)); now += 61_000 }
    const backups = [0, 1, 2, 3, 4].map((n) => storage.getItem(backupKey(n))).filter(Boolean)
    expect(backups.length).toBe(5)
    storage.setItem(KEY_CURRENT, '{"savedAt":"x","project":{"format":"nope"}}')
    const b = new Autosave({ storage }).boot('')
    expect(b.source).toBe('backup')
    expect(b.project.name).toBe('P6') // the previous current, copied before P7 was written
    expect(b.message).toMatch(/Restored/)
  })

  test('no extra backup within 60 s', () => {
    const storage = new MemStorage()
    let now = 100_000
    const a = new Autosave({ storage, now: () => now })
    a.saveNow(emptyProject('A')); now += 1000
    a.saveNow(emptyProject('B')); now += 1000
    a.saveNow(emptyProject('C')); now += 1000
    expect([0, 1, 2, 3, 4].filter((n) => storage.getItem(backupKey(n))).length).toBe(1)
  })

  test('storage failures toast once and boot still works', () => {
    let n = 0
    const a = new Autosave({ storage: broken, onUnavailable: () => n++ })
    expect(a.saveNow(sampleProject())).toBe(false)
    expect(a.saveNow(sampleProject())).toBe(false)
    a.saveUiNow(uiPrefsFrom(defaultUi()))
    expect(n).toBe(1)
    expect(new Autosave({ storage: broken }).boot('').source).toBe('sample')
  })

  test('ui prefs round-trip', () => {
    const storage = new MemStorage()
    const a = new Autosave({ storage })
    const ui = { ...defaultUi(), gizmoMode: 'rotate' as const, snap: false, expanded: { i_fx1: true } }
    a.scheduleUi(uiPrefsFrom(ui, { position: [1, 2, 3], target: [0, 0, 0] }))
    vi.advanceTimersByTime(1000)
    expect(storage.getItem(KEY_UI)).not.toBeNull()
    const prefs = a.loadUi()!
    expect(prefs).toEqual({ expanded: { i_fx1: true }, gizmoMode: 'rotate', gizmoSpace: 'world', snap: false, ghostOthers: true, camera: { position: [1, 2, 3], target: [0, 0, 0] } })
    new Autosave({ storage }).saveNow(sampleProject())
    expect(new Autosave({ storage }).boot('').ui).toEqual({ expanded: { i_fx1: true }, gizmoMode: 'rotate', gizmoSpace: 'world', snap: false, ghostOthers: true })
  })
})

/** MemStorage with a size quota (keys + values, in chars), like localStorage's QuotaExceededError. */
class QuotaStorage extends MemStorage {
  quota = Infinity
  setItem(k: string, v: string) {
    let used = 0
    for (const [kk, vv] of this.map) if (kk !== k) used += kk.length + vv.length
    if (used + k.length + v.length > this.quota) throw new Error('QuotaExceededError')
    super.setItem(k, v)
  }
}

describe('autosave: paused code, crash marker, a robust backup ring', () => {
  test('"Open without running" survives a reload: a paused save boots paused (§0.2 imported code runs only after Run code)', () => {
    vi.useFakeTimers()
    try {
      const storage = new MemStorage()
      const a = new Autosave({ storage })
      a.schedule(emptyProject('Untrusted'), { paused: true })
      vi.advanceTimersByTime(1000)
      const b = new Autosave({ storage }).boot('')
      expect(b.source).toBe('current')
      expect(b.ui.evalPaused).toBe(true)
      // after Run code the next save clears it
      a.saveNow(emptyProject('Untrusted'), { paused: false })
      expect(new Autosave({ storage }).boot('').ui.evalPaused).toBeUndefined()
      // a backup keeps the flag with its project
      a.saveNow(emptyProject('Untrusted'), { paused: true })
      storage.setItem(KEY_CURRENT, '{"truncated":')
      storage.setItem(backupKey(0), JSON.stringify({ savedAt: new Date().toISOString(), project: emptyProject('B'), paused: true }))
      const fromBackup = new Autosave({ storage }).boot('')
      expect(fromBackup.source).toBe('backup')
      expect(fromBackup.ui.evalPaused).toBe(true)
    } finally { vi.useRealTimers() }
  })

  test('a session that died while evaluating reopens with the code paused, once and for good (no crash loop)', () => {
    const storage = new MemStorage()
    const a = new Autosave({ storage })
    a.saveNow(emptyProject('Loop'))
    a.markEvaluating('Object')
    expect(storage.getItem(KEY_EVALUATING)).toContain('Object')
    // the tab died here (no pagehide): next boot
    const b = new Autosave({ storage }).boot('')
    expect(b.project.name).toBe('Loop')
    expect(b.ui.evalPaused).toBe(true)
    expect(b.message).toMatch(/stopped while evaluating 'Object'.*paused/)
    expect(storage.getItem(KEY_EVALUATING)).toBeNull()
    // reloading again without Run code: still paused (the flag was written with the project)
    expect(new Autosave({ storage }).boot('').ui.evalPaused).toBe(true)
    // a normal end of the evaluation clears the marker
    const c = new Autosave({ storage })
    c.markEvaluating('Object')
    c.markEvaluating(null)
    expect(storage.getItem(KEY_EVALUATING)).toBeNull()
  })

  test('an unloadable current is never rotated into the backups (an invalid state cannot wipe the ring)', () => {
    const storage = new MemStorage()
    let now = 1_000_000
    const auto = new Autosave({ storage, now: () => now })
    const store = new Store(sampleProject())
    for (let i = 0; i < 6; i++) { store.update('Move', (d) => ops.setTransform(d, 'i_bs', { t: [i, 0, 0], r: [0, 0, 0], s: [1, 1, 1] })); auto.saveNow(store.project); now += 61_000 }
    // an in-memory state parseProject rejects (here: a zero scale written behind the ops' back)
    const bad = structuredClone(store.project)
    const root = bad.defs[bad.root]
    if (root.kind === 'group') root.children[0].xf.s = [0, 1, 1]
    for (let i = 0; i < 6; i++) { auto.saveNow(bad); now += 61_000 }
    const b = new Autosave({ storage }).boot('')
    expect(b.source).toBe('backup') // not 'sample': the good backups survived
    // after booting from a backup, the corrupt current is not copied over the oldest good backup either
    storage.setItem(KEY_CURRENT, '{"savedAt":"x","project":{"format":"3dica"')
    const booted = new Autosave({ storage, now: () => now }).boot('')
    new Autosave({ storage, now: () => now }).saveNow(booted.project)
    const corrupt = [0, 1, 2, 3, 4].map((n) => storage.getItem(backupKey(n))).filter((x) => {
      try { return !JSON.parse(x!).project } catch { return true }
    })
    expect(corrupt).toEqual([])
  })

  test('a backup that does not fit (quota) never blocks the write of current; the ring shrinks instead', () => {
    const storage = new QuotaStorage()
    let now = 1_000_000
    let unavailable = 0
    const auto = new Autosave({ storage, now: () => now, onUnavailable: () => unavailable++ })
    const p = sampleProject()
    const size = JSON.stringify({ savedAt: new Date(0).toISOString(), project: p }).length
    storage.quota = size * 3.5 // room for current + 2 backups (+ meta), not 3 backups
    const saved: boolean[] = []
    for (let i = 0; i < 6; i++) {
      p.name = 'Edit ' + i
      saved.push(auto.saveNow(structuredClone(p)))
      now += 61_000
    }
    expect(saved).toEqual([true, true, true, true, true, true])
    expect(JSON.parse(storage.getItem(KEY_CURRENT)!).project.name).toBe('Edit 5')
    expect(unavailable).toBe(0)
    // current itself no longer fits next to the backups: they are dropped (oldest first) to make room
    p.name = 'Big'
    p.defs.d_bolt.kind === 'code' && (p.defs.d_bolt.code += '\n//' + 'x'.repeat(size))
    expect(auto.saveNow(p)).toBe(true)
    expect(JSON.parse(storage.getItem(KEY_CURRENT)!).project.name).toBe('Big')
  })
})

describe('clipboard', () => {
  test('clipFromPath snapshots the instance; Clipboard copies on get/set', () => {
    const p = sampleProject()
    const e = clipFromPath(p, ['i_fx2'])!
    expect(e).toEqual({ def: 'd_fixture', xf: { t: [75, 0, 0], r: [0, 0, 15], s: [1, 1, 1] }, name: 'Fixture B' })
    expect(clipFromPath(p, ['nope'])).toBeNull()
    const c = new Clipboard()
    expect(c.get()).toBeNull()
    c.set(e)
    e.xf.t[0] = 0
    expect(c.get()!.xf.t[0]).toBe(75)
    expect(c.has()).toBe(true)
  })
})
