// OpenSCAD objects in the evaluation engine: runScad wired to the memo, part() both ways, the geometry budget,
// parameter overrides, errors with lines, and the console output. Real interpreter and jscad in Node.
import { describe, expect, test } from 'vitest'
import type { CodeDef, Definition, ParamValue, Project } from '../../src/core/types'
import { emptyProject } from '../../src/core/project-io'
import { buildSpecs } from '../../src/core/evalspec'
import { scadParams } from '../../src/core/scad'
import { createEngine, EvalFailure, MAX_TRIANGLES, usesScad } from '../../src/eval/engine'
import type { EvalError } from '../../src/eval/protocol'
import { runScad } from '../../src/openscad'

let seq = 0
function scadDef(name: string, code: string, files?: Record<string, string>): CodeDef {
  const d: CodeDef = { id: `d_s${++seq}`, name, kind: 'code', code, params: scadParams(code), lang: 'openscad' }
  if (files) d.files = files
  return d
}
function jsDef(name: string, code: string, params: CodeDef['params'] = []): CodeDef {
  return { id: `d_j${++seq}`, name, kind: 'code', code, params }
}
function project(...defs: Definition[]): Project {
  const p = emptyProject()
  for (const d of defs) p.defs[d.id] = d
  return p
}
const engine = () => createEngine({ scad: runScad })

function run(p: Project, def: Definition, params?: Record<string, ParamValue>) {
  const job = buildSpecs(p).jobFor(def.id, params)
  if (!job) throw new Error(`no job for ${def.name}: ${buildSpecs(p).specErrors.get(def.id)?.message}`)
  return engine().run(job)
}
function failOf(p: Project, def: Definition, params?: Record<string, ParamValue>): EvalError {
  try { run(p, def, params) } catch (x) {
    expect(x).toBeInstanceOf(EvalFailure)
    return (x as EvalFailure).error
  }
  throw new Error('expected an EvalFailure')
}
const size = (r: { meshes: { bbox: [number[], number[]] }[] }) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const m of r.meshes) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], m.bbox[0][k]); max[k] = Math.max(max[k], m.bbox[1][k]) }
  return max.map((v, k) => Math.round((v - min[k]) * 1000) / 1000)
}

