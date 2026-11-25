// OpenSCAD objects in core: derived parameters, the static part() scan, attached-file paths and limits, project file
// validation and round trip, the project operations, the import planner and the template.
import { describe, expect, test } from 'vitest'
import type { CodeDef, Project } from '../../src/core/types'
import { emptyProject, parseProject, serialize } from '../../src/core/project-io'
import {
  checkScadPath, isScad, MAX_SCAD_FILE_CHARS, normalizeScadFiles, reachableScadFiles, scadDepList, scadIncludeLine,
  scadParamInfo, scadParams, scadRefSites, scadRefs, scadStorePath,
} from '../../src/core/scad'
import { defRefs, referrers } from '../../src/core/graph'
import * as ops from '../../src/core/ops'
import { OpError } from '../../src/core/ops'
import { paramDefProblems } from '../../src/core/params'
import { planScadImport, scadObjectName } from '../../src/core/scad-import'
import { BLANK_SCAD_CODE, createTemplateDef } from '../../src/core/templates'
import { buildSpecs } from '../../src/core/evalspec'

let seq = 0
function scadDef(name: string, code: string, files?: Record<string, string>): CodeDef {
  const d: CodeDef = { id: `d_s${++seq}`, name, kind: 'code', code, params: scadParams(code), lang: 'openscad' }
  if (files) d.files = files
  return d
}
function withDefs(...defs: CodeDef[]): Project {
  const p = emptyProject()
  for (const d of defs) {
    p.defs[d.id] = d
    const root = p.defs[p.root]
    if (root.kind === 'group') root.children.push({ id: `i_${d.id.slice(2)}`, def: d.id, xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } })
  }
  return p
}

describe('derived parameters', () => {
  test('Customizer assignments become valid ParamDefs without the Inspector-only fields', () => {
    const code = `// Width of the plate
width = 40; // [10:100]
wall = 2; // .5
round = true;
size = 20; // [10:Small, 20:Large]
label = "A";
pts = [1, 2];
/* [Hidden] */
secret = 3;
module m() {}
after = 1;
`
    const params = scadParams(code)
    expect(params).toEqual([
      { name: 'width', type: 'number', default: 40, min: 10, max: 100 },
      { name: 'wall', type: 'number', default: 2, step: 0.5 },
      { name: 'round', type: 'boolean', default: true },
      { name: 'size', type: 'choice', default: 'Large', options: ['Small', 'Large'] },
    ])
    expect(paramDefProblems(params)).toEqual([])
    expect(scadParamInfo(code).get('width')).toEqual({ line: 2, description: 'Width of the plate' })
  })

  test('never throws on broken code, and leaves out names 3Dica parameters cannot have', () => {
    expect(scadParams('w = 1;\nx = "unterminated')).toEqual([{ name: 'w', type: 'number', default: 1 }])
    expect(scadParams('default = 3;\nvar = 2;\n')).toEqual([])
    expect(scadParams(undefined as unknown as string)).toEqual([])
  })
})

