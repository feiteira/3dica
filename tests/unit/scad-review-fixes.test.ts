// OpenSCAD semantics fixed after review, each against OpenSCAD 2021.01. Our own snippets; the expected numbers and
// console text were recorded from the binary (`openscad -o out.stl` for geometry, the console for ECHO / WARNING).
import { describe, expect, test } from 'vitest'
import jscad from '@jscad/modeling'
import type { Geom3 } from '@jscad/modeling/src/geometries/types'
import { interpret, runScad } from '../../src/openscad/index'
import { ScadError } from '../../src/openscad/types'

const ctx = { resolvePart: () => [], charge: () => {} }
const run = (src: string) => runScad(src, ctx)
const echoes = (src: string) => interpret(src).messages.filter((m) => m.level === 'echo').map((m) => m.text)
const texts = (src: string) => run(src).messages.map((m) => m.text)

function measure(geoms: Geom3[]) {
  const gs = geoms.filter((g) => jscad.geometries.geom3.toPolygons(g).length > 0)
  if (!gs.length) return { volume: 0, min: [0, 0, 0], max: [0, 0, 0] }
  const g = gs.length === 1 ? gs[0] : jscad.booleans.union(gs.map((x) => jscad.colors.colorize([1, 1, 1, 1], x) as Geom3))
  const [min, max] = jscad.measurements.measureBoundingBox(g) as number[][]
  return { volume: jscad.measurements.measureVolume(g), min, max }
}

/** |Σ area vectors| of the worst mesh: 0 for a closed surface (a stray face makes it the face's area) */
function openness(geoms: Geom3[]): number {
  let worst = 0
  for (const g of geoms) {
    const s = [0, 0, 0]
    for (const p of jscad.geometries.geom3.toPolygons(g)) {
      const v = p.vertices
      for (let k = 1; k + 1 < v.length; k++) {
        const u = [v[k][0] - v[0][0], v[k][1] - v[0][1], v[k][2] - v[0][2]]
        const w = [v[k + 1][0] - v[0][0], v[k + 1][1] - v[0][1], v[k + 1][2] - v[0][2]]
        s[0] += (u[1] * w[2] - u[2] * w[1]) / 2; s[1] += (u[2] * w[0] - u[0] * w[2]) / 2; s[2] += (u[0] * w[1] - u[1] * w[0]) / 2
      }
    }
    worst = Math.max(worst, Math.hypot(s[0], s[1], s[2]))
  }
  return worst
}

/** a 1 mm³ marker cube away from the rest, so an empty result measures 1 */
const MARK = 'translate([20, 0, 0]) cube(1);\n'
const EMPTY_INTERSECTION = 'intersection() { cube(1); translate([5, 5, 5]) cube(1); }'

describe('an empty operand empties difference (first child) and intersection (any child)', () => {
  test.each([
    ['an empty intersection, moved, inside an intersection', `intersection() { cube(10); translate([1, 0, 0]) ${EMPTY_INTERSECTION} }`],
    ['an empty module as the first child of difference', 'module e() {} difference() { e(); cube(3); }'],
    ['children() without children inside intersection', 'module m() intersection() { cube(3); children(); } m();'],
    ['a moved empty result as the first child of difference', `difference() { translate([1, 0, 0]) ${EMPTY_INTERSECTION} cube(3); }`],
    ['union() {} first', 'difference() { union() {} cube(3); }'],
    ['cube(0) first', 'difference() { cube(0); cube(3); }'],
    ['for over nothing inside intersection', 'intersection() { cube(3); for (i = []) cube(1); }'],
    ['an empty else branch', 'difference() { if (false) cube(1); else {} cube(3); }'],
    ['2D: an empty first child', 'linear_extrude(1) difference() { union() {} square(3); }'],
  ])('%s', (_name, src) => {
    expect(measure(run(MARK + src).geoms).volume).toBeCloseTo(1, 6)
  })
  test('statements that make no node are not children (echo, %, if without a branch)', () => {
    // binary: 28 (the cube(3) plus the marker) for each
    for (const src of ['difference() { if (false) cube(1); cube(3); }', 'difference() { echo(1); cube(3); }', 'intersection() { cube(3); %cube(1); }', 'intersection() { cube(3); assert(true); }']) {
      expect(measure(run(MARK + src).geoms).volume).toBeCloseTo(28, 6)
    }
  })
})

