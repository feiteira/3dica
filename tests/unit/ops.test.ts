import { describe, expect, test } from 'vitest'
import type { CodeDef, GroupDef, InstancePath, Mat4, Project } from '../../src/core/types'
import { sampleProject } from '../../src/core/sample'
import { parseProject, serialize, validateProject } from '../../src/core/project-io'
import { uniqueName } from '../../src/core/ids'
import { findInstance, instancesOf, occurrenceCount, resolvePath, worldMatrix } from '../../src/core/graph'
import { applyPoint } from '../../src/core/transform'
import { TEMPLATES, createTemplateDef, placementFor, PALETTE } from '../../src/core/templates'
import * as ops from '../../src/core/ops'

const { OpError } = ops

/** Run an op on a fresh draft and assert the §2.2 invariants afterwards. */
function run<T>(p: Project, fn: (d: Project) => T): T {
  const r = fn(p)
  expect(validateProject(p)).toEqual([])
  return r
}
const children = (p: Project, id: string) => (p.defs[id] as GroupDef).children
const worldPos = (p: Project, path: InstancePath) => applyPoint(worldMatrix(p, path)!, [1, 2, 3])
const expectPoint = (a: number[], b: number[], digits = 5) => { for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], digits) }
const expectMat = (a: Mat4, b: Mat4) => { for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(b[i], 5) }

describe('duplicate / clone / make unique', () => {
  test('duplicateLinked: same def, new id, right after the original, offset applied', () => {
    const p = sampleProject()
    const path = run(p, (d) => ops.duplicateLinked(d, ['i_fx1', 'i_b1'], 15))
    const kids = children(p, 'd_fixture')
    const i = kids.findIndex((c) => c.id === 'i_b1')
    expect(kids[i + 1].id).toBe(path[1])
    expect(path[0]).toBe('i_fx1')
    expect(kids[i + 1].def).toBe('d_bolt')
    expect(kids[i + 1].id).not.toBe('i_b1')
    expect(kids[i + 1].xf.t).toEqual([-23 + 15, -13, 5])
    expect(occurrenceCount(p, 'd_bolt')).toBe(10)
  })

  test('duplicateUnique: new def "Fixture 2", children get new ids but the same child defs', () => {
    const p = sampleProject()
    const path = run(p, (d) => ops.duplicateUnique(d, ['i_fx1'], 80))
    const inst = findInstance(p, path[0])!.instance
    const clone = p.defs[inst.def] as GroupDef
    expect(clone.name).toBe('Fixture 2')
    expect(clone.id).not.toBe('d_fixture')
    const orig = children(p, 'd_fixture')
    expect(clone.children.map((c) => c.def)).toEqual(orig.map((c) => c.def))
    for (const c of clone.children) expect(orig.some((o) => o.id === c.id)).toBe(false)
    expect(clone.children.map((c) => c.xf)).toEqual(orig.map((c) => c.xf))
    expect(occurrenceCount(p, 'd_bolt')).toBe(12)
    expect(inst.xf.t).toEqual([80, 0, 0])
    // a second unique copy continues the numbering
    const p2 = run(p, (d) => ops.duplicateUnique(d, path, 80))
    expect(p.defs[findInstance(p, p2[0])!.instance.def].name).toBe('Fixture 3')
  })

  test('cloneDef of a code def copies code, params and color', () => {
    const p = sampleProject()
    const id = run(p, (d) => ops.cloneDef(d, 'd_bolt'))
    const c = p.defs[id] as CodeDef
    expect(c.name).toBe('Bolt 2')
    expect(c.code).toBe((p.defs.d_bolt as CodeDef).code)
    expect(c.params).toEqual((p.defs.d_bolt as CodeDef).params)
    expect(c.color).toBe('#aab4be')
    expect(() => ops.cloneDef(p, 'd_root')).toThrow(OpError)
  })

  test('makeUnique: refused with a single record; works with two', () => {
    const p = sampleProject()
    expect(() => ops.makeUnique(p, ['i_bs'])).toThrow(/Only instance of 'Bolt sizes'/)
    expect(() => ops.makeUnique(p, ['i_fx1'])).not.toThrow() // two records of Fixture in the root
    expect(validateProject(p)).toEqual([])
    const fx1 = findInstance(p, 'i_fx1')!.instance
    expect(fx1.def).not.toBe('d_fixture')
    expect(occurrenceCount(p, 'd_fixture')).toBe(1)
    // a child of a linked group has one record → refused
    const q = sampleProject()
    expect(() => ops.makeUnique(q, ['i_fx1', 'i_plate'])).toThrow(OpError)
  })
})