describe('static part() scan of OpenSCAD code', () => {
  test('finds part("Name" outside comments and strings, with lines; follows attached files', () => {
    const code = '// part("Nope")\n/* part("Nope2") */\necho("part(\\"Str\\")");\npart("Bolt", length = 3);\ninclude <lib.scad>\n'
    const files = { 'lib.scad': 'module x() part("Nut");\n', 'unused.scad': 'part("Other");' }
    expect(scadRefs(code, files)).toEqual(['Bolt', 'Nut'])
    expect(scadRefSites(code, files)).toEqual([{ name: 'Bolt', line: 4, col: 1 }])
    expect(reachableScadFiles(code, files)).toEqual(['lib.scad'])
  })

  test('a module part defined in the code or a used file means no 3Dica references', () => {
    expect(scadRefs('module part(n) cube(1);\npart("Bolt");')).toEqual([])
    expect(scadRefs('use <u.scad>\npart("Bolt");', { 'u.scad': 'module part(name) sphere(1);' })).toEqual([])
    expect(scadRefs('function part(n) = n;\npart("Bolt");')).toEqual(['Bolt'])
  })

  test('text that does not tokenize still gives its references', () => {
    expect(scadRefs('part("Bolt");\nx = "never closed')).toEqual(['Bolt'])
  })

  test('defRefs dispatches by language; referrers sees OpenSCAD callers', () => {
    const bolt: CodeDef = { id: 'd_bolt', name: 'Bolt', kind: 'code', code: 'return cuboid()', params: [] }
    const user = scadDef('User', 'part("Bolt");')
    const p = withDefs(bolt, user)
    expect(defRefs(user)).toEqual(['Bolt'])
    expect(referrers(p, 'd_bolt')).toEqual([user.id])
    expect(() => ops.deleteDefinition(structuredClone(p), 'd_bolt')).toThrow("Can't delete 'Bolt': used by code in 'User'")
  })

  test('the dependency list and the include line of a nested file', () => {
    const code = 'include <a.scad>\nuse <missing.scad>\n'
    const files = { 'a.scad': 'use <sub/b.scad>\n', 'sub/b.scad': 'cube(1);' }
    expect(scadDepList(code, files)).toEqual([
      { name: 'a.scad', from: '', resolved: 'a.scad' },
      { name: 'sub/b.scad', from: 'a.scad', resolved: 'sub/b.scad' },
      { name: 'missing.scad', from: '', resolved: null },
    ])
    expect(scadIncludeLine(code, files, 'sub/b.scad')).toBe(1)
    expect(scadIncludeLine(code, files, 'a.scad')).toBe(1)
  })
})

describe('attached file paths', () => {
  test('normalized relative paths are kept; absolute, escaping and prototype names are refused', () => {
    expect(checkScadPath('lib/./gear.scad')).toEqual({ path: 'lib/gear.scad' })
    expect(checkScadPath('lib\\gear.scad')).toEqual({ path: 'lib/gear.scad' })
    expect(checkScadPath('a/../b.scad')).toEqual({ path: 'b.scad' })
    for (const bad of ['/etc/passwd', 'C:\\x.scad', '~/x.scad', '../x.scad', 'a/../../x.scad', '__proto__', 'lib/constructor', '', 'a\u0000b', 'x'.repeat(300), 5]) {
      expect('problem' in checkScadPath(bad), String(bad)).toBe(true)
    }
    expect(scadStorePath('lib/gear.scad', 'util.scad')).toBe('lib/util.scad')
    expect(scadStorePath('', '../up.scad')).toBe('up.scad')
    // a library naming its own folder: from the root, not MCAD/MCAD/units.scad
    expect(scadStorePath('MCAD/shapes.scad', 'MCAD/units.scad')).toBe('MCAD/units.scad')
    expect(scadStorePath('lib/MCAD/shapes.scad', 'MCAD/units.scad')).toBe('MCAD/units.scad')
    expect(scadStorePath('lib/shapes.scad', 'MCAD/units.scad')).toBe('lib/MCAD/units.scad')
  })

  test('a files map from a project file: string → string, sizes and keys checked', () => {
    expect(normalizeScadFiles({ './a.scad': 'x' })).toEqual({ files: { 'a.scad': 'x' }, problems: [] })
    expect(normalizeScadFiles(['a']).problems).toEqual(['files must be an object of file path → text'])
    expect(normalizeScadFiles({ 'a.scad': 5 }).problems[0]).toMatch(/must be text/)
    expect(normalizeScadFiles({ 'a.scad': 'x', './a.scad': 'y' }).problems[0]).toMatch(/listed twice/)
    expect(normalizeScadFiles(JSON.parse('{"__proto__": "x"}')).problems[0]).toMatch(/not an allowed file name/)
    expect(normalizeScadFiles({ 'big.scad': 'x'.repeat(MAX_SCAD_FILE_CHARS + 1) }).problems[0]).toMatch(/larger than 2 MB/)
  })
})