describe('a union whose parts meet only along an edge or at a corner stays closed through later booleans', () => {
  const corner = 'difference() { union() { cube(10); translate([10, 10, 10]) cube(5); } translate([10, 2, 2]) cube(20); }'
  test('corner contact minus a cutter flush with the shared plane: closed, the binary\'s volume and box', () => {
    const r = run(corner)
    expect(openness(r.geoms)).toBeLessThan(1e-6)
    const m = measure(r.geoms)
    expect(m.volume).toBeCloseTo(1000, 6)
    expect([m.min, m.max]).toEqual([[0, 0, 0], [10, 10, 10]])
  })
  test('and what is built from it afterwards', () => {
    const r = run(`intersection() { ${corner} translate([5, 0, 0]) cube(10); }`)
    expect(openness(r.geoms)).toBeLessThan(1e-6)
    expect(measure(r.geoms).volume).toBeCloseTo(500, 6)
  })
  test('checkerboard tiles minus a flush cutter', () => {
    const r = run('difference() { union() { for (i = [0:3], j = [0:3]) if ((i + j) % 2 == 0) translate([i * 5, j * 5, 0]) cube([5, 5, 2]); } translate([10, -1, -1]) cube([20, 30, 5]); }')
    expect(openness(r.geoms)).toBeLessThan(1e-6)
    expect(measure(r.geoms).volume).toBeCloseTo(200, 6)
  })
  test('checkerboard intersected with a plate (an operand in parts)', () => {
    const r = run('intersection() { translate([2, 2, -1]) cube([16, 16, 4]); union() { for (i = [0:3], j = [0:3]) if ((i + j) % 2 == 0) translate([i * 5, j * 5, 0]) cube([5, 5, 2]); } }')
    expect(openness(r.geoms)).toBeLessThan(1e-6)
    expect(measure(r.geoms).volume).toBeCloseTo(256, 6)
  })
  test('edge contact minus a cutter', () => {
    const r = run('difference() { union() { cube(10); translate([10, 10, 0]) cube(10); } translate([-1, 10, -1]) cube([30, 20, 30]); }')
    expect(openness(r.geoms)).toBeLessThan(1e-6)
    const m = measure(r.geoms)
    expect(m.volume).toBeCloseTo(1000, 6)
    expect(m.max).toEqual([10, 10, 10])
  })
  test('stairs (corner contacts)', () => {
    const r = run('difference() { union() { for (i = [0:3]) translate([i * 5, i * 5, i * 5]) cube(5); } translate([5, 3, 3]) cube(30); }')
    expect(openness(r.geoms)).toBeLessThan(1e-6)
    expect(measure(r.geoms).volume).toBeCloseTo(125, 6)
  })
  test('parts sharing a face are still merged into one solid', () => {
    expect(run('union() { cube(10); translate([10, 0, 0]) cube(10); }').geoms).toHaveLength(1)
    expect(run('union() { cube(10); translate([10, 10, 10]) cube(5); }').geoms).toHaveLength(2)
  })
})

describe('ranges: the quotient moves up one ulp before it is truncated', () => {
  test('counts', () => {
    expect(echoes('echo(len([for (x = [1:0.05:1.4]) x]), len([for (x = [-2:0.1:-1.8]) x]), len([for (x = [5.5:0.1:8.7]) x]), len([for (x = [0:0.1:0.3]) x]), len([for (x = [0:0]) x]));'))
      .toEqual(['8, 2, 32, 4, 1'])
  })
  test('a row of holes gets the binary\'s 8 holes, not 9', () => {
    const m = measure(run('difference() { cube([30, 5, 2]); for (x = [1:0.05:1.4]) translate([(x - 1) * 70 + 1, 2.5, -1]) cylinder(r = 0.8, h = 4, $fn = 8); }').geoms)
    expect(m.volume).toBeCloseTo(271.0369078, 4)
  })
})