describe('paste', () => {
  test('pasteInstance appends to the context with an offset; unique clones', () => {
    const p = sampleProject()
    const clip: ops.ClipboardEntry = { def: 'd_boltsizes', xf: { t: [-24, -45, 0], r: [0, 0, 0], s: [1, 1, 1] }, params: { count: 2 } }
    const path = run(p, (d) => ops.pasteInstance(d, [], clip, false, 70))
    expect(path.length).toBe(1)
    const kids = children(p, 'd_root')
    expect(kids[kids.length - 1].id).toBe(path[0])
    expect(kids[kids.length - 1].xf.t).toEqual([46, -45, 0])
    expect(kids[kids.length - 1].params).toEqual({ count: 2 })
    expect(occurrenceCount(p, 'd_boltsizes')).toBe(2)
    const u = run(p, (d) => ops.pasteInstance(d, ['i_fx1'], clip, true, 10))
    expect(p.defs[findInstance(p, u[1])!.instance.def].name).toBe('Bolt sizes 2')
  })

  test('pasteInstance refused on a cycle and when the def is gone', () => {
    const p = sampleProject()
    const clip: ops.ClipboardEntry = { def: 'd_fixture', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } }
    expect(() => ops.pasteInstance(p, ['i_fx1'], clip, false, 10)).toThrow("Can't paste 'Fixture' inside itself")
    expect(() => ops.pasteInstance(p, ['i_fx1'], clip, true, 10)).toThrow(OpError)
    expect(() => ops.pasteInstance(p, [], { ...clip, def: 'd_gone' }, false, 10)).toThrow(/no longer exists/)
    expect(() => ops.pasteInstance(p, ['i_bs'], clip, false, 10)).toThrow(/not a group/)
  })
})

