// The OpenSCAD language beyond the recorded differential cases: tokens, syntax errors and positions, the CSG nodes
// handed to build, 3Dica's additions (parameter overrides, part()), limits, error details and safety.
import { describe, expect, test } from 'vitest'
import { missingScadFiles, scadDependencies, scadIncludes } from '../../src/openscad/deps'
import { exprToString, formatNumber } from '../../src/openscad/format'
import { DEFAULT_LIMITS, interpret } from '../../src/openscad/interp'
import { tokenize } from '../../src/openscad/lexer'
import { MAX_NESTING, parse } from '../../src/openscad/parser'
import { normalizePath, resolveFile } from '../../src/openscad/paths'
import { ScadError, type GeomNode, type InterpretOptions } from '../../src/openscad/types'

const run = (src: string, opts?: InterpretOptions) => interpret(src, opts)
const echoes = (src: string, opts?: InterpretOptions) => run(src, opts).messages.filter((m) => m.level === 'echo').map((m) => m.text)
const fail = (src: string, opts?: InterpretOptions): ScadError => {
  try {
    run(src, opts)
  } catch (e) {
    if (e instanceof ScadError) return e
    throw e
  }
  throw new Error('no error')
}
const only = (src: string): GeomNode => {
  const { nodes } = run(src)
  expect(nodes).toHaveLength(1)
  return nodes[0]
}

describe('tokens', () => {
  test('numbers and identifiers: the longer reading wins, a tie is a number', () => {
    const t = tokenize('2D 1e5 1e5x .5 5. 1.e2 $fn _a1 x.y')
    expect(t.map((k) => `${k.type}:${k.text}`)).toEqual(['id:2D', 'num:1e5', 'id:1e5x', 'num:.5', 'num:5.', 'num:1.e2', 'id:$fn', 'id:_a1', 'id:x', 'op:.', 'id:y', 'eof:'])
    expect(t[3].num).toBe(0.5)
  })
  test('string escapes', () => {
    const [s] = tokenize(String.raw`"a\tb\n\"\\\x41☺\U01F600\q\x80"`)
    expect(s.text).toBe('a\tb\n"\\A☺😀qx80')
  })
  test('use and include paths may contain spaces and slashes', () => {
    const t = tokenize('use <my lib/gear.scad>\ninclude\t<a.scad>\nuse = 1;')
    expect(t.slice(0, 2).map((k) => [k.type, k.text, k.line])).toEqual([['use', 'my lib/gear.scad', 1], ['include', 'a.scad', 2]])
    expect(t[2]).toMatchObject({ type: 'id', text: 'use', line: 3 })
  })
  test('positions are 1-based line and column; comments only on request', () => {
    const src = '// c\n  x = 1; /* b */'
    expect(tokenize(src)[0]).toMatchObject({ text: 'x', line: 2, col: 3 })
    expect(tokenize(src, { comments: true }).filter((k) => k.type === 'comment').map((k) => [k.text, k.block ?? false])).toEqual([[' c', false], [' b ', true]])
  })
  test('lexical errors are syntax ScadErrors at the right place', () => {
    for (const [src, msg, line, col] of [['x = "abc', 'unterminated string', 1, 5], ['a;\n/* x', 'unterminated comment', 2, 1], ['x = 1 @ 2;', "invalid character '@'", 1, 7], ['x = 1e400;', 'number out of range: 1e400', 1, 5]] as const) {
      const e = fail(src)
      expect(e.kind).toBe('syntax')
      expect(e.message).toBe(`Parser error: ${msg}`)
      expect(e.pos).toEqual({ file: '', line, col })
    }
  })
})

