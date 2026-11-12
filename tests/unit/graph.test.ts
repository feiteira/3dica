import { describe, expect, test } from 'vitest'
import type { CodeDef, GroupDef, Project } from '../../src/core/types'
import { sampleProject } from '../../src/core/sample'
import {
  blankComments, defAtPath, expand, findCycle, findInstance, instancesOf, ISOLATE_INSTANCE_ID, linkedChangeMessage, MAX_DEPTH, MAX_OCCURRENCES,
  occurrenceCount, occurrenceCounts, referrers, resolvePath, staticRefs, staticRefSites, validPrefix, worldMatrix, wouldCycle,
} from '../../src/core/graph'
import { applyPoint } from '../../src/core/transform'
import { createTemplateDef } from '../../src/core/templates'
import { buildSpecs } from '../../src/core/evalspec'

const group = (id: string, name: string, children: GroupDef['children'] = [], op: GroupDef['op'] = 'none'): GroupDef => ({ id, name, kind: 'group', op, children })
const code = (id: string, name: string, src = 'return cuboid()'): CodeDef => ({ id, name, kind: 'code', code: src, params: [] })
const inst = (id: string, def: string, extra: Partial<GroupDef['children'][number]> = {}) => ({ id, def, xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, ...extra }) as GroupDef['children'][number]
const project = (defs: (CodeDef | GroupDef)[]): Project => ({ format: '3dica', version: 1, name: 't', root: 'd_root', defs: Object.fromEntries(defs.map((d) => [d.id, d])) })

describe('staticRefs', () => {
  test('quotes, spaces, duplicates; ignores variables', () => {
    const src = `part('Bolt')\npart( "Plate" , {a:1})\npart('Bolt', { length })\nconst n = 'X'; part(n)\nmypart('Nope')\npart(\`Tpl\`)`
    expect(staticRefs(src)).toEqual(['Bolt', 'Plate'])
    expect(staticRefs(`part("It's")`)).toEqual(["It's"])
    expect(staticRefs('')).toEqual([])
  })
  test('sites give 1-based line/col', () => {
    expect(staticRefSites('const a = 1\n  part("Q")')).toEqual([{ name: 'Q', line: 2, col: 3 }])
  })
  test('comments are not references; strings with // are not comments', () => {
    const src = `// part('Name', { param: value }) returns …\n/* part("Old")\n   part('Gone') */ const u = 'http://x' // part('Late')\n  part('Bolt')`
    expect(staticRefs(src)).toEqual(['Bolt'])
    expect(staticRefSites(src)).toEqual([{ name: 'Bolt', line: 4, col: 3 }])
    expect(blankComments(src).length).toBe(src.length)
    expect(blankComments(`a = "//" + '/*' + \`//\` // c`)).toBe(`a = "//" + '/*' + \`//\`     `)
  })
  test('the blank Code template has no dependencies', () => {
    const def = createTemplateDef('code', sampleProject(), 0)
    expect(def.kind === 'code' && staticRefs(def.code)).toEqual([])
    const p = sampleProject()
    p.defs[def.id] = def
    expect(buildSpecs(p).specErrors.has(def.id)).toBe(false)
  })
})

describe('wouldCycle', () => {
  test('group into itself, A ⊃ B then B into A, and a part() edge', () => {
    const p = project([group('d_root', 'Scene'), group('d_a', 'A', [inst('i_b', 'd_b')]), group('d_b', 'B'), code('d_leg', 'Leg', "return part('Table')"), group('d_table', 'Table')])
    expect(wouldCycle(p, 'd_a', 'd_a')).toBe(true)
    expect(wouldCycle(p, 'd_b', 'd_a')).toBe(true)
    expect(wouldCycle(p, 'd_a', 'd_b')).toBe(false)
    expect(wouldCycle(p, 'd_table', 'd_leg')).toBe(true) // Leg code references Table → Table can't contain Leg
    expect(wouldCycle(p, 'd_a', 'd_leg')).toBe(false)
    expect(wouldCycle(p, 'd_a', 'd_root')).toBe(true) // the root is never instanced
  })
  test('findCycle reports group and code cycles', () => {
    const p = project([group('d_root', 'Scene'), group('d_a', 'A', [inst('i_b', 'd_b')]), group('d_b', 'B', [inst('i_a', 'd_a')])])
    const c = findCycle(p)!
    expect(c[0]).toBe(c[c.length - 1])
    expect(new Set(c)).toEqual(new Set(['d_a', 'd_b']))
    const q = project([group('d_root', 'Scene'), code('d_x', 'X', "part('Y')"), code('d_y', 'Y', "part('X')")])
    expect(findCycle(q)).not.toBeNull()
    expect(findCycle(q, { codeEdges: false })).toBeNull()
    expect(findCycle(sampleProject())).toBeNull()
  })
})