describe('moveInstance', () => {
  test('preserves world position across a rotated parent (out of i_fx2 to the root)', () => {
    const p = sampleProject()
    const before = worldPos(p, ['i_fx2', 'i_b1'])
    const beforeM = worldMatrix(p, ['i_fx2', 'i_b1'])!
    const r = run(p, (d) => ops.moveInstance(d, ['i_fx2', 'i_b1'], [], -1))
    expect(r.keptLocal).toBe(false)
    expect(r.path).toEqual(['i_b1'])
    expectPoint(worldPos(p, ['i_b1']), before)
    expectMat(worldMatrix(p, ['i_b1'])!, beforeM)
    expect(findInstance(p, 'i_b1')!.instance.xf.r[2]).toBeCloseTo(15, 6)
    // it left the shared Fixture def → gone from both copies
    expect(occurrenceCount(p, 'd_bolt')).toBe(7)
  })

  test('preserves world position into a rotated parent', () => {
    const p = sampleProject()
    const before = worldMatrix(p, ['i_bs'])!
    const r = run(p, (d) => ops.moveInstance(d, ['i_bs'], ['i_fx2'], 0))
    expect(r.path).toEqual(['i_fx2', 'i_bs'])
    expect(children(p, 'd_fixture')[0].id).toBe('i_bs')
    expectMat(worldMatrix(p, ['i_fx2', 'i_bs'])!, before)
  })

  test('Ctrl-copy keeps the original', () => {
    const p = sampleProject()
    const r = run(p, (d) => ops.moveInstance(d, ['i_fx1', 'i_plate'], [], 1, { copy: true }))
    expect(children(p, 'd_fixture')[0].id).toBe('i_plate')
    expect(r.path[0]).not.toBe('i_plate')
    expect(children(p, 'd_root')[1].id).toBe(r.path[0])
    expect(children(p, 'd_root')[1].def).toBe('d_plate')
    expect(occurrenceCount(p, 'd_plate')).toBe(3)
  })

  test('index is correct when reordering within the same parent', () => {
    const p = sampleProject()
    // move i_fx1 (index 0) to "before i_bs" (index 2 in the list before removal) → ends at index 1
    run(p, (d) => ops.moveInstance(d, ['i_fx1'], [], 2))
    expect(children(p, 'd_root').map((c) => c.id)).toEqual(['i_fx2', 'i_fx1', 'i_bs'])
    // move i_bs (index 2) to index 0
    run(p, (d) => ops.moveInstance(d, ['i_bs'], [], 0))
    expect(children(p, 'd_root').map((c) => c.id)).toEqual(['i_bs', 'i_fx2', 'i_fx1'])
    // append
    run(p, (d) => ops.moveInstance(d, ['i_bs'], [], -1))
    expect(children(p, 'd_root').map((c) => c.id)).toEqual(['i_fx2', 'i_fx1', 'i_bs'])
    // same parent keeps the xf verbatim
    expect(findInstance(p, 'i_fx2')!.instance.xf).toEqual({ t: [75, 0, 0], r: [0, 0, 15], s: [1, 1, 1] })
  })

  test('a move into its own subtree, or into another copy of itself, is refused', () => {
    const p = sampleProject()
    expect(() => ops.moveInstance(p, ['i_fx1'], ['i_fx1'], 0)).toThrow(OpError)
    expect(() => ops.moveInstance(p, ['i_fx1'], ['i_fx1', 'i_w1'], 0)).toThrow(OpError)
    expect(() => ops.moveInstance(p, ['i_fx1', 'i_w1'], ['i_fx2', 'i_w1'], 0)).toThrow(OpError)
    expect(() => ops.moveInstance(p, ['i_fx1'], ['i_bs'], 0)).toThrow(/not a group/)
  })

  test('shear keeps the local xf and reports it', () => {
    const p = sampleProject()
    const g: GroupDef = { id: 'd_squash', name: 'Squash', kind: 'group', op: 'none', children: [] }
    ops.addDef(p, g)
    ops.addInstance(p, 'd_root', -1, { id: 'i_sq', def: 'd_squash', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [2, 1, 1] } })
    const r = run(p, (d) => ops.moveInstance(d, ['i_fx2'], ['i_sq'], -1)) // fx2 is rotated 15° → shear under non-uniform scale
    expect(r.keptLocal).toBe(true)
    expect(findInstance(p, 'i_fx2')!.instance.xf).toEqual({ t: [75, 0, 0], r: [0, 0, 15], s: [1, 1, 1] })
  })
})

describe('remove / delete / purge', () => {
  test('removeInstance keeps the def', () => {
    const p = sampleProject()
    const removed = run(p, (d) => ops.removeInstance(d, ['i_bs']))
    expect(removed.id).toBe('i_bs')
    expect(p.defs.d_boltsizes).toBeDefined()
    expect(occurrenceCount(p, 'd_boltsizes')).toBe(0)
  })

  test('deleteDefinition: refused when referenced by part(); otherwise cascades', () => {
    const p = sampleProject()
    expect(() => ops.deleteDefinition(p, 'd_bolt')).toThrow("Can't delete 'Bolt': used by code in 'Bolt sizes'")
    expect(() => ops.deleteDefinition(p, 'd_root')).toThrow(OpError)
    const r = run(p, (d) => ops.deleteDefinition(d, 'd_washer'))
    expect(r.removedInstances).toBe(4)
    expect(p.defs.d_washer).toBeUndefined()
    expect(instancesOf(p, 'd_washer')).toEqual([])
    expect(children(p, 'd_fixture').length).toBe(5)
    // once Bolt sizes is gone, Bolt can be deleted too
    run(p, (d) => ops.deleteDefinition(d, 'd_boltsizes'))
    const r2 = run(p, (d) => ops.deleteDefinition(d, 'd_bolt'))
    expect(r2.removedInstances).toBe(4)
  })

  test('purgeUnused reaches a fixpoint', () => {
    const p = sampleProject()
    run(p, (d) => ops.removeInstance(d, ['i_fx1']))
    run(p, (d) => ops.removeInstance(d, ['i_fx2']))
    // Fixture unused → then Plate, Washer → then Disc, Hole; Bolt is still referenced by Bolt sizes
    const n = run(p, (d) => ops.purgeUnused(d))
    expect(n).toBe(5)
    expect(Object.keys(p.defs).sort()).toEqual(['d_bolt', 'd_boltsizes', 'd_root'])
    expect(run(p, (d) => ops.purgeUnused(d))).toBe(0)
  })
})