describe('syntax', () => {
  test('precedence and associativity, shown the way OpenSCAD prints expressions', () => {
    const expr = (src: string) => {
      const s = parse(`x = ${src};`).body[0]
      return s.t === 'assign' ? exprToString(s.expr) : ''
    }
    expect(expr('1 + 2 * 3 - 4 / 2 % 3')).toBe('((1 + (2 * 3)) - ((4 / 2) % 3))')
    expect(expr('-2^2 + 2^3^2')).toBe('(-(2 ^ 2) + (2 ^ (3 ^ 2)))')
    expect(expr('a || b && c == d < e')).toBe('(a || (b && (c == (d < e))))')
    expect(expr('a ? b : c ? d : e')).toBe('(a ? b : (c ? d : e))')
    expect(expr('!a[0].x')).toBe('!a[0].x')
    expect(expr('f(1)(2)[3]')).toBe('(f(1))(2)[3]')
    expect(expr('let(a = 1) a + 1')).toBe('let(a = 1) (a + 1)')
    expect(expr('+x')).toBe('x')
  })
  test('syntax errors give the place of the problem', () => {
    const cases: [string, string, number, number][] = [
      ['echo(1', "syntax error, expected ')', found end of file", 1, 7],
      ['a = 1;\nb = ;', "syntax error, unexpected ';'", 2, 5],
      ['echo(1,);', "syntax error, unexpected ')'", 1, 8],
      ['module m() {\n  cube();\n', "syntax error, missing '}'", 3, 1],
      ['if (true) x = 1;', "syntax error, expected '(' after 'x', found '='", 1, 13],
      ['module m() { use <x.scad> }', '`use` is only allowed at the top level of a file', 1, 14],
      ['echo = 1;', "syntax error, expected '(' after 'echo', found '='", 1, 6],
      ['x = [(for (i = [0:1]) i)];', "syntax error, unexpected 'for'", 1, 7],
    ]
    for (const [src, msg, line, col] of cases) {
      const e = fail(src)
      expect([e.kind, e.message, e.pos?.line, e.pos?.col], src).toEqual(['syntax', `Parser error: ${msg}`, line, col])
    }
  })
  test('deeply nested input is refused with a clear error, not a JS stack overflow', () => {
    for (const src of [`x = ${'('.repeat(5000)}1${')'.repeat(5000)};`, `x = ${'['.repeat(5000)}${']'.repeat(5000)};`, `${'{'.repeat(5000)}${'}'.repeat(5000)}`, `${'translate([1, 0, 0]) '.repeat(5000)}cube();`, `x = ${'-'.repeat(5000)}1;`]) {
      const e = fail(src)
      expect(e.kind).toBe('syntax')
      expect(e.message).toBe(`Parser error: the code is nested too deeply (more than ${MAX_NESTING} levels)`)
    }
    expect(echoes(`echo(${'('.repeat(200)}1${')'.repeat(200)});`)).toEqual(['1'])
  })
  test('CRLF line ends count once and a byte-order mark is skipped (OpenSCAD 2021.01 does neither)', () => {
    expect(run('a = 1;\r\nb = nope;\r\n').messages[0].pos).toEqual({ file: '', line: 2, col: 5 })
    expect(echoes('\ufeffx = 1;\necho(x);')).toEqual(['1'])
  })
  test('statement forms', () => {
    const body = parse('use <a.scad>\ninclude <b.scad>\nmodule m(a, b = 2,) cube();\nfunction f(x) = x;\n#%cube();\nif (a) b(); else c();\n{ x = 1; }').body
    expect(body.map((s) => s.t)).toEqual(['use', 'include', 'module', 'function', 'inst', 'if', 'block'])
    expect(body[4]).toMatchObject({ t: 'inst', name: 'cube', mods: '#%' })
    expect(body[2]).toMatchObject({ t: 'module', name: 'm', params: [{ name: 'a' }, { name: 'b' }], pos: { line: 3, col: 8 } })
  })
})

