// runScad (interpreter + builder) end to end, against OpenSCAD 2021.01. The expected volumes, bounding boxes and
// console lines were recorded from the openscad binary on these snippets (our own), with -D for the overridden
// parameter; a 2D-only result was measured from its SVG export (area of the 1 mm preview slab).
import { describe, expect, test } from 'vitest'
import jscad from '@jscad/modeling'
import type { Geom3 } from '@jscad/modeling/src/geometries/types'
import type { ParamValue } from '../../src/core/types'
import { runScad, ScadError, type RunScadOptions } from '../../src/openscad'

const opts = (extra: Partial<RunScadOptions> = {}): RunScadOptions => ({ resolvePart: () => { throw new Error('no parts') }, charge: () => {}, ...extra })

function measure(geoms: Geom3[]) {
  const list = geoms.length > 1 ? [jscad.booleans.union(geoms)] : geoms
  let v = 0
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const g of list) for (const p of jscad.geometries.geom3.toPolygons(g)) {
    const q = p.vertices
    for (let i = 1; i + 1 < q.length; i++) {
      const a = q[0], b = q[i], c = q[i + 1]
      v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    }
    for (const x of q) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], x[k]); max[k] = Math.max(max[k], x[k]) }
  }
  return { v, min, max }
}

/** the binary's console line → our ScadMessage text */
const consoleText = (line: string) => line.replace(/^(ECHO|WARNING): /, '')

const BRACKET = `w = 40; // [10:100]
h = 25;
t = 4;
hole = 5;
$fn = 32;
module plate(x, y) cube([x, y, t]);
difference() {
  union() {
    plate(w, h);
    translate([0, 0, 0]) cube([t, h, w / 2]);
  }
  for (i = [1 : 2]) translate([i * w / 3, h / 2, -1]) cylinder(d = hole, h = t + 2);
  translate([-1, h / 2, w / 3]) rotate([0, 90, 0]) cylinder(d = hole, h = t + 2);
}`

const CASES: [string, string, Record<string, ParamValue>, { v: number; min: number[]; max: number[] }, string[]][] = [
  ['bracket with holes', `w = 40; // [10:100]
h = 25;
t = 4;
hole = 5;
$fn = 32;
module plate(x, y) cube([x, y, t]);
difference() {
  union() {
    plate(w, h);
    translate([0, 0, 0]) cube([t, h, w / 2]);
  }
  for (i = [1 : 2]) translate([i * w / 3, h / 2, -1]) cylinder(d = hole, h = t + 2);
  translate([-1, h / 2, w / 3]) rotate([0, 90, 0]) cylinder(d = hole, h = t + 2);
}`, {}, { v: 5365.891608, min: [0,0,0], max: [40,25,20] }, []],
  ['bracket with holes, w overridden', BRACKET, { w: 60 }, { v: 8365.891586, min: [0,0,0], max: [60,25,30] }, []],
  ['vase: rotate_extrude of a polygon', `$fa = 6; $fs = 0.5;
pts = [for (z = [0 : 5 : 60]) [15 + 5 * sin(z * 6), z]];
rotate_extrude() polygon(concat([[0, 0]], pts, [[0, 60]]));`, {}, { v: 44580.87486, min: [-20,-20,0], max: [20,20,60] }, []],
  ['twisted star', `function star(n, r1, r2) = [for (i = [0 : 2 * n - 1]) let (a = 180 * i / n, r = i % 2 ? r2 : r1) [r * cos(a), r * sin(a)]];
linear_extrude(height = 30, twist = 120, scale = 0.6) polygon(star(5, 20, 9));`, {}, { v: 10936.90326, min: [-17.99790192,-19.09480667,0], max: [20,19.02111816,30] }, []],
  ['rounded box: minkowski', `minkowski() {
  cube([30, 20, 10], center = true);
  sphere(r = 2, $fn = 16);
}`, {}, { v: 11076.96362, min: [-16.96157074,-11.96156979,-6.961569786], max: [16.96157074,11.96156979,6.961569786] }, []],
  ['hollow rounded box', `difference() {
  minkowski() { cube([30, 20, 10], center = true); sphere(2, $fn = 12); }
  cube([30, 20, 20], center = true);
}`, {}, { v: 2673.686331, min: [-16.93185043,-11.93185139,-6.931851387], max: [16.93185043,11.93185139,6.931851387] }, []],
  ['gear-ish: offset of a polygon', `teeth = 12;
pts = [for (i = [0 : teeth * 2 - 1]) let (a = 360 * i / (teeth * 2), r = i % 2 ? 18 : 22) [r * cos(a), r * sin(a)]];
linear_extrude(5) offset(r = 1, $fn = 24) offset(delta = -1) polygon(pts);`, {}, { v: 6136.418666, min: [-21.59263611,-21.59263611,0], max: [21.59263611,21.59263611,5] }, []],
  ['children() and intersection_for', `module ring(n) for (i = [0 : n - 1]) rotate(i * 360 / n) children();
ring(6) translate([20, 0, 0]) cylinder(r = 4, h = 10, $fn = 20);
intersection_for (a = [0, 60, 120]) rotate([0, 0, a]) cube([30, 10, 10], center = true);`, {}, { v: 3832.588737, min: [-24,-21.29859543,-5], max: [24,21.29859543,10] }, []],
  ['hull of spheres', `hull() for (p = [[0, 0, 0], [20, 0, 0], [0, 15, 0], [5, 5, 12]]) translate(p) sphere(3, $fn = 20);`, {}, { v: 3257.393239, min: [-2.963064194,-2.963064194,-2.963064194], max: [22.96306419,17.96306419,14.96306419] }, []],
  ['projection of a rotated cylinder', `linear_extrude(2) projection() rotate([60, 0, 30]) cylinder(h = 20, r = 5, $fn = 30, center = true);
translate([40, 0, 0]) linear_extrude(2) projection(cut = true) rotate([60, 0, 30]) cylinder(h = 20, r = 5, $fn = 30, center = true);`, {}, { v: 736.2442483, min: [-8.825515747,-10.79512024,0], max: [46.61314392,10.79512024,2] }, []],
  ['resize and mirror', `resize([30, 0, 0], auto = true) sphere(5, $fn = 24);
mirror([1, 1, 0]) translate([20, 0, 0]) cube([5, 10, 15]);`, {}, { v: 14847.34743, min: [-15,-25,-15], max: [15,15,15] }, []],
  ['2D only (shown 1 mm thick)', `difference() { square(20, center = true); circle(6, $fn = 40); }
translate([30, 0]) offset(delta = 2, chamfer = true) square(10);`, {}, { v: 480.6222044, min: [-10,-10,-0.5], max: [42,12,0.5] }, []],
]