describe('renameDef', () => {
  test("rewrites part('Bolt' and part(\"Bolt\"", () => {
    const p = sampleProject()
    const bs = p.defs.d_boltsizes as CodeDef
    bs.code += `\nconst extra = part("Bolt")\nconst other = part( 'Bolt' , { length: 3 })\nconst no = part('Bolts')`
    const changed = run(p, (d) => ops.renameDef(d, 'd_bolt', '  Screw  '))
    expect(changed).toEqual(['d_boltsizes'])
    expect(p.defs.d_bolt.name).toBe('Screw')
    const c = (p.defs.d_boltsizes as CodeDef).code
    expect(c).toContain("part('Screw', { length })")
    expect(c).toContain('part("Screw")')
    expect(c).toContain("part('Screw' , { length: 3 })")
    expect(c).toContain("part('Bolts')")
    expect(c).not.toContain("'Bolt'")
  })

  test('rejects a duplicate, a quote, Scene, empty and the root', () => {
    const p = sampleProject()
    expect(() => ops.renameDef(p, 'd_bolt', 'Plate')).toThrow("'Plate' is already used")
    expect(() => ops.renameDef(p, 'd_bolt', "Bo'lt")).toThrow(/quotes/)
    expect(() => ops.renameDef(p, 'd_bolt', 'a"b')).toThrow(/quotes/)
    expect(() => ops.renameDef(p, 'd_bolt', 'Scene')).toThrow(/reserved/)
    expect(() => ops.renameDef(p, 'd_bolt', '   ')).toThrow(/empty/)
    expect(() => ops.renameDef(p, 'd_root', 'World')).toThrow(OpError)
    expect(() => ops.renameDef(p, 'd_bolt', 'x'.repeat(65))).toThrow(/64/)
    expect(run(p, (d) => ops.renameDef(d, 'd_bolt', 'Bolt'))).toEqual([])
  })

  test('checkDefName', () => {
    const p = sampleProject()
    expect(ops.checkDefName(p, 'Nut')).toBeNull()
    expect(ops.checkDefName(p, 'Bolt')).toMatch(/already used/)
    expect(ops.checkDefName(p, 'Bolt', 'd_bolt')).toBeNull()
    expect(ops.checkDefName(p, 'a`b')).not.toBeNull()
    expect(ops.checkDefName(p, 'a\\b')).not.toBeNull()
    expect(ops.checkDefName(p, 'a\nb')).not.toBeNull()
  })
})