describe('the CSG tree', () => {
  test('one node per top-level object; echo and assert make none; % and * are left out', () => {
    const { nodes } = run('cube(1);\necho("x");\nsphere(1);\n%cube(2);\n*cube(3);\nassert(true);\nmodule m() {}\nm();')
    expect(nodes.map((n) => n.kind)).toEqual(['cube', 'sphere', 'group'])
    expect(nodes[0].pos).toEqual({ file: '', line: 1, col: 1 })
  })
  test('! makes its subtree the only result', () => {
    const { nodes } = run('cube(1);\ndifference() { cube(10); !translate([1, 0, 0]) sphere(3); }\ncylinder(2);')
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ kind: 'multmatrix', children: [{ kind: 'sphere', r: 3 }] })
  })
  test('primitives carry evaluated, defaulted arguments', () => {
    expect(only('cube(2, center = true);')).toMatchObject({ kind: 'cube', size: [2, 2, 2], center: true })
    expect(only('sphere(d = 4, $fn = 8);')).toMatchObject({ kind: 'sphere', r: 2, frag: { fn: 8, fa: 12, fs: 2 } })
    expect(only('$fa = 6; $fs = 0.5;\ncylinder(h = 3, d1 = 4, r2 = 1);')).toMatchObject({ kind: 'cylinder', h: 3, r1: 2, r2: 1, center: false, frag: { fn: 0, fa: 6, fs: 0.5 } })
    expect(only('polygon([[0, 0], [1, 0], [0, 1]]);')).toEqual({ kind: 'polygon', points: [[0, 0], [1, 0], [0, 1]], pos: { file: '', line: 1, col: 1 } })
    expect(only('polyhedron([[0,0,0],[1,0,0],[0,1,0],[0,0,1]], [[0,1,2],[0,3,1],[0,2,3],[1,3,2]]);')).toMatchObject({ kind: 'polyhedron', faces: [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]] })
    expect(only('text("Hi", 5);')).toMatchObject({ kind: 'text', text: 'Hi', size: 5, font: '', halign: 'left', valign: 'baseline', spacing: 1, direction: 'ltr' })
    expect(only('linear_extrude(10, twist = 90, scale = 2) square(1);')).toMatchObject({ kind: 'linear_extrude', height: 10, twist: 90, slices: undefined, scale: [2, 2], center: false })
    expect(only('rotate_extrude(angle = 90) translate([2, 0]) circle(1);')).toMatchObject({ kind: 'rotate_extrude', angle: 90 })
    expect(only('offset(delta = 1, chamfer = true) square(1);')).toMatchObject({ kind: 'offset', delta: 1, chamfer: true })
    expect(only('resize([10, 0, 0], auto = true) cube();')).toMatchObject({ kind: 'resize', size: [10, 0, 0], auto: [true, true, true] })
    expect(only('projection(cut = true) cube();')).toMatchObject({ kind: 'projection', cut: true })
  })
  test('a primitive that makes no geometry in OpenSCAD is an empty group', () => {
    for (const src of ['cube(-1);', 'cube([1, 0, 1]);', 'sphere(0);', 'cylinder(h = 0, r = 1);', 'cylinder(r1 = 0, r2 = 0);', 'square(-2);', 'circle(0);', 'linear_extrude(0) square();']) {
      expect(only(src), src).toMatchObject({ kind: 'group', children: [] })
    }
    expect(only('cylinder(h = 1, r1 = 0, r2 = 1);')).toMatchObject({ kind: 'cylinder', r1: 0, r2: 1 })
  })
  test('transforms are one column-major matrix', () => {
    const t = only('translate([1, 2, 3]) cube();')
    expect(t.kind === 'multmatrix' && t.m).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1])
    const r = only('rotate(90) cube();')
    expect(r.kind === 'multmatrix' && r.m).toEqual([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const m = only('multmatrix([[1, 0, 0, 5], [0, 2, 0, 0], [0, 0, 1, 0]]) cube();')
    expect(m.kind === 'multmatrix' && m.m).toEqual([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1])
  })
  test('colors: names, hex, vectors, alpha; an unusable color is a plain group', () => {
    expect(only('color("Red", 0.5) cube();')).toMatchObject({ kind: 'color', rgba: [1, 0, 0, 0.5] })
    expect(only('color("#00ff0080") cube();')).toMatchObject({ kind: 'color', rgba: [0, 1, 0, 128 / 255] })
    expect(only('color([0.1, 0.2, 0.3]) cube();')).toMatchObject({ kind: 'color', rgba: [0.1, 0.2, 0.3, 1] })
    expect(only('color("rebeccapurple") cube();')).toMatchObject({ kind: 'color', rgba: [0.4, 0.2, 0.6, 1] })
    expect(only('color("no such color") cube();')).toMatchObject({ kind: 'group', children: [{ kind: 'cube' }] })
  })
  test('intersection_for makes an intersection of the iterations', () => {
    expect(only('intersection_for (i = [1:3]) cube(i);')).toMatchObject({ kind: 'intersection', children: [{ kind: 'cube' }, { kind: 'cube' }, { kind: 'cube' }] })
  })
})

