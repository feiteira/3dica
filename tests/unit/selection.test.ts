import { describe, expect, test } from 'vitest'
import type { GroupDef, UiState } from '../../src/core/types'
import { sampleProject } from '../../src/core/sample'
import { expand } from '../../src/core/graph'
import { defaultUi } from '../../src/state/store'
import {
  breadcrumbPatch, breadcrumbPath, breadcrumbTitle, enterPatch, escapePatch, isolateBanner, isolateTarget, librarySelectPatch, pickPatch,
  shownOperandBools, treeSelectPatch,
} from '../../src/core/selection'
import { boolColor, DEFAULT_COLOR, leafColor } from '../../src/core/colors'

const ui = (patch: Partial<UiState> = {}): UiState => ({ ...defaultUi(), ...patch })
const occ = (...path: string[]) => ({ kind: 'occ' as const, path })
const p = sampleProject()

describe('§4.3 selection rules', () => {
  test('tree click selects and sets context; restores an auto-isolate', () => {
    expect(treeSelectPatch(ui(), ['i_fx1', 'i_plate'])).toEqual({ selection: occ('i_fx1', 'i_plate'), context: ['i_fx1'] })
    const lib = librarySelectPatch(ui(), 'd_bolt')
    expect(lib).toEqual({ selection: { kind: 'def', def: 'd_bolt' }, viewMode: 'isolate', autoIsolatedFrom: 'context' })
    // a second Library click keeps the original mode
    expect(librarySelectPatch(ui({ ...lib }), 'd_plate').autoIsolatedFrom).toBe('context')
    const back = treeSelectPatch(ui({ ...lib }), ['i_bs'])
    expect(back.viewMode).toBe('context')
    expect('autoIsolatedFrom' in back && back.autoIsolatedFrom === undefined).toBe(true)
  })

  test('viewport pick: plain, ctrl, outside context, empty, double-click', () => {
    const hit = ['i_fx1', 'i_w1', 'i_disc']
    expect(pickPatch(p, ui(), hit)).toEqual({ context: [], selection: occ('i_fx1') })
    expect(pickPatch(p, ui({ context: ['i_fx1'] }), hit)).toEqual({ context: ['i_fx1'], selection: occ('i_fx1', 'i_w1') })
    expect(pickPatch(p, ui({ context: ['i_fx2'] }), hit)).toEqual({ context: [], selection: occ('i_fx1') })
    expect(pickPatch(p, ui(), hit, { ctrl: true })).toEqual({ selection: occ(...hit), context: ['i_fx1', 'i_w1'] })
    expect(pickPatch(p, ui({ context: ['i_fx1'] }), null)).toEqual({ selection: { kind: 'none' } })
    expect(pickPatch(p, ui(), hit, { double: true })).toEqual({ context: ['i_fx1'], selection: occ('i_fx1', 'i_w1') })
    expect(pickPatch(p, ui(), ['i_bs'], { double: true })).toEqual({ context: [], selection: occ('i_bs') })
    // the entered boolean's own result mesh
    expect(pickPatch(p, ui({ context: ['i_fx1', 'i_w1'] }), ['i_fx1', 'i_w1'])).toEqual({ selection: occ('i_fx1', 'i_w1'), context: ['i_fx1'] })
  })

  test('Enter, Esc, breadcrumb', () => {
    expect(enterPatch(p, ui({ selection: occ('i_fx1') }))).toEqual({ context: ['i_fx1'], selection: { kind: 'none' } })
    expect(enterPatch(p, ui({ selection: occ('i_bs') }))).toBeNull()
    expect(escapePatch(ui({ viewMode: 'isolate' }))).toEqual({ viewMode: 'context', autoIsolatedFrom: undefined })
    expect(escapePatch(ui({ context: ['i_fx1', 'i_w1'], selection: occ('i_fx1', 'i_w1', 'i_disc') }))).toEqual({ selection: occ('i_fx1', 'i_w1'), context: ['i_fx1'] })
    expect(escapePatch(ui({ selection: occ('i_bs') }))).toEqual({ selection: { kind: 'none' } })
    const u = ui({ context: ['i_fx1'], selection: occ('i_fx1', 'i_w1') })
    expect(breadcrumbPath(u)).toEqual(['i_fx1', 'i_w1'])
    expect(breadcrumbPatch(u, 0)).toEqual({ context: [], selection: { kind: 'none' } })
    expect(breadcrumbPatch(u, 1)).toEqual({ context: ['i_fx1'], selection: occ('i_fx1', 'i_w1') })
    expect(breadcrumbPatch(u, 2)).toEqual({ context: ['i_fx1'], selection: occ('i_fx1', 'i_w1') })
  })
})