describe('project files', () => {
  test('round trip keeps lang and files; params are derived again on load', () => {
    const d = scadDef('Bracket', 'width = 40; // [10:100]\ninclude <lib/a.scad>\ncube(width);\n', { 'lib/a.scad': 'k = 1;' })
    const p = withDefs(d)
    const text = serialize(p)
    const raw = JSON.parse(text)
    expect(Object.keys(raw.defs[d.id])).toEqual(['id', 'name', 'kind', 'color', 'lang', 'params', 'code', 'files'].filter((k) => k !== 'color'))
    raw.defs[d.id].params = [{ name: 'stale', type: 'number', default: 1 }]
    const back = parseProject(raw)
    expect(back.ok).toBe(true)
    const def = back.ok ? back.project.defs[d.id] : null
    expect(def).toMatchObject({ lang: 'openscad', files: { 'lib/a.scad': 'k = 1;' }, params: [{ name: 'width', type: 'number', default: 40, min: 10, max: 100 }] })
    expect(isScad(def)).toBe(true)
  })

  test('bad lang or files are reported', () => {
    const d = scadDef('Bracket', 'cube(1);')
    const raw = JSON.parse(serialize(withDefs(d)))
    raw.defs[d.id].lang = 'python'
    expect(parseProject(raw)).toEqual({ ok: false, problems: [`Definition 'Bracket': lang "python" must be "openscad" (or absent for JSCAD code)`] })
    const raw2 = JSON.parse(serialize(withDefs(d)))
    raw2.defs[d.id].files = { '/abs.scad': 'x', '../up.scad': 'y', 'ok.scad': 3 }
    const r2 = parseProject(raw2)
    expect(r2.ok).toBe(false)
    expect(r2.ok ? [] : r2.problems).toHaveLength(3)
    const raw3 = JSON.parse(serialize(withDefs(d)))
    delete raw3.defs[d.id].lang
    raw3.defs[d.id].files = { 'a.scad': 'x' }
    expect(parseProject(raw3)).toEqual({ ok: false, problems: [`Definition 'Bracket': files are only for OpenSCAD code (lang "openscad")`] })
  })
})