describe('calls', () => {
  test('a named argument that is not a parameter is bound anyway (with the warning)', () => {
    const r = run('module plate() cube([size, size, 1]); size = 2; plate(size = 5);')
    expect(measure(r.geoms).volume).toBeCloseTo(25, 6)
    expect(r.messages.map((m) => m.text)).toEqual(['variable size not specified as parameter'])
    expect(echoes('w = 10; function f() = w; echo(f(w = 3));')).toEqual(['3'])
    expect(echoes('w = 10; f = function() w; echo(f(w = 3));')).toEqual(['3'])
    expect(echoes('w = 10; module m(a) echo(a, w); m(1, w = 3);')).toEqual(['1, 3'])
    // lexical scoping still holds: a callee does not see the caller's extra argument
    expect(echoes('k = 1; module inner() echo(k); module outer() inner(); outer(k = 5);')).toEqual(['1'])
  })
  test('an argument given twice: the last wins, with the binary\'s warnings', () => {
    expect(texts('module m(a) echo(a); m(a = 1, a = 2);')).toEqual(['argument a supplied more than once', '2'])
    expect(texts('function f(a) = a; echo(f(a = 1, a = 2));')).toEqual(['argument a supplied more than once', '2'])
    expect(texts('module n() echo(zz); n(zz = 1, zz = 2);'))
      .toEqual(['variable zz not specified as parameter', 'variable zz not specified as parameter', 'argument zz supplied more than once', '2'])
  })
  test('assert() with an undef message prints none', () => {
    expect(() => run('assert(false, undef);')).toThrow(/^Assertion 'false' failed$/)
    expect(() => run('assert(false, "hi");')).toThrow(/^Assertion 'false' failed: "hi"$/)
  })
})

describe('loops', () => {
  test('intersection_for intersects every statement of every round', () => {
    expect(measure(run('intersection_for (i = [0, 1]) { translate([i, 0, 0]) cube(3); translate([0, i, 0]) cube(3); }').geoms).volume).toBeCloseTo(12, 6)
    // an if without a matching branch adds no operand; an empty else does
    expect(measure(run('intersection_for (i = [0, 1]) if (i == 0) cube(1);').geoms).volume).toBeCloseTo(1, 6)
    expect(run('intersection_for (i = [0, 1]) if (i == 0) cube(1); else {}').geoms).toHaveLength(0)
  })
  test('C-style for: the updates run in order and may add variables', () => {
    expect(echoes('echo([for (a = 0, b = 1; a < 50; a = b, b = a + b) a]);')).toEqual(['[0, 1, 2, 4, 8, 16, 32]'])
    expect(echoes('echo([for (a = 0, b = 1; a < 50; t = a, a = b, b = t + b) a]);')).toEqual(['[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]'])
  })
  test('a loop value without a name is iterated; for () runs no rounds, [for () x] one', () => {
    expect(echoes('for ([1, 2]) echo("x");')).toEqual(['"x"', '"x"'])
    expect(echoes('for (i = [1, 2], [3, 4]) echo(i);')).toEqual(['1', '1', '2', '2'])
    expect(echoes('echo([for ([1, 2]) 5]);')).toEqual(['[5, 5]'])
    expect(echoes('for () echo(1); echo([for () 1]);')).toEqual(['[1]'])
    expect(run('intersection_for () cube(2);').geoms).toHaveLength(0)
  })
  test('let() warns about a value without a name', () => {
    expect(texts('let(5) echo("y");')).toEqual(['Assignment without variable name 5', '"y"'])
    expect(texts('echo([let(7) 1]);')).toEqual(['Assignment without variable name 7', '[1]'])
  })
})