describe('wrap / ungroup', () => {
  test('wrapInGroup keeps world positions; ungroup restores them', () => {
    const p = sampleProject()
    const before = worldMatrix(p, ['i_fx2', 'i_b2'])!
    const gpath = run(p, (d) => ops.wrapInGroup(d, ['i_fx2', 'i_b2'], 'union'))
    expect(gpath[0]).toBe('i_fx2')
    const gi = findInstance(p, gpath[1])!
    expect(gi.index).toBe(6) // same index as i_b2 had
    const g = p.defs[gi.instance.def] as GroupDef
    expect(g.name).toBe('Union')
    expect(g.op).toBe('union')
    expect(g.children.map((c) => c.id)).toEqual(['i_b2'])
    expectMat(worldMatrix(p, [...gpath, 'i_b2'])!, before)

    // give the group a transform, then ungroup
    gi.instance.xf = { t: [5, 6, 7], r: [0, 0, 30], s: [2, 2, 2] }
    const childWorld = worldMatrix(p, [...gpath, 'i_b2'])!
    const paths = run(p, (d) => ops.ungroup(d, gpath))
    expect(paths.length).toBe(1)
    expect(paths[0][0]).toBe('i_fx2')
    expect(paths[0][1]).not.toBe('i_b2')
    expectMat(worldMatrix(p, paths[0])!, childWorld)
    expect(p.defs[g.id]).toBeDefined() // the group def stays in the Library
  })

  test('wrap names are unique; ungroup refuses shear and non-groups', () => {
    const p = sampleProject()
    const a = run(p, (d) => ops.wrapInGroup(d, ['i_bs'], 'none'))
    const b = run(p, (d) => ops.wrapInGroup(d, a, 'none'))
    expect(p.defs[findInstance(p, a[0])!.instance.def].name).toBe('Group')
    expect(p.defs[findInstance(p, b[0])!.instance.def].name).toBe('Group 2')
    expect(() => ops.ungroup(p, ['i_fx1', 'i_plate'])).toThrow(/not a group/)
    const q = sampleProject()
    const gp = ops.wrapInGroup(q, ['i_fx2'], 'none')
    findInstance(q, gp[0])!.instance.xf.s = [2, 1, 1] // non-uniform scale around a 15° rotated child
    expect(() => ops.ungroup(q, gp)).toThrow(/sheared/)
  })

  test('ungroup: group color wins, hidden propagates', () => {
    const p = sampleProject()
    const gp = ops.wrapInGroup(p, ['i_bs'], 'none')
    const gi = findInstance(p, gp[0])!.instance
    gi.color = '#123456'
    gi.hidden = true
    const [np] = run(p, (d) => ops.ungroup(d, gp))
    const ni = findInstance(p, np[0])!.instance
    expect(ni.color).toBe('#123456')
    expect(ni.hidden).toBe(true)
    expect(ni.xf).toEqual({ t: [-24, -45, 0], r: [0, 0, 0], s: [1, 1, 1] })
  })
})

