import { describe, expect, test } from 'vitest'
import type { GroupDef, Project } from '../../src/core/types'
import { sampleProject } from '../../src/core/sample'
import { emptyProject, hasCode, parseProject, serialize, validateProject } from '../../src/core/project-io'
import { paramDefProblems, resolveParamDefs } from '../../src/core/params'

const raw = (p: Project = sampleProject()) => JSON.parse(serialize(p)) as Record<string, any>
const problemsOf = (x: unknown) => {
  const r = parseProject(x)
  expect(r.ok).toBe(false)
  return r.ok ? [] : r.problems
}

describe('serialize → parse', () => {
  test('the sample survives deep-equal', () => {
    const s = sampleProject()
    expect(validateProject(s)).toEqual([])
    const r = parseProject(serialize(s))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.project).toEqual(s)
  })

  test('camera and the empty project survive', () => {
    const s = sampleProject()
    s.camera = { position: [1, 2, 3], target: [0, 0, 0] }
    const r = parseProject(serialize(s))
    expect(r.ok && r.project.camera).toEqual(s.camera)
    const e = parseProject(serialize(emptyProject()))
    expect(e.ok && e.project).toEqual(emptyProject())
    expect(hasCode(emptyProject())).toBe(false)
    expect(hasCode(s)).toBe(true)
  })

  test('key order is stable', () => {
    const text = serialize(sampleProject(), new Date('2026-11-11T12:00:00.000Z'))
    const o = JSON.parse(text)
    expect(Object.keys(o)).toEqual(['format', 'version', 'app', 'name', 'savedAt', 'root', 'defs'])
    expect(o.app).toBe('3dica 0.1.0')
    expect(o.savedAt).toBe('2026-11-11T12:00:00.000Z')
    expect(Object.keys(o.defs)).toEqual([...Object.keys(o.defs)].sort())
    expect(Object.keys(o.defs.d_bolt)).toEqual(['id', 'name', 'kind', 'color', 'params', 'code'])
    expect(Object.keys(o.defs.d_washer)).toEqual(['id', 'name', 'kind', 'color', 'op', 'children'])
    expect(Object.keys(o.defs.d_root)).toEqual(['id', 'name', 'kind', 'op', 'children'])
    expect(Object.keys(o.defs.d_root.children[0])).toEqual(['id', 'def', 'name', 'xf'])
    expect(Object.keys(o.defs.d_bolt.params[0])).toEqual(['name', 'type', 'default', 'min', 'max', 'step'])
    const withCam = { ...sampleProject(), camera: { position: [1, 2, 3], target: [0, 0, 0] } } as Project
    expect(Object.keys(JSON.parse(serialize(withCam)))).toEqual(['format', 'version', 'app', 'name', 'savedAt', 'root', 'camera', 'defs'])
    // same input → same text; 2-space indentation; numeric arrays on one line
    expect(serialize(sampleProject(), new Date('2026-11-11T12:00:00.000Z'))).toBe(text)
    expect(text).toContain('\n  "format": "3dica"')
    expect(text).toContain('"t": [75, 0, 0]')
  })
})