describe('counts and refs on the sample', () => {
  const s = sampleProject()
  test('occurrenceCount: Bolt 8, Washer 8, Plate 2, Disc 8', () => {
    expect(occurrenceCount(s, 'd_bolt')).toBe(8)
    expect(occurrenceCount(s, 'd_washer')).toBe(8)
    expect(occurrenceCount(s, 'd_plate')).toBe(2)
    expect(occurrenceCount(s, 'd_disc')).toBe(8)
    expect(occurrenceCount(s, 'd_fixture')).toBe(2)
    expect(occurrenceCount(s, 'd_boltsizes')).toBe(1)
    expect(occurrenceCounts(s).get('d_root')).toBe(1)
  })
  test('referrers / instancesOf / findInstance', () => {
    expect(referrers(s, 'd_bolt')).toEqual(['d_boltsizes'])
    expect(referrers(s, 'd_plate')).toEqual([])
    expect(instancesOf(s, 'd_bolt').map((x) => x.instance.id)).toEqual(['i_b1', 'i_b2', 'i_b3', 'i_b4'])
    expect(findInstance(s, 'i_hole')?.parent.id).toBe('d_washer')
  })
  test('resolvePath / defAtPath / validPrefix', () => {
    expect(resolvePath(s, ['i_fx2', 'i_w1', 'i_hole'])?.map((x) => x.def.id)).toEqual(['d_fixture', 'd_washer', 'd_hole'])
    expect(resolvePath(s, ['i_fx2', 'nope'])).toBeNull()
    expect(defAtPath(s, [])?.id).toBe('d_root')
    expect(validPrefix(s, ['i_fx1', 'i_b2', 'i_zz'])).toEqual(['i_fx1', 'i_b2'])
  })
  test('worldMatrix of [i_fx2, i_b1] puts it at the expected world xy', () => {
    const m = worldMatrix(s, ['i_fx2', 'i_b1'])!
    const c = Math.cos(15 * Math.PI / 180), si = Math.sin(15 * Math.PI / 180)
    const p = applyPoint(m, [0, 0, 0])
    expect(p[0]).toBeCloseTo(75 + c * -23 - si * -13, 9)
    expect(p[1]).toBeCloseTo(si * -23 + c * -13, 9)
    expect(p[2]).toBeCloseTo(5, 9)
    expect(worldMatrix(s, ['bad'])).toBeNull()
  })
  test('linkedChangeMessage', () => {
    expect(linkedChangeMessage(s, 'd_fixture')).toBe("Changed 'Fixture' — 2 copies updated")
    expect(linkedChangeMessage(s, 'd_fixture', 'Added to')).toBe("Added to 'Fixture' — 2 copies updated")
    expect(linkedChangeMessage(s, 'd_root')).toBeNull()
    expect(linkedChangeMessage(s, 'd_boltsizes')).toBeNull()
  })
})

describe('expand', () => {
  test('sample: order, roles, operandOf, params, counts', () => {
    const occs = expand(sampleProject())
    // per fixture: fixture + plate + 4×(washer + disc + hole) + 4 bolts = 18; ×2 + bolt sizes
    expect(occs.length).toBe(37)
    expect(occs[0].key).toBe('i_fx1')
    expect(occs[1].key).toBe('i_fx1/i_plate')
    const w = occs.find((o) => o.key === 'i_fx1/i_w1')!
    expect(w.role).toBe('bool')
    const disc = occs.find((o) => o.key === 'i_fx1/i_w1/i_disc')!
    const hole = occs.find((o) => o.key === 'i_fx1/i_w1/i_hole')!
    expect(disc.operandOf).toBe('i_fx1/i_w1')
    expect(disc.operandRole).toBe('base')
    expect(hole.operandRole).toBe('cut')
    expect(w.operandOf).toBeUndefined()
    expect(occs.find((o) => o.key === 'i_fx1')!.role).toBe('group')
    expect(occs.find((o) => o.key === 'i_bs')!.params).toEqual({ count: 5, start: 8, step: 4, spacing: 12 })
    expect(occs.find((o) => o.key === 'i_fx1')!.params).toEqual({})
    expect(disc.parentKey).toBe('i_fx1/i_w1')
    expect(disc.parentDef).toBe('d_washer')
  })

  test('outermost instance color wins; hidden propagates', () => {
    const s = sampleProject()
    const root = s.defs.d_root as GroupDef
    root.children[0].color = '#111111'
    root.children[0].hidden = true
    const fx = s.defs.d_fixture as GroupDef
    fx.children[5].color = '#222222' // i_b1
    const occs = expand(s)
    const b1a = occs.find((o) => o.key === 'i_fx1/i_b1')!
    const b1b = occs.find((o) => o.key === 'i_fx2/i_b1')!
    expect(b1a.colorFromInstance).toBe('#111111')
    expect(b1b.colorFromInstance).toBe('#222222')
    expect(occs.find((o) => o.key === 'i_fx2/i_plate')!.colorFromInstance).toBeUndefined()
    expect(b1a.hidden).toBe(true)
    expect(b1b.hidden).toBe(false)
  })

  test('isolate starts from a synthetic identity instance', () => {
    const occs = expand(sampleProject(), { rootDef: 'd_washer' })
    expect(occs.map((o) => o.key)).toEqual([ISOLATE_INSTANCE_ID, `${ISOLATE_INSTANCE_ID}/i_disc`, `${ISOLATE_INSTANCE_ID}/i_hole`])
    expect(occs[0].role).toBe('bool')
    const bolt = expand(sampleProject(), { rootDef: 'd_bolt', rootParams: { length: 30 } })
    expect(bolt.length).toBe(1)
    expect(bolt[0].params).toEqual({ length: 30, diameter: 5 })
    expect(expand(sampleProject(), { rootDef: 'd_missing' })).toEqual([])
  })

  test('caps: depth 32 and 5,000 occurrences, each reported once', () => {
    // a chain of 40 nested groups
    const defs: (CodeDef | GroupDef)[] = [group('d_root', 'Scene', [inst('i_g0', 'd_g0')])]
    for (let i = 0; i < 40; i++) defs.push(group(`d_g${i}`, `G${i}`, i < 39 ? [inst(`i_g${i + 1}`, `d_g${i + 1}`)] : []))
    const caps: string[] = []
    const deep = expand(project(defs), { onCap: (c) => caps.push(c) })
    expect(deep.length).toBe(MAX_DEPTH)
    expect(caps).toEqual(['depth'])
    // 100 × 100 = 10,000 leaves
    const leaf = code('d_leaf', 'Leaf')
    const row = group('d_row', 'Row', Array.from({ length: 100 }, (_, i) => inst(`i_l${i}`, 'd_leaf')))
    const wide = project([group('d_root', 'Scene', Array.from({ length: 100 }, (_, i) => inst(`i_r${i}`, 'd_row'))), row, leaf])
    const caps2: string[] = []
    const occs = expand(wide, { onCap: (c) => caps2.push(c) })
    expect(occs.length).toBe(MAX_OCCURRENCES)
    expect(caps2).toEqual(['count'])
  })
})

