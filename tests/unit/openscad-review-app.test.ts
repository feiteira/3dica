// OpenSCAD objects in the app, fixed after review: dropdown values in overrides, the Output panel's line count,
// message lengths, the parameters that are not parameters, and main-thread scans that must stay linear.
import { describe, expect, test } from 'vitest'
import { EditorState } from '@codemirror/state'
import type { CodeDef, Definition, ParamValue, Project } from '../../src/core/types'
import { emptyProject } from '../../src/core/project-io'
import { buildSpecs } from '../../src/core/evalspec'
import { findInstance } from '../../src/core/graph'
import * as ops from '../../src/core/ops'
import { reachableScadFiles, scadParams, scadRefs, scadRefSites } from '../../src/core/scad'
import { planScadImport } from '../../src/core/scad-import'
import { createEngine, EvalFailure, MAX_CONSOLE_LINES } from '../../src/eval/engine'
import type { EvalError } from '../../src/eval/protocol'
import { runScad } from '../../src/openscad'
import { choiceOption, extractParams } from '../../src/openscad/customizer'
import { notParamsText } from '../../src/ui/scad-panel'
import { openscad, scadCompletions } from '../../src/ui/scad-lang'

let seq = 0
function scadDef(name: string, code: string, files?: Record<string, string>): CodeDef {
  const d: CodeDef = { id: `d_r${++seq}`, name, kind: 'code', code, params: scadParams(code), lang: 'openscad' }
  if (files) d.files = files
  return d
}
function jsDef(name: string, code: string): CodeDef {
  return { id: `d_rj${++seq}`, name, kind: 'code', code, params: [] }
}
function project(...defs: Definition[]): Project {
  const p = emptyProject()
  for (const d of defs) p.defs[d.id] = d
  return p
}
function run(p: Project, def: Definition, params?: Record<string, ParamValue>) {
  const job = buildSpecs(p).jobFor(def.id, params)
  if (!job) throw new Error(`no job for ${def.name}`)
  return createEngine({ scad: runScad }).run(job)
}
function failOf(p: Project, def: Definition): EvalError {
  try { run(p, def) } catch (x) {
    expect(x).toBeInstanceOf(EvalFailure)
    return (x as EvalFailure).error
  }
  throw new Error('expected an EvalFailure')
}
const width = (r: { meshes: { bbox: [number[], number[]] }[] }) => Math.round((Math.max(...r.meshes.map((m) => m.bbox[1][0])) - Math.min(...r.meshes.map((m) => m.bbox[0][0]))) * 1000) / 1000

const PLATE = 'holes = 2; // [0, 1, 2, 3]\nsize = 20; // [10:Small, 20:Medium, 30:Large]\ncube([size, 5, 1 + holes]);\n'

describe('dropdown parameters take the OpenSCAD item value as well as the option', () => {
  test('choiceOption', () => {
    expect(choiceOption(PLATE, 'holes', 3)).toBe('3')
    expect(choiceOption(PLATE, 'holes', '3')).toBe('3')
    expect(choiceOption(PLATE, 'size', 30)).toBe('Large')
    expect(choiceOption(PLATE, 'size', '30')).toBe('Large')
    expect(choiceOption(PLATE, 'size', 'Large')).toBe('Large')
    expect(choiceOption(PLATE, 'size', 25)).toBeNull()
    expect(choiceOption(PLATE, 'holes', true)).toBeNull()
    expect(choiceOption('shape = "r"; // [r:Round, s:Square]\n', 'shape', 's')).toBe('Square')
    expect(choiceOption(PLATE, 'nope', 1)).toBeNull()
  })
  test('part() from OpenSCAD and from JSCAD code', () => {
    const plate = scadDef('plate', PLATE)
    const a = scadDef('A', 'part("plate", holes = 3, size = 30);\n')
    const b = jsDef('B', "return part('plate', { size: 10, holes: 1 })")
    const p = project(plate, a, b)
    expect(width(run(p, a))).toBe(30)
    expect(width(run(p, b))).toBe(10)
    const bad = scadDef('C', 'part("plate", size = 25);\n')
    expect(failOf(project(plate, bad), bad).message).toBe('part("plate"): size must be one of "Small", "Medium", "Large"')
  })
  test('instance overrides (Inspector, AI, MCP) store the option', () => {
    const plate = scadDef('plate', PLATE)
    const p = project(plate)
    const inst = { id: 'i_r1', def: plate.id, xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } as never }
    ops.addInstance(p, p.root, -1, inst)
    ops.setOverride(p, inst.id, 'holes', 3)
    ops.setOverride(p, inst.id, 'size', 30)
    expect(findInstance(p, inst.id)?.instance.params).toEqual({ holes: '3', size: 'Large' })
    expect(() => ops.setOverride(p, inst.id, 'size', 25)).toThrow(`Invalid value for 'size': it must be one of "Small", "Medium", "Large"`)
    ops.setScadParamDefault(p, plate.id, 'size', 10)
    expect((p.defs[plate.id] as CodeDef).code).toContain('size = 10; // [10:Small')
  })
})

describe('the Output panel', () => {
  test('one count of the lines left out, however they were dropped; the note is not a warning', () => {
    const d = scadDef('Flood', 'for (i = [0 : 50000]) echo(i);\ncube(1);\n')
    const r = run(project(d), d)
    expect(r.console).toHaveLength(MAX_CONSOLE_LINES + 1)
    expect(r.console!.at(-1)).toEqual({ level: 'warning', text: '… 49,001 more lines not shown (the limit is 1,000)' })
    expect(r.warnings.join('\n')).not.toMatch(/console lines were not kept/)
  }, 60_000)
  test('no note when everything fits', () => {
    const d = scadDef('Few', 'for (i = [0 : 2]) echo(i);\ncube(1);\n')
    expect(run(project(d), d).console?.map((l) => l.text)).toEqual(['0', '1', '2'])
  })
})