describe('property ops', () => {
  test('label, transform, override, color, hidden, code, params, op', () => {
    const p = sampleProject()
    run(p, (d) => ops.setInstanceLabel(d, 'i_bs', '  Rack '))
    expect(findInstance(p, 'i_bs')!.instance.name).toBe('Rack')
    run(p, (d) => ops.setInstanceLabel(d, 'i_bs', ''))
    expect(findInstance(p, 'i_bs')!.instance.name).toBeUndefined()

    run(p, (d) => ops.setTransform(d, 'i_bs', { t: [1, 2, 3], r: [0, 0, 0], s: [-1, 1, 1] }))
    expect(findInstance(p, 'i_bs')!.instance.xf.t).toEqual([1, 2, 3])
    expect(() => ops.setTransform(p, 'i_bs', { t: [1, 2, 3], r: [0, 0, 0], s: [0, 1, 1] })).toThrow("Scale can't be 0")
    expect(() => ops.setTransform(p, 'i_bs', { t: [NaN, 2, 3], r: [0, 0, 0], s: [1, 1, 1] })).toThrow(OpError)

    run(p, (d) => ops.setOverride(d, 'i_bs', 'count', 3))
    expect(findInstance(p, 'i_bs')!.instance.params).toEqual({ count: 3 })
    expect(() => ops.setOverride(p, 'i_bs', 'count', 'three')).toThrow(OpError)
    expect(() => ops.setOverride(p, 'i_bs', 'nope', 1)).toThrow(OpError)
    expect(() => ops.setOverride(p, 'i_fx1', 'x', 1)).toThrow(/Groups have no parameters/)
    run(p, (d) => ops.setOverride(d, 'i_bs', 'count', undefined))
    expect(findInstance(p, 'i_bs')!.instance.params).toBeUndefined()
    findInstance(p, 'i_bs')!.instance.params = { len: 4 }
    run(p, (d) => ops.setOverride(d, 'i_bs', 'len', undefined)) // stale key removal
    expect(findInstance(p, 'i_bs')!.instance.params).toBeUndefined()

    run(p, (d) => ops.setColor(d, { instance: 'i_bs' }, '#ABCDEF'))
    expect(findInstance(p, 'i_bs')!.instance.color).toBe('#abcdef')
    run(p, (d) => ops.setColor(d, { def: 'd_plate' }, undefined))
    expect(p.defs.d_plate.color).toBeUndefined()
    expect(() => ops.setColor(p, { def: 'd_plate' }, 'red')).toThrow(OpError)

    run(p, (d) => ops.setHidden(d, 'i_fx1', true))
    run(p, (d) => ops.setHidden(d, 'i_disc', true))
    expect(run(p, (d) => ops.unhideAll(d))).toBe(2)

    run(p, (d) => ops.setCode(d, 'd_bolt', "return part('Bolt sizes')")) // a code cycle is accepted (reported at eval)
    expect(() => ops.setCode(p, 'd_fixture', 'x')).toThrow(OpError)

    run(p, (d) => ops.setParamDefs(d, 'd_disc', [{ name: 'r', type: 'number', default: 2 }, { name: 'kind', type: 'choice', default: 'a', options: ['a', 'b'] }]))
    expect(() => ops.setParamDefs(p, 'd_disc', [{ name: '1x', type: 'number', default: 2 }])).toThrow(/identifier/)
    expect(() => ops.setParamDefs(p, 'd_disc', [{ name: 'a', type: 'number', default: 1 }, { name: 'a', type: 'number', default: 1 }])).toThrow(/duplicate/)
    expect(() => ops.setParamDefs(p, 'd_disc', [{ name: 'k', type: 'choice', default: 'z', options: ['a'] }])).toThrow(OpError)
    expect(() => ops.setParamDefs(p, 'd_disc', [{ name: 'b', type: 'boolean', default: 1 as unknown as boolean }])).toThrow(OpError)

    run(p, (d) => ops.setGroupOp(d, 'd_washer', 'intersect'))
    expect((p.defs.d_washer as GroupDef).op).toBe('intersect')
    expect(() => ops.setGroupOp(p, 'd_root', 'union')).toThrow(OpError)
  })

  test('addDef / addInstance from a template', () => {
    const p = sampleProject()
    const def = createTemplateDef('cube', p, 9)
    expect(def.name).toBe('Cube')
    expect(def.color).toBe(PALETTE[1])
    run(p, (d) => ops.addDef(d, def))
    const i = run(p, (d) => ops.addInstance(d, 'd_root', -1, { id: 'i_newcube', def: def.id, xf: { t: placementFor('cube', 40), r: [0, 0, 0], s: [1, 1, 1] } }))
    expect(i).toBe(3)
    expect(findInstance(p, 'i_newcube')!.instance.xf.t).toEqual([50, 0, 0])
    expect(createTemplateDef('cube', p, 0).name).toBe('Cube 2')
    expect(() => ops.addDef(p, { ...def })).toThrow(OpError) // duplicate id
    expect(() => ops.addInstance(p, 'd_fixture', 0, { id: 'i_loop', def: 'd_fixture', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } })).toThrow(/inside itself/)
    expect(() => ops.addInstance(p, 'd_root', 0, { id: 'i_bs', def: 'd_bolt', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } })).toThrow(/Duplicate/)
    const g = createTemplateDef('group', p, 0)
    expect(g.kind).toBe('group')
    expect(g.color).toBeUndefined()
    expect(placementFor('torus', null)).toEqual([0, 0, 0])
    expect(placementFor('torus', 10)).toEqual([23, 0, 0])
    expect(TEMPLATES.code.baseName).toBe('Object')
    expect(ops.linkedOffset(null)).toBe(15)
    expect(ops.linkedOffset(60.2)).toBe(66)
    expect(resolvePath(p, ['i_newcube'])).not.toBeNull()
  })
})