describe('operations', () => {
  test('setCode derives the params; setParamDefs is refused with a hint', () => {
    const d = scadDef('Box', 'w = 10;\ncube(w);')
    const p = withDefs(d)
    ops.setCode(p, d.id, 'w = 10;\nh = 3; // [1:9]\ncube([w, w, h]);')
    expect((p.defs[d.id] as CodeDef).params.map((x) => x.name)).toEqual(['w', 'h'])
    expect(() => ops.setParamDefs(p, d.id, [])).toThrow(OpError)
    expect(() => ops.setParamDefs(p, d.id, [])).toThrow(/come from the top-level assignments/)
  })

  test('setScadParamDefault rewrites only the literal', () => {
    const d = scadDef('Box', 'w = 10; // [1:50]\nsize = 20; // [10:Small, 20:Large]\ncube(w);')
    const p = withDefs(d)
    ops.setScadParamDefault(p, d.id, 'w', 25)
    ops.setScadParamDefault(p, d.id, 'size', 'Small')
    const def = p.defs[d.id] as CodeDef
    expect(def.code).toBe('w = 25; // [1:50]\nsize = 10; // [10:Small, 20:Large]\ncube(w);')
    expect(def.params.map((x) => x.default)).toEqual([25, 'Small'])
    expect(() => ops.setScadParamDefault(p, d.id, 'w', 'x')).toThrow("Invalid value for 'w'")
    expect(() => ops.setScadParamDefault(p, d.id, 'nope', 1)).toThrow("'Box' has no parameter 'nope'")
  })

  test('attach, replace and remove files', () => {
    const d = scadDef('Box', 'include <g.scad>\ncube(1);')
    const p = withDefs(d)
    expect(ops.attachScadFile(p, d.id, './g.scad', 'a')).toBe('g.scad')
    ops.attachScadFile(p, d.id, 'g.scad', 'b')
    expect((p.defs[d.id] as CodeDef).files).toEqual({ 'g.scad': 'b' })
    expect(() => ops.attachScadFile(p, d.id, '../g.scad', 'x')).toThrow(/outside/)
    expect(() => ops.attachScadFile(p, d.id, 'big.scad', 'x'.repeat(MAX_SCAD_FILE_CHARS + 1))).toThrow(/larger than 2 MB/)
    ops.removeScadFile(p, d.id, 'g.scad')
    expect((p.defs[d.id] as CodeDef).files).toBeUndefined()
    expect(() => ops.removeScadFile(p, d.id, 'g.scad')).toThrow(/no attached file/)
  })

  test('addDef derives params and checks files; cloneDef copies the language and files', () => {
    const p = emptyProject()
    const d: CodeDef = { id: 'd_new', name: 'New', kind: 'code', code: 'n = 3;\ncube(n);', params: [{ name: 'junk', type: 'number', default: 1 }], lang: 'openscad', files: { './x.scad': '' } }
    ops.addDef(p, d)
    expect(p.defs.d_new).toMatchObject({ params: [{ name: 'n', type: 'number', default: 3 }], files: { 'x.scad': '' } })
    const id = ops.cloneDef(p, 'd_new')
    expect(p.defs[id]).toMatchObject({ lang: 'openscad', files: { 'x.scad': '' }, name: 'New 2' })
    const bad: CodeDef = { id: 'd_bad', name: 'Bad', kind: 'code', code: '', params: [], files: { 'a.scad': '' } }
    expect(() => ops.addDef(p, bad)).toThrow('Only OpenSCAD objects have attached files')
  })

  test('renameDef rewrites part("Old" in OpenSCAD code and files, not where part is the code\'s own module', () => {
    const bolt: CodeDef = { id: 'd_bolt', name: 'Bolt', kind: 'code', code: 'return cuboid()', params: [] }
    const a = scadDef('A', 'include <l.scad>\npart("Bolt");', { 'l.scad': 'module q() part("Bolt");' })
    const own = scadDef('Own', 'module part(n) cube(1);\npart("Bolt");')
    const p = withDefs(bolt, a, own)
    const changed = ops.renameDef(p, 'd_bolt', 'Screw')
    expect(changed).toEqual([a.id])
    expect((p.defs[a.id] as CodeDef).code).toBe('include <l.scad>\npart("Screw");')
    expect((p.defs[a.id] as CodeDef).files).toEqual({ 'l.scad': 'module q() part("Screw");' })
    expect((p.defs[own.id] as CodeDef).code).toBe('module part(n) cube(1);\npart("Bolt");')
  })

  test('renameDef also rewrites part ("Old" with a space, which the OpenSCAD scan finds too', () => {
    const bolt: CodeDef = { id: 'd_bolt', name: 'Bolt', kind: 'code', code: 'return cuboid()', params: [] }
    const a = scadDef('A', 'part ("Bolt", length = 2);\npart( "Bolt");', { 'l.scad': 'module q() part  ( "Bolt");' })
    const p = withDefs(bolt, a)
    expect(scadRefs(a.code, a.files)).toEqual(['Bolt'])
    ops.renameDef(p, 'd_bolt', 'Screw')
    expect((p.defs[a.id] as CodeDef).code).toBe('part ("Screw", length = 2);\npart("Screw");')
    expect((p.defs[a.id] as CodeDef).files).toEqual({ 'l.scad': 'module q() part  ("Screw");' })
  })

  test('purgeUnused keeps a def only an OpenSCAD object calls', () => {
    const bolt: CodeDef = { id: 'd_bolt', name: 'Bolt', kind: 'code', code: 'return cuboid()', params: [] }
    const user = scadDef('User', 'part("Bolt");')
    const p = withDefs(user)
    p.defs.d_bolt = bolt
    expect(ops.purgeUnused(p)).toBe(0)
  })
})