describe('parameters (overrides)', () => {
  const src = 'w = 10; // [1:100]\nholes = 2; // [0, 1, 2, 3]\nsize = 20; // [10:Small, 20:Medium, 30:Large]\nshape = "S"; // [S:Small, M:Medium]\nlid = true;\necho(w, holes, size, shape, lid);'
  test('replace the value of the top-level assignment, mapped through the Customizer options', () => {
    expect(echoes(src, { overrides: { w: 25, holes: '3', size: 'Large', shape: 'Medium', lid: false } })).toEqual(['25, 3, 30, "M", false'])
  })
  test('take effect where the variable is first assigned, as OpenSCAD -D does', () => {
    expect(echoes('echo(a);\na = 1;\nb = a * 2;\necho(b);\na = 3;', { overrides: { a: 5 } })).toEqual(['5', '10'])
  })
  test('only change the main file\'s top level; unknown names are ignored', () => {
    const files = { 'lib.scad': 'k = 1;\necho("lib", k);\n' }
    expect(echoes('include <lib.scad>\nmodule m() { w = 1; echo(w); }\nw = 2;\nm();\necho(w);', { files, overrides: { k: 9, w: 7, nope: 1 } })).toEqual(['"lib", 1', '1', '7'])
  })
})

describe('part()', () => {
  test('is a part node with the named arguments as overrides', () => {
    expect(only('part("Leg", width = 20, round = true, finish = "matte", $fn = 8);')).toEqual({ kind: 'part', name: 'Leg', overrides: { width: 20, round: true, finish: 'matte' }, pos: { file: '', line: 1, col: 1 } })
    expect(only('part(name = "Leg");')).toMatchObject({ kind: 'part', name: 'Leg', overrides: {} })
  })
  test('refuses values that are not a number, boolean or string, and needs a name', () => {
    expect(fail('part("Leg", size = [1, 2]);').message).toBe("part(): parameter 'size' must be a number, true/false or a string, not [1, 2]")
    expect(fail('part(5);').message).toBe('part() needs the name of a 3Dica object as its first argument, e.g. part("Bracket")')
  })
  test('a module named part in the program wins', () => {
    expect(only('module part(n) cube(n);\npart(2);')).toMatchObject({ kind: 'group', children: [{ kind: 'cube', size: [2, 2, 2] }] })
  })
  test('override names that are special to JavaScript are ordinary keys', () => {
    const n = only('part("Leg", __proto__ = 1, constructor = 2);')
    expect(n.kind === 'part' && Object.keys(n.overrides)).toEqual(['__proto__', 'constructor'])
    expect(Object.getPrototypeOf(n.kind === 'part' ? n.overrides : null)).toBe(Object.prototype)
  })
})