describe('world-preserving ops keep tiny scales valid (§2.2: no zero scale)', () => {
  const tiny = (): Project => {
    const p = sampleProject()
    const root = p.defs[p.root] as GroupDef
    root.children.push({ id: 'i_tiny', def: 'd_bolt', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [0.0001, 0.0001, 0.0001] } })
    root.children.push({ id: 'i_big', def: 'd_empty', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1000, 1000, 1000] } })
    p.defs.d_empty = { id: 'd_empty', name: 'Big group', kind: 'group', op: 'none', children: [] }
    return p
  }
  const worldScale = (p: Project, path: InstancePath) => { const m = worldMatrix(p, path)!; return Math.hypot(m[0], m[1], m[2]) }

  test('moveInstance into a ×1000 group: a 0.0001 part keeps a non-zero local scale and its world size', () => {
    const p = tiny()
    const before = worldScale(p, ['i_tiny'])
    const r = run(p, (d) => ops.moveInstance(d, ['i_tiny'], ['i_big'], -1))
    const moved = children(p, 'd_empty')[0]
    expect(moved.xf.s.every((v) => v !== 0)).toBe(true)
    expect(worldScale(p, r.path) / before).toBeCloseTo(1, 6)
    expect(parseProject(serialize(p)).ok).toBe(true) // the autosave of this state still loads
  })

  test('moveInstance keeps a 0.0007 scale exact (an absolute 1e-6 step made it 0.000001: +43 % in size)', () => {
    const p = tiny()
    children(p, p.root)[3].xf.s = [0.0007, 0.0007, 0.0007]
    const before = worldScale(p, ['i_tiny'])
    const r = run(p, (d) => ops.moveInstance(d, ['i_tiny'], ['i_big'], -1))
    expect(worldScale(p, r.path) / before).toBeCloseTo(1, 6)
  })

  test('ungroup of a ×0.001 group holding a ×0.0001 child keeps a valid scale', () => {
    const p = tiny()
    const g = p.defs.d_empty as GroupDef
    g.children.push({ id: 'i_c', def: 'd_plate', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [0.0001, 0.0001, 0.0001] } })
    children(p, p.root)[4].xf = { t: [1, 0, 0], r: [0, 0, 0], s: [0.001, 0.001, 0.001] }
    const before = worldScale(p, ['i_big', 'i_c'])
    const [np] = run(p, (d) => ops.ungroup(d, ['i_big']))
    expect(worldScale(p, np) / before).toBeCloseTo(1, 6)
  })
})

describe('uniqueName always terminates', () => {
  /** a taken-set that fails the test instead of hanging it when the search does not advance */
  class Watched extends Set<string> {
    calls = 0
    has(v: string): boolean { if (++this.calls > 10_000) throw new Error('uniqueName is not advancing'); return super.has(v) }
  }
  test('a name ending in a number too large to count up from (>= 2^53) gets a free name', () => {
    const base = 'Rack 100000000000000000000'
    const out = uniqueName(base, new Watched([base]))
    expect(out).not.toBe(base)
    expect(out.length).toBeLessThanOrEqual(64)
  })
  test('cloneDef of such a def (Ctrl+Shift+D / Make unique / Paste unique) returns', () => {
    const p = sampleProject()
    p.defs.d_boltsizes.name = 'Rack 100000000000000000000'
    const id = run(p, (d) => ops.cloneDef(d, 'd_boltsizes'))
    expect(p.defs[id].name).not.toBe('Rack 100000000000000000000')
  })
  test('ordinary numbered names still count up', () => {
    expect(uniqueName('Fixture 2', new Watched(['Fixture', 'Fixture 2']))).toBe('Fixture 3')
    expect(uniqueName('Cube', new Watched(['Cube', 'Cube 2']))).toBe('Cube 3')
  })
})