describe('rejections with readable problems', () => {
  test('wrong format', () => {
    expect(problemsOf({ ...raw(), format: 'scad' })[0]).toMatch(/Not a 3Dica project/)
    expect(problemsOf('not json')[0]).toMatch(/Not valid JSON/)
    expect(problemsOf(42)[0]).toMatch(/Not a 3Dica project/)
  })

  test('version 2', () => {
    expect(problemsOf({ ...raw(), version: 2 })[0]).toMatch(/made by a newer 3Dica/)
  })

  test('a dangling def', () => {
    const r = raw()
    r.defs.d_fixture.children[0].def = 'd_nope'
    expect(problemsOf(r).join('\n')).toMatch(/Instance "i_plate" in 'Fixture' refers to a missing definition "d_nope"/)
  })

  test('a duplicate instance id', () => {
    const r = raw()
    r.defs.d_root.children[2].id = 'i_plate'
    expect(problemsOf(r).join('\n')).toMatch(/Duplicate instance id "i_plate"/)
  })

  test('a duplicate def name', () => {
    const r = raw()
    r.defs.d_hole.name = 'Disc'
    expect(problemsOf(r).join('\n')).toMatch(/Duplicate definition name 'Disc'/)
  })

  test('a cycle', () => {
    const r = raw()
    r.defs.d_washer.children.push({ id: 'i_loop', def: 'd_fixture', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } })
    expect(problemsOf(r).join('\n')).toMatch(/Cycle: (Fixture → Washer → Fixture|Washer → Fixture → Washer)/)
  })

  test('a zero scale', () => {
    const r = raw()
    r.defs.d_fixture.children[5].xf.s = [1, 0, 1]
    expect(problemsOf(r).join('\n')).toMatch(/Instance "i_b1" in 'Fixture': scale can't be 0/)
  })

  test('other invariants are listed together', () => {
    const r = raw()
    r.defs.d_bolt.params[0].name = 'not valid'
    r.defs.d_plate.name = "Pl'ate"
    r.defs.d_root.children.push({ id: 'i_r', def: 'd_root', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } })
    r.defs.d_disc.color = 'gold'
    const all = problemsOf(r).join('\n')
    expect(all).toMatch(/valid identifier/)
    expect(all).toMatch(/quotes/)
    expect(all).toMatch(/can't be instanced/)
    expect(all).toMatch(/#rrggbb/)
  })

  test('unknown override keys are kept, informational fields dropped', () => {
    const r = raw()
    r.defs.d_root.children[2].params = { count: 3, len: 4 }
    r.extra = 'ignored'
    const out = parseProject(r)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect((out.project.defs.d_root as GroupDef).children[2].params).toEqual({ count: 3, len: 4 })
      expect('app' in out.project).toBe(false)
      expect('savedAt' in out.project).toBe(false)
    }
  })

  test('uppercase colors are normalized', () => {
    const r = raw()
    r.defs.d_disc.color = '#C9A227'
    const out = parseProject(r)
    expect(out.ok && out.project.defs.d_disc.color).toBe('#c9a227')
  })
})

describe('Open lists every problem of a broken file (§6), without false ones', () => {
  test('a root with one bad child: the zero scale AND the dangling def are reported; the root is not "missing"', () => {
    const r = raw(emptyProject('Bad'))
    r.defs.d_root.children = [{ id: 'i_a', def: 'd_missing', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [0, 1, 1] } }]
    const problems = problemsOf(r)
    expect(problems.some((x) => /scale can't be 0/.test(x))).toBe(true)
    expect(problems.some((x) => /missing definition "d_missing"/.test(x))).toBe(true)
    expect(problems.some((x) => /root definition .* is missing/.test(x))).toBe(false)
    expect(new Set(problems).size).toBe(problems.length) // each problem once
  })

  test('a shared group with one malformed child does not make its instances "refer to a missing definition"', () => {
    const r = raw()
    r.defs.d_fixture.children[1].color = 'red' // one bad field in Fixture
    const problems = problemsOf(r)
    expect(problems).toEqual([expect.stringMatching(/color "red" is not #rrggbb/)])
  })

  test('a code def with a broken parameter list is still known to the instances that place it', () => {
    const r = raw()
    r.defs.d_bolt.params[0].default = 'long'
    const problems = problemsOf(r)
    expect(problems).toEqual([expect.stringMatching(/'Bolt'.*default must be a number/)])
  })
})

describe('parameter names', () => {
  test("'__proto__' is refused: it could never hold a value", () => {
    const r = raw()
    r.defs.d_bolt.params.push({ name: '__proto__', type: 'number', default: 5 })
    expect(problemsOf(r).some((x) => /'__proto__': name must be a valid identifier/.test(x))).toBe(true)
    expect(paramDefProblems([{ name: '__proto__', type: 'number', default: 5 }])).toHaveLength(1)
    // ordinary Object.prototype names are fine: they become own keys
    const pd = [{ name: 'constructor', type: 'number' as const, default: 5 }]
    expect(paramDefProblems(pd)).toEqual([])
    expect(Object.keys(resolveParamDefs(pd, { constructor: 7 } as never))).toEqual(['constructor'])
  })
})