describe('search()', () => {
  test('a vector term matches the key column, or (at column 0) a whole row', () => {
    expect(echoes('t = [[[1, 2], 5], [[1, 2], 6], [[3], 7]]; echo(search([[1, 2]], t, 0), search([[1, 2]], t), search([[3]], t, 0));'))
      .toEqual(['[[0, 1]], [0], [[2]]'])
    expect(echoes('echo(search([[1, 2]], [[5, [1, 2]], [[1, 2], 6], [1, 2]], 0, 1), search([[1, 2]], [[5, [1, 2]], [[1, 2], 6], [1, 2]], 0), search([[1]], [[1], [[1], 2], 1], 0));'))
      .toEqual(['[[0]], [[1, 2]], [[0, 1]]'])
  })
  test('a string term against a table compares each character with the first character of str(key)', () => {
    expect(texts('echo(search("M4", [["M3", 3], ["M4", 4]]));')).toEqual(['search term not found: "4"', '[0]'])
    expect(echoes('echo(search("1", [[1, 1]], 0), search("ab", [["abc", 1], ["b", 2]]), search("4", [["M3", 3], ["M4", 4]], 0, 1));'))
      .toEqual(['[[0]], [0, 1], [[1]]'])
  })
  test('nothing to search in', () => {
    expect(echoes('echo(search(1, 1), search([1], 1));')).toEqual(['[], [[]]'])
  })
})

describe('the root modifier', () => {
  test('the first ! in source order wins over a ! inside it, with the warning', () => {
    const r = run('!union() { cube(1); !translate([5, 0, 0]) cube(2); }')
    expect(measure(r.geoms).volume).toBeCloseTo(9, 6)
    expect(r.messages.map((m) => m.text)).toEqual(['More than one Root Modifier (!)'])
  })
  test('a ! that makes nothing is not the root', () => {
    expect(measure(run('!echo("a"); !cube(2);').geoms).volume).toBeCloseTo(8, 6)
  })
})

describe('warning and error texts stay short whatever the values', () => {
  test('a 50 MB assert message is cut to about a thousand characters', () => {
    let err: unknown
    try { run('s = chr([for (i = [0:99999]) 65]); a = [for (i = [0:49]) s]; assert(false, a);') } catch (e) { err = e }
    expect(err).toBeInstanceOf(ScadError)
    const msg = (err as ScadError).message
    expect(msg.length).toBeLessThan(1100)
    expect(msg).toMatch(/^Assertion 'false' failed: \["AAAA.* …$/)
  })
  test('warnings that print a value', () => {
    const r = run('s = chr([for (i = [0:99999]) 65]); a = [for (i = [0:49]) s]; for (i = [0:3]) translate(a) cube(); color(s) cube();')
    for (const m of r.messages) expect(m.text.length).toBeLessThan(1100)
    expect(r.messages[0].text).toMatch(/^Unable to convert translate\(\["AAA.* …\) parameter to a vec3 or vec2 of numbers$/)
  })
})

describe('element-wise arithmetic is charged before the result is built', () => {
  const big = 'a = [for (i = [0:999]) i]; b = [for (i = [0:999]) a]; c = [for (i = [0:999]) b];'
  test.each(['d = c + c;', 'd = c - c;', 'd = c * 2;', 'd = 2 * c;', 'd = c / 2;', 'd = -c;'])('%s stops at the data limit at once', (op) => {
    const t0 = Date.now()
    let err: unknown
    try { interpret(`${big} ${op} cube(1);`) } catch (e) { err = e }
    expect(err).toBeInstanceOf(ScadError)
    expect((err as ScadError).kind).toBe('limit')
    expect((err as ScadError).message).toBe('The model creates too much data (more than 20,000,000 list elements and characters)')
    expect(Date.now() - t0).toBeLessThan(5000)
  })
  test('ordinary vector arithmetic is unchanged', () => {
    expect(echoes('echo([1, 2, 3] + [10, 20], [[1, 2], [3]] - [[1], [1, 1]], 2 * [1, [2, 3]], [4, 8] / 2, -[1, [2]]);'))
      .toEqual(['[11, 22], [[0], [2]], [2, [4, 6]], [2, 4], [-1, [-2]]'])
  })
})