describe('files', () => {
  test('missing files are errors that name the file, at the statement', () => {
    const inc = fail('x = 1;\ninclude <gear.scad>')
    expect([inc.kind, inc.message, inc.pos]).toEqual(['runtime', "Can't open include file 'gear.scad'", { file: '', line: 2, col: 1 }])
    expect(fail('use <lib/gears.scad>').message).toBe("Can't open library 'lib/gears.scad'")
    expect(fail('include <a.scad>', { files: { 'a.scad': 'include <b.scad>\n' } }).pos).toEqual({ file: 'a.scad', line: 1, col: 1 })
  })
  test('found next to the naming file, from the root, or by a unique file name', () => {
    const files = { 'lib/a.scad': 'include <b.scad>\n', 'lib/b.scad': 'b = "next to a";\n', 'c.scad': 'c = "root";\n', 'deep/dir/d.scad': 'd = "by name";\n' }
    expect(echoes('include <lib/a.scad>\ninclude <c.scad>\ninclude <MCAD/d.scad>\necho(b, c, d);', { files })).toEqual(['"next to a", "root", "by name"'])
  })
  test('a file including itself is not read again: OpenSCAD 2021.01 warns and goes on', () => {
    // binary: WARNING: Can't open include file 'a.scad'. / ECHO: "a" / ECHO: "b"
    const r = run('include <a.scad>\ncube(1);', { files: { 'a.scad': 'echo("a");\ninclude <a.scad>\necho("b");\n' } })
    expect(r.messages.map((m) => m.text)).toEqual(["Can't open include file 'a.scad'.", '"a"', '"b"'])
    expect(r.messages[0].pos).toBeUndefined()
    // round a loop as well
    const loop = run('include <a.scad>', { files: { 'a.scad': 'include <b.scad>\nx = 1;', 'b.scad': 'include <a.scad>\necho(x);' } })
    expect(loop.messages.map((m) => m.text)).toEqual(["Can't open include file 'a.scad'.", '1'])
  })
  test('a chain of more than 32 different files, each including the next, is stopped', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 40; i++) files[`f${i}.scad`] = `include <f${i + 1}.scad>\n`
    files['f40.scad'] = 'cube(1);\n'
    expect(fail('include <f0.scad>', { files }).message).toBe('include <f32.scad> nests too deeply (more than 32 files, each including the next)')
  })
  test('includes that fan out exponentially are stopped before they expand (not at the worker timeout)', () => {
    // f0 includes f1 twice, f1 includes f2 twice, …: 2^31 copies of the last file
    const files: Record<string, string> = {}
    for (let i = 0; i < 31; i++) files[`f${i}.scad`] = `include <f${i + 1}.scad>\ninclude <f${i + 1}.scad>\n`
    files['f31.scad'] = 'if (false) cube(1);\n'
    const t0 = Date.now()
    const e = fail('include <f0.scad>', { files })
    expect(e.kind).toBe('limit')
    expect(e.message).toBe('The code expands to too much: more than 2,000,000 statements after its include <…> files are read in (a file included again and again?)')
    // about a second (before: minutes, until the worker's 20 s timeout)
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 30_000)
  test('positions inside an attached file name it', () => {
    const { messages } = run('use <lib.scad>\nm();', { files: { 'lib.scad': 'module m() echo(nope);\n' } })
    expect(messages[0]).toEqual({ level: 'warning', text: "Ignoring unknown variable 'nope'", pos: { file: 'lib.scad', line: 1, col: 17 } })
  })
  test('paths', () => {
    expect(['a/./b/../c.scad', './x.scad', 'a\\b.scad', '../up.scad'].map(normalizePath)).toEqual(['a/c.scad', 'x.scad', 'a/b.scad', null])
    const files = new Map([['lib/gear.scad', ''], ['gear.scad', ''], ['util/only.scad', '']])
    expect(resolveFile(files, 'lib/x.scad', 'gear.scad')).toBe('lib/gear.scad')
    expect(resolveFile(files, '', 'gear.scad')).toBe('gear.scad')
    expect(resolveFile(files, '', 'MCAD/only.scad')).toBe('util/only.scad')
    expect(resolveFile(files, '', 'nope.scad')).toBeNull()
  })
  test('dependencies, followed through attached files, with the missing ones', () => {
    const src = '// use <not/this.scad>\nuse <a.scad>\ninclude <MCAD/units.scad>\nx = "use <nor/this.scad>";'
    expect(scadIncludes(src)).toEqual([{ kind: 'use', name: 'a.scad', line: 2 }, { kind: 'include', name: 'MCAD/units.scad', line: 3 }])
    const files = { 'a.scad': 'include <lib/b.scad>\nuse <a.scad>\n', 'lib/b.scad': 'use <c.scad>\n' }
    expect(scadDependencies(src, files).map((d) => [d.kind, d.name, d.from, d.resolved])).toEqual([
      ['use', 'a.scad', '', 'a.scad'], ['include', 'lib/b.scad', 'a.scad', 'lib/b.scad'], ['use', 'c.scad', 'lib/b.scad', null], ['include', 'MCAD/units.scad', '', null],
    ])
    expect(missingScadFiles(src, files)).toEqual(['c.scad', 'MCAD/units.scad'])
    expect(scadIncludes('x = "unterminated')).toEqual([])
  })
})