describe('messages stay short', () => {
  test('a JSCAD error message is cut', () => {
    const d = jsDef('Huge', "throw new Error('x'.repeat(5_000_000))")
    const e = failOf(project(d), d)
    expect(e.message.length).toBeLessThan(10_100)
    expect(e.message).toMatch(/ … \(cut\)$/)
  })
  test('an OpenSCAD error and its console line are cut', () => {
    const d = scadDef('Huge', 's = chr([for (i = [0:99999]) 65]);\nassert(false, s);\n')
    const e = failOf(project(d), d)
    expect(e.message.length).toBeLessThan(1100)
    for (const l of e.console ?? []) expect(l.text.length).toBeLessThan(10_100)
  })
  test('a long echo line is kept up to 100,000 characters', () => {
    const d = scadDef('Echo', 's = chr([for (i = [0:199999]) 65]);\necho(s);\ncube(1);\n')
    const line = run(project(d), d).console![0].text
    expect(line.length).toBeLessThan(100_100)
    expect(line).toMatch(/^"AAAA.* … \(cut\)$/)
  })
})

describe('literals that are not parameters are listed in the Inspector', () => {
  test('text without options and vectors; computed values and the Hidden tab are not listed', () => {
    const code = 'label = "Hi";\nsize = [30, 20, 10];\nw = 2;\nr = w / 2;\nshape = "a"; // [a, b]\n/* [Hidden] */\nv = [1, 2];\n'
    expect(notParamsText(code)).toBe('Not parameters here: label (text without options), size (a vector) — edit them in the code.')
    expect(notParamsText('w = 2;\nr = w / 2;\n')).toBe('')
  })
})

describe('main-thread scans stay linear', () => {
  test('the Customizer reads tens of thousands of assignments quickly; a later one still wins and moves last', () => {
    const lines: string[] = []
    for (let i = 0; i < 60_000; i++) lines.push(`a${i % 30_000} = ${i};`)
    const src = lines.join('\n') + '\ncube(1);\n'
    const t0 = Date.now()
    const r = extractParams(src)
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(r.params).toHaveLength(30_000)
    expect(r.params[0]).toMatchObject({ name: 'a0', default: 30_000 })
    expect(extractParams('a = 1;\nb = 2;\na = 3;\n').params.map((p) => [p.name, p.default])).toEqual([['b', 2], ['a', 3]])
  })
  test('an object with 150 attached files does not rescan them on every project change', () => {
    const files: Record<string, string> = {}
    const body = Array.from({ length: 1500 }, (_, i) => `function f${i}(x) = x * ${i} + sin(x) / 2;`).join('\n')
    for (let i = 0; i < 150; i++) files[`lib/f${i}.scad`] = `// file ${i}\n${i < 149 ? `include <f${i + 1}.scad>\n` : ''}${body}\nmodule m${i}() part("Bolt");\n`
    const d = scadDef('Big', 'include <lib/f0.scad>\nm0();\n', files)
    const bolt = scadDef('Bolt', 'cube(1);\n')
    const p = project(d, bolt)
    expect(reachableScadFiles(d.code, files)).toHaveLength(150)
    expect(scadRefs(d.code, files)).toEqual(['Bolt'])
    const t0 = Date.now()
    for (let k = 0; k < 20; k++) {
      buildSpecs(p)
      scadRefSites(d.code, files)
    }
    expect(Date.now() - t0).toBeLessThan(3000)
  }, 60_000)
  test('a file that does not tokenize: the part() scan counts lines as it goes', () => {
    const src = Array.from({ length: 15_000 }, () => 'part("a");').join('\n') + '\n`'
    const t0 = Date.now()
    const refs = scadRefSites(src)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(refs).toHaveLength(15_000)
    expect(refs[14_999]).toEqual({ name: 'a', line: 15_000, col: 1 })
  })
  test('import tokenizes each file once', () => {
    const input = Array.from({ length: 40 }, (_, i) => ({ name: `f${i}.scad`, text: `${i < 39 ? `include <f${i + 1}.scad>\n` : 'include <gone.scad>\n'}${'x = 1;\n'.repeat(20_000)}` }))
    const t0 = Date.now()
    const plan = planScadImport(input)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(plan).toHaveLength(1)
    expect(Object.keys(plan[0].files)).toHaveLength(39)
    expect(plan[0].missing).toEqual(['gone.scad'])
  }, 30_000)
  test('completion on a file with many blank lines', () => {
    const doc = 'w = 1;\n' + '\n'.repeat(100_000) + 'cu'
    const state = EditorState.create({ doc, extensions: openscad() })
    const pos = doc.length
    const t0 = Date.now()
    const r = scadCompletions({
      state, pos, explicit: false,
      matchBefore(re: RegExp) {
        const line = state.doc.lineAt(pos)
        const text = line.text.slice(0, pos - line.from)
        const m = new RegExp(`(?:${re.source})$`).exec(text)
        return m ? { from: pos - m[0].length, to: pos, text: m[0] } : null
      },
    })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r?.options.some((o) => o.label === 'w')).toBe(true)
  })
})