describe('§4.4 operands and isolate', () => {
  test('operands shown when the boolean or something inside it is selected or the context', () => {
    const occs = expand(p)
    expect(shownOperandBools(occs, ui()).size).toBe(0)
    expect([...shownOperandBools(occs, ui({ selection: occ('i_fx1', 'i_w1') }))]).toEqual(['i_fx1/i_w1'])
    expect([...shownOperandBools(occs, ui({ selection: occ('i_fx2', 'i_w3', 'i_hole') }))]).toEqual(['i_fx2/i_w3'])
    expect([...shownOperandBools(occs, ui({ context: ['i_fx1', 'i_w2'] }))]).toEqual(['i_fx1/i_w2'])
    expect(shownOperandBools(occs, ui({ selection: occ('i_fx1') })).size).toBe(0)
  })

  test('isolate target and banner', () => {
    const q = sampleProject()
    ;(q.defs.d_fixture as GroupDef).children[5].params = { length: 20 }
    expect(isolateTarget(q, ui({ viewMode: 'isolate', selection: occ('i_fx1', 'i_b1') }))).toEqual({ defId: 'd_bolt', params: { length: 20 } })
    expect(isolateTarget(q, ui({ viewMode: 'isolate', selection: { kind: 'def', def: 'd_plate' } }))).toEqual({ defId: 'd_plate' })
    expect(isolateTarget(q, ui({ viewMode: 'context', selection: occ('i_bs') }))).toBeNull()
    expect(isolateTarget(q, ui({ viewMode: 'isolate' }))).toBeNull()
    expect(isolateBanner(q.defs.d_bolt)).toBe('Isolated: Bolt (length 12, diameter 5) — I or Esc to return')
    expect(isolateBanner(q.defs.d_washer)).toBe('Isolated: Washer — I or Esc to return')
  })
})

describe('§2.4 colors', () => {
  test('leaf and boolean color resolution', () => {
    const q = sampleProject()
    ;(q.defs.d_root as GroupDef).children[1].color = '#010203'
    const occs = expand(q)
    const at = (k: string) => occs.find((o) => o.key === k)!
    expect(leafColor(at('i_fx1/i_b1'))).toBe('#aab4be')
    expect(leafColor(at('i_fx1/i_b1'), '#ffffff')).toBe('#ffffff')
    expect(leafColor(at('i_fx2/i_b1'), '#ffffff')).toBe('#010203')
    expect(boolColor(q, at('i_fx1/i_w1'))).toBe('#c9a227')
    delete q.defs.d_washer.color
    expect(boolColor(q, expand(q).find((o) => o.key === 'i_fx1/i_w1')!)).toBe('#c9a227') // from the first operand (Disc)
    delete q.defs.d_disc.color
    expect(boolColor(q, expand(q).find((o) => o.key === 'i_fx1/i_w1')!)).toBe(DEFAULT_COLOR)
  })
})

describe('breadcrumb tooltips say what the click does', () => {
  test('every segment title matches breadcrumbPatch (§4.3: a middle segment enters it and selects the next one)', () => {
    const u = ui({ selection: { kind: 'occ', path: ['i_fx1', 'i_w1', 'i_disc'] }, context: ['i_fx1', 'i_w1'] })
    const labels = ['Fixture A', 'Washer', 'Disc']
    const nameOf: Record<string, string> = { i_fx1: 'Fixture A', i_w1: 'Washer', i_disc: 'Disc' }
    for (let j = 0; j <= labels.length; j++) {
      const t = breadcrumbTitle(labels, j)
      const patch = breadcrumbPatch(u, j)
      const sel = patch.selection!
      if (sel.kind === 'none') expect(t).toMatch(/whole scene/)
      else {
        const selected = nameOf[(sel as { path: string[] }).path.at(-1)!]
        expect(t).toMatch(new RegExp(`[Ss]elect '${selected}'`))
        if (j < labels.length) expect(t).toMatch(new RegExp(`^Enter '${labels[j - 1]}'`))
      }
    }
    expect(breadcrumbTitle(labels, 1)).not.toBe("Select 'Fixture A'") // what the old tooltip claimed
  })
})