describe('errors', () => {
  test('carry the call trace from the outside in, and the console output before them', () => {
    const e = fail('echo("start");\nmodule a() b();\nmodule b() assert(false, "deep");\na();')
    expect([e.kind, e.message, e.pos]).toEqual(['runtime', 'Assertion \'false\' failed: "deep"', { file: '', line: 3, col: 12 }])
    expect(e.trace).toEqual(['a() at line 4', 'b() at line 2'])
    expect(e.messages?.map((m) => m.text)).toEqual(['"start"'])
  })
  test('import(), surface() and DXF files are not supported', () => {
    expect(fail('import("part.stl");').message).toBe('import() is not supported in 3Dica: OpenSCAD objects cannot read STL, OFF, DXF or SVG files')
    expect(fail('surface("map.dat");').message).toBe('surface() is not supported in 3Dica: OpenSCAD objects cannot read height-map files')
    expect(fail('linear_extrude(file = "a.dxf");').message).toBe('linear_extrude(file = …) is not supported in 3Dica: OpenSCAD objects cannot read DXF files')
    expect(fail('x = dxf_dim(file = "a.dxf");').kind).toBe('runtime')
  })
  test('an invalid polygon point stops with the point named', () => {
    expect(fail('polygon([[0, 0], [1, 0, 5], [0, 1]]);').message).toBe('Unable to convert points[1] = [1, 0, 5] to a vec2 of numbers')
  })
  test('out-of-range path and face indices are dropped with OpenSCAD\'s warning', () => {
    const { nodes, messages } = run('polygon([[0, 0], [1, 0], [0, 1]], [[0, 1, 2, 7]]);\npolyhedron([[0,0,0],[1,0,0],[0,1,0]], [[0, 1, -1, 2]]);')
    expect(nodes.map((n) => (n.kind === 'polygon' ? n.paths : n.kind === 'polyhedron' ? n.faces : null))).toEqual([[[0, 1, 2]], [[0, 1, 2]]])
    expect(messages.map((m) => m.text)).toEqual(['Point index 7 is out of bounds (from paths[0][3])', 'Point index 18446744073709551615 is out of bounds (from faces[0][2])'])
  })
})

describe('limits', () => {
  test('defaults', () => {
    expect(DEFAULT_LIMITS).toEqual({ maxCallDepth: 5000, maxListLength: 1_000_000, maxTotalElements: 20_000_000, maxStringLength: 1_000_000, maxSteps: 10_000_000 })
  })
  test('deep recursion is an error, not a crash; tail recursion is a loop', () => {
    const e = fail('function f(n) = n <= 0 ? 0 : 1 + f(n - 1);\necho(f(1e6));')
    expect(e.kind).toBe('runtime')
    // it may well end (OpenSCAD would finish this one): the text says how deep it got and what to do instead
    expect(e.message).toMatch(/^Recursion too deep calling function 'f' \([\d,]+ nested calls, as deep as this page can go; OpenSCAD allows about 9,000\) — if it ends, rewrite it with tail recursion or a list comprehension$/)
    expect(fail('function f(n) = n <= 0 ? 0 : 1 + f(n - 1);\necho(f(100));', { limits: { maxCallDepth: 50 } }).message)
      .toBe("Recursion too deep calling function 'f' (51 nested calls, as deep as this page can go; OpenSCAD allows about 9,000) — if it ends, rewrite it with tail recursion or a list comprehension")
    expect(fail('module r(n) { if (n > 0) r(n - 1); }\nr(100);', { limits: { maxCallDepth: 50 } }).message)
      .toBe("Recursion too deep calling module 'r' (51 nested calls, as deep as this page can go; OpenSCAD allows about 3,500) — if it ends, nest fewer levels (a for loop instead of recursion)")
    expect(echoes('function g(n, acc = 0) = n <= 0 ? acc : g(n - 1, acc + 1);\necho(g(300000));')).toEqual(['300000'])
    expect(echoes('function f(n) = n <= 0 ? 0 : 1 + f(n - 1);\necho(f(600));')).toEqual(['600'])
  })
  test('lists, strings and the total amount of data', () => {
    const limit = (src: string, opts?: InterpretOptions) => { const e = fail(src, opts); expect(e.kind, src).toBe('limit'); return e.message }
    expect(limit('x = [for (i = [0:99]) i];', { limits: { maxListLength: 50 } })).toBe('List too long (more than 50 elements)')
    expect(limit('function d(s, n) = n == 0 ? s : d(concat(s, s), n - 1);\nx = d([1], 30);')).toBe('List too long (more than 1,000,000 elements)')
    expect(limit('x = rands(0, 1, 1e9);')).toBe('List too long (more than 1,000,000 elements)')
    expect(limit('x = [for (i = 0; true; i = i + 1) i];')).toBe('List too long (more than 1,000,000 elements)')
    expect(limit('function d(s, n) = n == 0 ? s : d(str(s, s), n - 1);\nx = d("x", 30);')).toBe('String too long (more than 1,000,000 characters)')
    expect(limit('x = [for (i = [0:99]) [for (j = [0:99]) j]];', { limits: { maxTotalElements: 5000 } })).toBe('The model creates too much data (more than 5,000 list elements and characters)')
    expect(limit('for (i = [0:999]) cube();', { limits: { maxTotalElements: 4000 } })).toBe('Too much geometry: this code made 251 shapes and transforms — stopped before the page runs out of memory')
    expect(limit('function nest(n, acc = []) = n == 0 ? acc : nest(n - 1, [acc]);\necho(nest(200000));')).toBe('Values or expressions nested too deeply (thousands of levels: lists inside lists, or a very long chain of operators)')
  })
  test('a for loop over a million values or more is skipped with OpenSCAD\'s warning', () => {
    const { messages } = run('for (i = [0:1e9]) cube();\necho(len([for (i = [0:1e6]) i]));')
    expect(messages.map((m) => m.text)).toEqual(['Bad range parameter in for statement: too many elements (1000000001)', 'Bad range parameter in for statement: too many elements (1000001)', '0'])
  })
  test('a huge echo is shortened instead of failing', () => {
    const [text] = echoes('echo([for (i = [0:999]) i]);', { limits: { maxStringLength: 50 } })
    expect(text).toBe('[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, … (cut: too long to show)')
  })
})