describe('staticRefs and regular-expression literals', () => {
  test('a // inside a regex literal does not hide a real part() call (false negative)', () => {
    expect(staticRefs("const re = /\\/\\//; const b = part('Bolt'); return b")).toEqual(['Bolt'])
    expect(staticRefs("if (/^a\\/\\/b$/.test(s)) x = part('Bolt')")).toEqual(['Bolt'])
  })
  test('a quote inside a regex literal does not turn a following comment into a "string" (false positive)', () => {
    expect(staticRefs("const s = 'a\"b'.replace(/\"/g, '') // part('Nut') — removed\nreturn cuboid()")).toEqual([])
    expect(staticRefs("const t = s.split(/'/) /* part('Nut') */\nreturn []")).toEqual([])
  })
  test('a / that is a division stays a division', () => {
    expect(staticRefs("const a = w / 2 // part('Nut')\nreturn part('Bolt')")).toEqual(['Bolt'])
    expect(staticRefs("const a = (w) / 2 / 3; const b = x[1] / 4 // part('Nut')\nreturn part('Bolt')")).toEqual(['Bolt'])
    expect(staticRefs("return /[/]/.test(s) ? part('Bolt') : part('Disc')")).toEqual(['Bolt', 'Disc'])
    // after a postfix ++ / -- or a number ending in '.', a / is a division (else the comment would become a false "Unknown part")
    expect(staticRefs("let k = 0\nconst w = k++ / 2 // part('Old')\nreturn part('Bolt')")).toEqual(['Bolt'])
    expect(staticRefs("let k = 4\nconst w = k-- / 2 /* part('Old') */\nreturn part('Bolt')")).toEqual(['Bolt'])
    expect(staticRefs("const q = 2. / 3 // part('Old')\nreturn part('Bolt')")).toEqual(['Bolt'])
    // offsets are unchanged (lines / columns of diagnostics)
    const src = "const re = /\\/\\//\nreturn part('Bolt')"
    expect(blankComments(src).length).toBe(src.length)
  })
})

describe('operand roles follow what the engine evaluates', () => {
  test('subtract with a hidden child 0: the first VISIBLE child is the base, not a red cutter', () => {
    const p = sampleProject()
    const washer = p.defs.d_washer as GroupDef
    washer.children[0].hidden = true // hide the Disc: the Hole becomes the base (GroupSpec has visible children only)
    const occs = expand(p)
    const hole = occs.find((o) => o.key === 'i_fx1/i_w1/i_hole')!
    expect(hole.operandRole).toBe('base')
    // unhidden: the usual roles
    washer.children[0].hidden = false
    const again = expand(p)
    expect(again.find((o) => o.key === 'i_fx1/i_w1/i_disc')!.operandRole).toBe('base')
    expect(again.find((o) => o.key === 'i_fx1/i_w1/i_hole')!.operandRole).toBe('cut')
    // and the engine's spec agrees: child 0 of the Washer's GroupSpec is the Hole while the Disc is hidden
    washer.children[0].hidden = true
    const spec = buildSpecs(p).specOf('d_washer')
    expect(spec?.kind === 'group' && spec.children[0].spec.name).toBe('Hole')
  })
})
