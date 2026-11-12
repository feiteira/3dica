import { describe, expect, test } from 'vitest'
import { sampleProject } from '../../src/core/sample'
import { History } from '../../src/state/history'
import { Store } from '../../src/state/store'
import * as ops from '../../src/core/ops'
import { emptyProject } from '../../src/core/project-io'
import type { GroupDef } from '../../src/core/types'

function clockStore() {
  let t = 1000
  const errors: string[] = []
  const store = new Store(sampleProject(), {}, { now: () => t, onError: (m) => errors.push(m) })
  return { store, errors, advance: (ms: number) => { t += ms } }
}
const t0 = (s: Store, id: string) => (Object.values(s.project.defs).flatMap((d) => (d.kind === 'group' ? d.children : [])).find((c) => c.id === id)!.xf.t[0])
const move = (s: Store, id: string, x: number, opts?: { coalesce?: string; window?: number }) =>
  s.update(`Move ${id}`, (d) => ops.setTransform(d, id, { t: [x, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }), opts)

describe('undo / redo', () => {
  test('undo and redo; redo is cleared by a new update', () => {
    const { store } = clockStore()
    move(store, 'i_bs', 1)
    move(store, 'i_bs', 2)
    expect(store.history.labels().past).toEqual(['Move i_bs', 'Move i_bs'])
    expect(store.undo()).toBe(true)
    expect(t0(store, 'i_bs')).toBe(1)
    expect(store.undo()).toBe(true)
    expect(t0(store, 'i_bs')).toBe(-24)
    expect(store.undo()).toBe(false)
    expect(store.redo()).toBe(true)
    expect(t0(store, 'i_bs')).toBe(1)
    expect(store.history.labels().future.length).toBe(1)
    move(store, 'i_bs', 5)
    expect(store.history.labels().future).toEqual([])
    expect(store.redo()).toBe(false)
    expect(t0(store, 'i_bs')).toBe(5)
  })

  test('OpError: toast via onError, nothing changes, no history', () => {
    const { store, errors } = clockStore()
    const before = store.project
    const r = store.update('Delete Bolt', (d) => ops.deleteDefinition(d, 'd_bolt'))
    expect(r.ok).toBe(false)
    expect(errors).toEqual(["Can't delete 'Bolt': used by code in 'Bolt sizes'"])
    expect(store.project).toBe(before)
    expect(store.history.labels().past).toEqual([])
  })

  test('a no-op recipe adds no history entry and does not notify', () => {
    const { store } = clockStore()
    let n = 0
    store.subscribe(() => n++)
    const r = store.update('Move', (d) => ops.setTransform(d, 'i_bs', { t: [-24, -45, 0], r: [0, 0, 0], s: [1, 1, 1] }))
    expect(r).toEqual({ ok: true, value: undefined, changed: false })
    expect(store.history.labels().past).toEqual([])
    expect(n).toBe(0)
  })

  test('the project snapshot is never mutated in place', () => {
    const { store } = clockStore()
    const before = store.project
    const snapshot = JSON.stringify(before)
    move(store, 'i_bs', 9)
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(store.project).not.toBe(before)
  })
})

describe('coalescing', () => {
  test('inside the window: one entry; undo returns to before the run', () => {
    const { store, advance } = clockStore()
    move(store, 'i_bs', 1, { coalesce: 'xf:i_bs:t0' })
    advance(300)
    move(store, 'i_bs', 2, { coalesce: 'xf:i_bs:t0' })
    advance(300) // sliding: at was refreshed, so 300 < 500
    move(store, 'i_bs', 3, { coalesce: 'xf:i_bs:t0' })
    expect(store.history.labels().past.length).toBe(1)
    store.undo()
    expect(t0(store, 'i_bs')).toBe(-24)
  })

  test('outside the window or with another key: new entries', () => {
    const { store, advance } = clockStore()
    move(store, 'i_bs', 1, { coalesce: 'k' })
    advance(600)
    move(store, 'i_bs', 2, { coalesce: 'k' })
    move(store, 'i_bs', 3, { coalesce: 'other' })
    move(store, 'i_bs', 4)
    move(store, 'i_bs', 5) // no key → never coalesces
    expect(store.history.labels().past.length).toBe(5)
  })

  test('the 2 s code window', () => {
    const { store, advance } = clockStore()
    const edit = (code: string) => store.update('Edit code', (d) => ops.setCode(d, 'd_disc', code), { coalesce: 'code:d_disc', window: 2000 })
    edit('return 1')
    advance(1500)
    edit('return 2')
    advance(1900)
    edit('return 3')
    expect(store.history.labels().past).toEqual(['Edit code'])
    advance(2100)
    edit('return 4')
    expect(store.history.labels().past).toEqual(['Edit code', 'Edit code'])
  })

  test('a redone step never coalesces with a later edit', () => {
    const h = new History()
    const p = emptyProject()
    h.record('A', p, { coalesce: 'k' }, 0)
    const u = h.undo(emptyProject(), 10)!
    h.redo(u.project, 20)
    expect(h.record('B', p, { coalesce: 'k' }, 30)).toBe('pushed')
  })
})

describe('cap and fixSelection', () => {
  test('the cap of 200', () => {
    const { store } = clockStore()
    for (let i = 1; i <= 205; i++) move(store, 'i_bs', i)
    expect(store.history.labels().past.length).toBe(200)
    let n = 0
    while (store.undo()) n++
    expect(n).toBe(200)
    expect(t0(store, 'i_bs')).toBe(5) // the 5 oldest steps fell off
  })

  test('fixSelection truncates a path after undoing an add', () => {
    const { store } = clockStore()
    const r = store.update('Paste Bolt', (d) => ops.pasteInstance(d, ['i_fx1'], { def: 'd_bolt', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } }, false, 15))
    expect(r.ok).toBe(true)
    const path = r.ok ? r.value : []
    store.setUi({ selection: { kind: 'occ', path }, context: ['i_fx1'] })
    store.undo()
    expect(store.ui.selection).toEqual({ kind: 'occ', path: ['i_fx1'] })
    expect(store.ui.context).toEqual(['i_fx1'])
    store.redo()
    store.setUi({ selection: { kind: 'occ', path: ['i_fx1', 'i_w1', 'i_hole'] }, context: ['i_fx1', 'i_w1'] })
    store.update('Delete', (d) => ops.removeInstance(d, ['i_fx1']))
    expect(store.ui.selection).toEqual({ kind: 'none' })
    expect(store.ui.context).toEqual([])
  })

  test('a def selection becomes none when the def is gone; context is cut to a group', () => {
    const { store } = clockStore()
    store.setUi({ selection: { kind: 'def', def: 'd_washer' } })
    store.update('Delete definition Washer', (d) => ops.deleteDefinition(d, 'd_washer'))
    expect(store.ui.selection).toEqual({ kind: 'none' })
    store.setUi({ context: ['i_fx1', 'i_plate'] }) // a code occurrence is not a valid context
    expect(store.ui.context).toEqual(['i_fx1'])
  })

  test('subscribers see one change per update with ui flag; reset clears history', () => {
    const { store } = clockStore()
    const seen: string[] = []
    store.subscribe((c) => seen.push(`${c.source}:${c.project}:${c.ui}`))
    store.setUi({ selection: { kind: 'occ', path: ['i_bs'] } })
    store.update('Delete', (d) => ops.removeInstance(d, ['i_bs']))
    store.reset(emptyProject(), { evalPaused: true })
    expect(seen).toEqual(['ui:false:true', 'update:true:true', 'reset:true:true'])
    expect(store.history.labels().past).toEqual([])
    expect(store.ui.evalPaused).toBe(true)
    expect((store.project.defs.d_root as GroupDef).children).toEqual([])
  })

  test('setUi removes keys patched to undefined', () => {
    const { store } = clockStore()
    store.setUi({ autoIsolatedFrom: 'context' })
    expect(store.ui.autoIsolatedFrom).toBe('context')
    store.setUi({ autoIsolatedFrom: undefined })
    expect('autoIsolatedFrom' in store.ui).toBe(false)
  })
})