describe('OpenSCAD objects in the engine', () => {
  test('a cube with a parameter; overrides change the mesh; echo goes to the console', () => {
    const d = scadDef('Box', 'w = 10; // [1:50]\necho("w =", w);\ncube([w, 5, 2]);\n')
    const p = project(d)
    const a = run(p, d)
    expect(size(a)).toEqual([10, 5, 2])
    expect(a.console).toEqual([{ level: 'echo', text: '"w =", 10', line: 2, col: 1 }])
    const b = run(p, d, { w: 30 })
    expect(size(b)).toEqual([30, 5, 2])
    expect(b.console?.[0].text).toBe('"w =", 30')
  })

  test('the spec carries the language and files; the key changes with the files', () => {
    const d = scadDef('Main', 'include <lib.scad>\nthing();\n', { 'lib.scad': 'module thing() cube(3);\n' })
    const p = project(d)
    const s1 = buildSpecs(p).specOf(d.id)!
    expect(s1.kind === 'code' && s1.lang).toBe('openscad')
    expect(usesScad(s1)).toBe(true)
    expect(size(run(p, d))).toEqual([3, 3, 3])
    const d2 = { ...d, files: { 'lib.scad': 'module thing() cube(4);\n' } }
    const s2 = buildSpecs(project(d2)).specOf(d.id)!
    expect(s2.defKey).not.toBe(s1.defKey)
    expect(size(run(project(d2), d2))).toEqual([4, 4, 4])
  })

  test('a missing include names the file, at its line', () => {
    const d = scadDef('Main', '// gear\ninclude <gear.scad>\ncube(1);\n')
    const e = failOf(project(d), d)
    expect(e.kind).toBe('runtime')
    expect(e.message).toContain('gear.scad')
    expect(e.line).toBe(2)
    expect(e.console?.at(-1)).toMatchObject({ level: 'error', line: 2 })
  })

  test('syntax and runtime errors carry the line; output printed before an error is kept', () => {
    const d = scadDef('Bad', 'cube(1);\nx = ;\n')
    const e = failOf(project(d), d)
    expect(e.kind).toBe('syntax')
    expect(e.line).toBe(2)
    const r = scadDef('Assert', 'echo("before");\nassert(false, "nope");\n')
    const e2 = failOf(project(r), r)
    expect(e2.kind).toBe('runtime')
    expect(e2.line).toBe(2)
    expect(e2.console?.[0]).toMatchObject({ level: 'echo', text: '"before"' })
    expect(e2.console?.some((l) => l.level === 'error')).toBe(true)
  })

  test('an error in an attached file is prefixed with file:line and has no line of its own', () => {
    const d = scadDef('Main', 'use <lib/a.scad>\nbad();\n', { 'lib/a.scad': 'module bad() {\n  assert(false, "inside");\n}\n' })
    const e = failOf(project(d), d)
    expect(e.message).toMatch(/^lib\/a\.scad:2: /)
    expect(e.line).toBeUndefined()
  })

  test('JSCAD part() of an OpenSCAD object, with an override', () => {
    const s = scadDef('Peg', 'h = 10;\ncylinder(r = 2, h = h, $fn = 16);\n')
    const j = jsDef('Row', "return [part('Peg'), translate([10, 0, 0], part('Peg', { h: 20 }))]")
    const p = project(s, j)
    expect(size(run(p, j))).toEqual([14, 4, 20])
  })

  test('OpenSCAD part() of a JSCAD object, with an override; a bad override points at the call', () => {
    const j = jsDef('Slab', 'return cuboid({ size: [params.w, 4, 2], center: [0, 0, 1] })', [{ name: 'w', type: 'number', default: 10 }])
    const s = scadDef('Pair', 'part("Slab");\ntranslate([0, 10, 0]) part("Slab", w = 30);\n')
    const p = project(j, s)
    expect(size(run(p, s))).toEqual([30, 14, 2])
    const bad = scadDef('Bad', 'cube(1);\npart("Slab", depth = 3);\n')
    const e = failOf(project(j, bad), bad)
    expect(e.message).toContain('unknown parameter "depth"')
    expect(e.line).toBe(2)
  })

  test('a file with its own module part makes no 3Dica dependency', () => {
    const s = scadDef('Own', 'module part(name) cube(2);\npart("Nope");\n')
    const p = project(s)
    expect(buildSpecs(p).specErrors.has(s.id)).toBe(false)
    expect(size(run(p, s))).toEqual([2, 2, 2])
  })

  test('an unknown part() name is a spec error at its line', () => {
    const s = scadDef('Lost', 'cube(1);\npart("Nut");\n')
    const e = buildSpecs(project(s)).specErrors.get(s.id)!
    expect(e.message).toBe('Unknown part "Nut" — no definition with that name')
    expect(e.line).toBe(2)
  })

  test('the geometry budget stops a huge primitive with the line and a hint', () => {
    const s = scadDef('Huge', 'cube(1);\nsphere(10, $fn = 3000);\n')
    const e = failOf(project(s), s)
    expect(e.message).toMatch(/^Too much geometry: .*\$fn.* — lower \$fn$/)
    expect(e.message).toContain(MAX_TRIANGLES.toLocaleString('en-US'))
    expect(e.line).toBe(2)
  })

  test('the geometry budget stops a runaway loop', () => {
    const s = scadDef('Many', 'for (i = [0 : 999], j = [0 : 999]) translate([i, j, 0]) cube(0.5);\n')
    const e = failOf(project(s), s)
    // the interpreter's shape count or the builder's polygon budget, whichever stops it first
    expect(e.message).toMatch(/^Too much geometry: this code made (more than 2,000,000 polygons|[\d,]+ shapes and transforms)/)
  }, 60_000)

  test('a 2D top level is a 1 mm slab with a warning', () => {
    const s = scadDef('Flat', 'square([10, 4]);\n')
    const r = run(project(s), s)
    expect(size(r)).toEqual([10, 4, 1])
    expect(r.warnings.join(' ')).toContain('2D result shown 1 mm thick')
    expect(r.console?.some((l) => l.level === 'warning')).toBe(true)
  })

  test('unseeded rands() are seeded per result: a re-run is identical', () => {
    const s = scadDef('Rand', 'n = 3;\nv = rands(0, 10, 1)[0];\necho(v);\ncube(1 + v);\n')
    const p = project(s)
    const a = run(p, s), b = run(p, s)
    expect(a.console).toEqual(b.console)
    expect(run(p, s, { n: 4 }).console).not.toEqual(a.console)
  })

  test('choice parameters map back to the dropdown value', () => {
    const s = scadDef('Pick', 'size = 20; // [10:Small, 20:Large]\ncube(size);\n')
    expect(s.params).toEqual([{ name: 'size', type: 'choice', default: 'Large', options: ['Small', 'Large'] }])
    const p = project(s)
    expect(size(run(p, s))).toEqual([20, 20, 20])
    expect(size(run(p, s, { size: 'Small' }))).toEqual([10, 10, 10])
  })

  test('an engine without the runtime refuses OpenSCAD specs', () => {
    const s = scadDef('Box', 'cube(1);')
    const job = buildSpecs(project(s)).jobFor(s.id)!
    const e = createEngine()
    expect(e.hasScad()).toBe(false)
    expect(() => e.run(job)).toThrow(/OpenSCAD interpreter is not loaded/)
    e.setScad(runScad)
    expect(e.run(job).tris).toBeGreaterThan(0)
  })

  test('STL export of an OpenSCAD object', () => {
    const s = scadDef('Box', 'cube(2);')
    const job = buildSpecs(project(s)).jobFor(s.id)!
    const r = engine().stl([{ job, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }])
    expect(r.tris).toBe(12)
  })
})