describe('options', () => {
  test('$preview follows the option (true by default)', () => {
    expect(echoes('echo($preview);')).toEqual(['true'])
    expect(echoes('echo($preview);', { preview: false })).toEqual(['false'])
  })
  test('unseeded rands() follows randomSeed, so a re-run is identical; a seed argument matches OpenSCAD', () => {
    const r = (seed?: number) => echoes('echo(rands(0, 1, 3));', { randomSeed: seed })[0]
    expect(r(7)).toBe(r(7))
    expect(r(7)).not.toBe(r(8))
    expect(echoes('echo(rands(0, 1, 4, 42));')).toEqual(['[0.796543, 0.183435, 0.779691, 0.59685]'])
  })
})

describe('safety', () => {
  test('names that mean something to JavaScript are ordinary OpenSCAD names', () => {
    const src = '__proto__ = 1; constructor = 2; toString = 3; hasOwnProperty = 4; prototype = 5;\n' +
      'function valueOf(x) = x + 1;\nmodule __defineGetter__(a) echo("module", a);\n__defineGetter__(constructor);\n' +
      'echo(__proto__, constructor, toString, hasOwnProperty, prototype, valueOf(1), let(__proto__ = 9) __proto__);\necho(toString(1));'
    expect(run(src).messages.map((m) => m.text)).toEqual(['"module", 2', '1, 2, 3, 4, 5, 2, 9', "Ignoring unknown function 'toString'", 'undef'])
    expect(echoes('echo(x);', { files: { __proto__: 'x = 1;' } as Record<string, string>, overrides: JSON.parse('{"__proto__": 1}') })).toEqual(['undef'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
  test('no source text is turned into code', () => {
    // a string that would be code in JavaScript stays a string
    expect(echoes('echo(str("1 + 1"), len("process.exit(1)"));')).toEqual(['"1 + 1", 15'])
  })
})

test('number formatting', () => {
  expect([1 / 3, 1e6, 1e-5, 1e-6, -0, 123456, 1234567, 0.1 + 0.2, NaN, -Infinity, 99999.95, 1.5e-7].map(formatNumber))
    .toEqual(['0.333333', '1e+6', '0.00001', '1e-6', '0', '123456', '1.23457e+6', '0.3', 'nan', '-inf', '99999.9', '1.5e-7'])
})