describe('runScad matches OpenSCAD 2021.01', () => {
  test.each(CASES)('%s', (_name, src, overrides, ref, consoleLines) => {
    const out = runScad(src, opts({ overrides }))
    const m = measure(out.geoms)
    const size = Math.max(1, ...ref.min.map(Math.abs), ...ref.max.map(Math.abs))
    expect(Math.abs(m.v - ref.v)).toBeLessThanOrEqual(1e-4 * ref.v)
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(m.min[k] - ref.min[k])).toBeLessThanOrEqual(1e-4 * size)
      expect(Math.abs(m.max[k] - ref.max[k])).toBeLessThanOrEqual(1e-4 * size)
    }
    const expected = consoleLines.map(consoleText)
    if (ref.min[2] === -0.5 && ref.max[2] === 0.5) expected.push("2D result shown 1 mm thick, like OpenSCAD's preview — use linear_extrude() for a solid")
    expect(out.messages.map((x) => x.text)).toEqual(expected)
  })
})

describe('runScad', () => {
  test('messages: the console (echo) first, then the build warnings, with positions', () => {
    const out = runScad('echo("before");\nsquare(10);\ncube(5);', opts())
    expect(out.messages.map((x) => [x.level, x.text, x.pos?.line])).toEqual([
      ['echo', '"before"', 1],
      ['warning', 'Mixing 2D and 3D objects is not supported', 2],
      ['warning', 'Ignoring 2D child object for 3D operation', 2],
    ])
    // the binary takes the first top-level object's dimension and keeps the square; 3Dica keeps the solid
    expect(out.geoms).toHaveLength(1)
    expect(measure(out.geoms).v).toBeCloseTo(125, 9)
  })

  test('top-level objects stay separate pieces, each with its colour', () => {
    const out = runScad('color("red") cube(10);\nfor (i = [1 : 3]) translate([i * 5, 0, 0]) sphere(3);', opts())
    expect(out.geoms).toHaveLength(4)
    expect(out.geoms[0].color).toEqual([1, 0, 0, 1])
    expect(out.geoms[1].color).toBeUndefined()
  })

  test('part() geometry comes from the context', () => {
    const plate = jscad.primitives.cuboid({ size: [20, 20, 2], center: [10, 10, 1] })
    const calls: unknown[] = []
    const out = runScad('difference() { part("Plate", width = 20); translate([10, 10, -1]) cylinder(r = 3, h = 4, $fn = 24); }', opts({
      resolvePart: (name, overrides) => { calls.push([name, overrides]); return [plate] },
    }))
    expect(calls).toEqual([['Plate', { width: 20 }]])
    expect(measure(out.geoms).v).toBeCloseTo(800 - 2 * 12 * 9 * Math.sin(Math.PI / 12), 6) // minus a 24-gon hole
  })

  test('errors are ScadErrors at the right line; the budget stops a runaway model', () => {
    // a bad polyhedron face is dropped with the binary's warning
    const ph = runScad('cube(1);\npolyhedron([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 5]]);', opts())
    expect(ph.messages.map((x) => [x.text, x.pos?.line])).toEqual([['Point index 5 is out of bounds (from faces[0][2])', 2]])
    let e: unknown
    try { runScad('cube(1);\nsphere(1, $fn = 1e5);', opts()) } catch (x) { e = x }
    expect(e).toBeInstanceOf(ScadError)
    expect((e as ScadError).kind).toBe('limit')
    expect((e as ScadError).pos?.line).toBe(2)
    // the console output before a build error stays with it
    try { runScad('echo("x");\ncircle(1, $fs = 0);\nsphere(1, $fn = 1e5);', opts()) } catch (x) { e = x }
    expect((e as ScadError).messages?.map((m) => m.text)).toEqual(['"x"', '$fs too small - clamping to 0.010000'])
    let charged = 0
    const budget = opts({ charge: (n, what, pos) => { charged += n; if (charged > 2e6) throw new ScadError('limit', `Too much geometry: ${what}`, pos) } })
    try { runScad('for (i = [0 : 99]) translate([i, 0, 0]) sphere(1, $fn = 400);', budget) } catch (x) { e = x }
    expect((e as ScadError).kind).toBe('limit')
    expect((e as ScadError).message).toContain('$fn = 400')
  })
})