describe('fixSelection and isolate', () => {
  test('when the isolated object disappears (undo of its Add), the view returns to the scene', () => {
    const store = new Store(sampleProject())
    const r = store.update('Add Cube', (d) => {
      d.defs.d_cube = { id: 'd_cube', name: 'Cube', kind: 'code', code: 'return cuboid()', params: [] }
      ;(d.defs[d.root] as GroupDef).children.push({ id: 'i_cube', def: 'd_cube', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } })
    })
    expect(r.ok).toBe(true)
    store.setUi({ selection: { kind: 'occ', path: ['i_cube'] }, viewMode: 'isolate' })
    store.undo()
    expect(store.ui.selection).toEqual({ kind: 'none' })
    expect(store.ui.viewMode).toBe('context')
  })
  test('a deleted Library def that forced isolate returns to the scene too; a surviving target stays isolated', () => {
    const store = new Store(sampleProject())
    store.setUi({ selection: { kind: 'def', def: 'd_plate' }, viewMode: 'isolate', autoIsolatedFrom: 'context' })
    store.update('Delete definition Plate', (d) => ops.deleteDefinition(d, 'd_plate'))
    expect(store.ui).toMatchObject({ selection: { kind: 'none' }, viewMode: 'context' })
    expect(store.ui.autoIsolatedFrom).toBeUndefined()
    // a path cut to its parent keeps isolate (the parent is still something to show)
    store.setUi({ selection: { kind: 'occ', path: ['i_fx1', 'i_b1'] }, viewMode: 'isolate' })
    store.update('Delete Bolt', (d) => { ops.removeInstance(d, ['i_fx1', 'i_b1']) })
    expect(store.ui).toMatchObject({ selection: { kind: 'occ', path: ['i_fx1'] }, viewMode: 'isolate' })
  })
})