describe('specs', () => {
  test('a JSCAD def calling an OpenSCAD one depends on it; cycles through OpenSCAD code are found', () => {
    const s = scadDef('S', 'part("J");')
    const j: CodeDef = { id: 'd_j', name: 'J', kind: 'code', code: "return part('S')", params: [] }
    const specs = buildSpecs(withDefs(s, j))
    expect(specs.specErrors.get(s.id)).toMatchObject({ kind: 'cycle', line: 1 })
  })
})

describe('import planner', () => {
  test('included files are attached to the object that needs them; the rest become objects', () => {
    const plan = planScadImport([
      { name: 'main.scad', text: 'include <lib/gear.scad>\nuse <missing.scad>\ngear();' },
      { name: 'gear.scad', text: 'use <util.scad>\nmodule gear() cube(1);' },
      { name: 'util.scad', text: 'function u() = 1;' },
      { name: 'other.scad', text: 'sphere(1);' },
    ])
    expect(plan).toEqual([
      { file: 'main.scad', code: 'include <lib/gear.scad>\nuse <missing.scad>\ngear();', files: { 'lib/gear.scad': 'use <util.scad>\nmodule gear() cube(1);', 'lib/util.scad': 'function u() = 1;' }, missing: ['missing.scad'] },
      { file: 'other.scad', code: 'sphere(1);', files: {}, missing: [] },
    ])
  })

  test('files that include each other: the first one becomes the object', () => {
    const plan = planScadImport([{ name: 'a.scad', text: 'include <b.scad>' }, { name: 'b.scad', text: 'include <a.scad>' }])
    expect(plan.map((o) => [o.file, Object.keys(o.files)])).toEqual([['a.scad', ['b.scad']]])
  })

  test('object names from file names', () => {
    expect(scadObjectName('bracket.scad')).toBe('bracket')
    expect(scadObjectName('my "best" part.SCAD')).toBe('my best part')
    expect(scadObjectName('Scene.scad')).toBe('Object')
    expect(scadObjectName('.scad')).toBe('Object')
  })
})

describe('template', () => {
  test('the blank OpenSCAD template is an OpenSCAD def with a size parameter', () => {
    const d = createTemplateDef('openscad', emptyProject(), 0)
    expect(d).toMatchObject({ kind: 'code', lang: 'openscad', code: BLANK_SCAD_CODE, name: 'Object' })
    expect(d.kind === 'code' && d.params).toEqual([{ name: 'size', type: 'number', default: 10, min: 1, max: 100 }])
    expect(d.kind === 'code' && scadRefs(d.code)).toEqual([])
  })
})

describe('store snapshots', () => {
  test('an unrelated edit shares the unchanged code and files with the previous snapshot (history memory)', async () => {
    const { Store } = await import('../../src/state/store')
    const d = scadDef('Lib', 'include <big.scad>\ncube(1);', { 'big.scad': 'x'.repeat(100_000) })
    const store = new Store(withDefs(d))
    const before = store.project
    store.update('Move', (p) => { const r = p.defs[p.root]; if (r.kind === 'group') r.children[0].xf.t[0] = 5 })
    const a = before.defs[d.id] as CodeDef, b = store.project.defs[d.id] as CodeDef
    expect(b.files).toBe(a.files)
    store.update('Attach', (p) => { ops.attachScadFile(p, d.id, 'big.scad', 'y') })
    expect((store.project.defs[d.id] as CodeDef).files).toEqual({ 'big.scad': 'y' })
    expect(a.files).toEqual({ 'big.scad': 'x'.repeat(100_000) })
    store.undo()
    expect((store.project.defs[d.id] as CodeDef).files).toBe(a.files)
  })
})
