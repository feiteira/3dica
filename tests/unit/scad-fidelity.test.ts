// Fidelity fixes found by comparing whole models with OpenSCAD 2021.01 (the openscad binary's STL export, on our own
// snippets): how non-planar polyhedron faces are split, inside-out polyhedra, difference() with many cutters, reused
// subtrees, fine 2D outlines and hulls of many points. Volumes and boxes below were recorded from the binary.
import { describe, expect, test } from 'vitest'
import jscad from '@jscad/modeling'
import type { Geom3 } from '@jscad/modeling/src/geometries/types'
import { runScad, ScadError, type RunScadOptions } from '../../src/openscad'
import { splitFace } from '../../src/openscad/build-face'
import { subtractMany } from '../../src/openscad/build-csg'
import { triangulateLoop } from '../../src/openscad/build-tri'
import { WARN_INSIDE_OUT } from '../../src/openscad/build'
import type { Vec3 } from '../../src/openscad/types'

const opts = (extra: Partial<RunScadOptions> = {}): RunScadOptions => ({ resolvePart: () => { throw new Error('no parts') }, charge: () => {}, ...extra })

function measureOne(g: Geom3) {
  let v = 0, area = 0
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const p of jscad.geometries.geom3.toPolygons(g)) {
    const q = p.vertices
    for (let i = 1; i + 1 < q.length; i++) {
      const a = q[0], b = q[i], c = q[i + 1]
      v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2]
      area += Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2
    }
    for (const x of q) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], x[k]); max[k] = Math.max(max[k], x[k]) }
  }
  return { v, area, min, max }
}

function measure(geoms: Geom3[]) {
  return measureOne(geoms.length > 1 ? jscad.booleans.union(geoms) : geoms[0])
}

/** runScad's result against the binary's volume (relative tolerance; the binary's STL has 32-bit floats, so 1e-7 is
 *  about its own noise) and bounding box (absolute, mm) */
function expectLike(src: string, want: { v: number; min: number[]; max: number[] }, tol = 1e-6) {
  const m = measure(runScad(src, opts()).geoms)
  expect(Math.abs(m.v - want.v) / want.v, `volume ${m.v} vs ${want.v}`).toBeLessThan(tol)
  for (let k = 0; k < 3; k++) {
    expect(m.min[k]).toBeCloseTo(want.min[k], 3)
    expect(m.max[k]).toBeCloseTo(want.max[k], 3)
  }
}

describe('non-planar polyhedron faces are split as OpenSCAD splits them', () => {
  test('a warped quad takes the Delaunay diagonal (550, not 450)', () => {
    // top corners at heights 4, 7, 3, 6: splitting along (10,0)-(0,10) gives 550, the other diagonal 450
    expectLike('polyhedron(points = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,4],[10,0,7],[10,10,3],[0,10,6]], faces = [[0,1,2,3],[7,6,5,4],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]]);',
      { v: 550, min: [0, 0, 0], max: [10, 10, 7] }, 1e-9)
  })
  test('a square tie (both diagonals Delaunay) follows the sweep order of the reversed face', () => {
    expectLike('polyhedron(points = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,12],[10,10,10],[0,10,12]], faces = [[0,1,2,3],[7,6,5,4],[0,4,5,1],[1,5,6,2],[2,6,7,3],[3,7,4,0]]);',
      { v: 1133.333333, min: [0, 0, 0], max: [10, 10, 12] }, 1e-9)
  })
  test('non-planar pentagons in a warped house', () => {
    expectLike('polyhedron(points = [[0,0,0],[20,0,0],[20,15,0],[0,15,0],[0,0,10],[20,0,12],[20,15,10],[0,15,11],[10,-2,18],[10,17,18]], faces = [[0,1,2,3],[4,8,5,1,0],[3,2,6,9,7],[0,3,7,4],[1,5,6,2],[4,7,9,8],[5,8,9,6]]);',
      { v: 4456.666667, min: [0, -2, 0], max: [20, 17, 18] }, 1e-9)
  })
  test('a twisted ring from list comprehensions (every side quad is warped)', () => {
    expectLike(`n = 24; R = 10; w = 4; t = 1;
function sec(i) = let(a = i * 360 / n, tw = i * 180 / n, c = [R * cos(a), R * sin(a), 0], u = [cos(a), sin(a), 0], z = [0, 0, 1], e1 = u * cos(tw) + z * sin(tw), e2 = -u * sin(tw) + z * cos(tw)) [c + e1 * w / 2 + e2 * t / 2, c - e1 * w / 2 + e2 * t / 2, c - e1 * w / 2 - e2 * t / 2, c + e1 * w / 2 - e2 * t / 2];
pts = [for (i = [0 : n]) each sec(i)];
faces = concat([for (i = [0 : n - 1], k = [0 : 3]) let(a = 4 * i + k, b = 4 * i + (k + 1) % 4) [a, b, b + 4, a + 4]], [[3, 2, 1, 0], [4 * n, 4 * n + 1, 4 * n + 2, 4 * n + 3]]);
polyhedron(pts, faces);`, { v: 261.2915218, min: [-10.5, -11.76777, -2.06126], max: [12, 11.76777, 2.06126] }, 1e-7)
  })
  test('splitFace: triangles keep the winding and cover the face', () => {
    const pts: Vec3[] = [[0, 0, 0], [10, 0, 1], [12, 8, 0], [5, 12, 2], [-2, 7, 0]]
    const tris = splitFace(pts, triangulateLoop)
    expect(tris).toHaveLength(3)
    const used = new Set(tris.flat())
    expect(used.size).toBe(5)
    // each triangle's normal points the same way as the face's (up)
    for (const [a, b, c] of tris) {
      const u = pts[b].map((x, k) => x - pts[a][k]), v = pts[c].map((x, k) => x - pts[a][k])
      expect(u[0] * v[1] - u[1] * v[0]).toBeGreaterThan(0)
    }
  })
})

describe('inside-out polyhedra are turned right side out, like OpenSCAD\'s render', () => {
  const INVERTED = 'polyhedron(points = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]], faces = [[3,2,1,0],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]])'
  test('subtracted from a cube: 8 − 1 = 7 (JSCAD would make a mess of the inverted faces)', () => {
    const r = runScad(`difference() { cube(2, center = true); ${INVERTED}; }`, opts())
    expect(measure(r.geoms).v).toBeCloseTo(7, 9)
    expect(r.messages.map((m) => m.text)).toEqual([WARN_INSIDE_OUT])
  })
  test('next to other objects: 2.5', () => {
    expectLike(`P = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
F = [[3,2,1,0],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]];
polyhedron(P, F); translate([3, 0, 0]) polyhedron(P, F); translate([0.5, 0, 0]) cube(1);`, { v: 2.5, min: [0, 0, 0], max: [4, 1, 1] }, 1e-9)
  })
})

describe('difference() with many cutters', () => {
  test('a plate with 96 holes', () => {
    expectLike('difference() { cube([60, 40, 3]); for (i = [0 : 11], j = [0 : 7]) translate([2.5 + i * 5, 2.5 + j * 5, -1]) cylinder(r = 1.5, h = 5, $fn = 12); }',
      { v: 5256.000035, min: [0, 0, 0], max: [60, 40, 3] }, 1e-7)
  })
  test('cutters that cross each other and the base', () => {
    expectLike('difference() { cube(30, center = true); for (a = [0 : 30 : 150]) rotate([0, 0, a]) cube([40, 4, 10], center = true); for (z = [-9, 9]) translate([0, 0, z]) rotate([90, 0, 0]) cylinder(r = 3, h = 40, center = true, $fn = 20); }',
      { v: 19180.13077, min: [-15, -15, -15], max: [15, 15, 15] }, 1e-7)
  })
  test('cutters flush with the base and with each other', () => {
    expectLike('difference() { cube([20, 20, 10]); cube([10, 10, 10]); translate([10, 10, 0]) cube([10, 10, 5]); translate([0, 10, 5]) cube([10, 10, 5]); translate([5, 5, 0]) cube([10, 10, 10]); }',
      { v: 1500, min: [0, 0, 0], max: [20, 20, 10] }, 1e-9)
  })
  test('a fine sphere minus three cylinders (convex trees)', () => {
    expectLike('difference() { sphere(r = 20, $fn = 60); for (v = [[0, 0, 0], [90, 0, 0], [0, 90, 0]]) rotate(v) cylinder(r = 6, h = 50, center = true, $fn = 40); }',
      { v: 22598.7965, min: [-19.06786, -19.06786, -19.05625], max: [19.06786, 19.06786, 19.05625] }, 1e-6)
  })
  test('the same surface as JSCAD\'s one-at-a-time subtract, closed, and a lot faster', () => {
    const { cuboid, cylinder, sphere } = jscad.primitives
    const base = cuboid({ size: [20, 20, 6] })
    const cutters: Geom3[] = []
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) cutters.push(cylinder({ radius: 0.8 + ((i + j) % 3) * 0.3, height: 8, center: [-7.5 + i * 3, -7.5 + j * 3, 0], segments: 10 }))
    cutters.push(cuboid({ size: [4, 30, 2], center: [0, 0, 3] }), sphere({ radius: 3, center: [5, 5, -3], segments: 12 }))
    const t0 = performance.now()
    const want = measureOne(jscad.booleans.subtract(base, ...cutters))
    const t1 = performance.now()
    const got = measureOne(subtractMany({ g: base, convex: true }, cutters.map((g) => ({ g, convex: true }))))
    const t2 = performance.now()
    expect(got.v).toBeCloseTo(want.v, 6)
    expect(got.area).toBeCloseTo(want.area, 5)
    expect(t2 - t1).toBeLessThan(t1 - t0)
  })
  test('the fragments count towards the geometry budget', () => {
    let charged = 0
    runScad('difference() { cube([60, 40, 3]); for (i = [0 : 11], j = [0 : 7]) translate([2.5 + i * 5, 2.5 + j * 5, -1]) cylinder(r = 1.5, h = 5, $fn = 12); }', opts({ charge: (n) => { charged += n } }))
    // 6 + 96 × 14 for the shapes, plus the pieces the holes cut the plate into
    expect(charged).toBeGreaterThan(6 + 96 * 14 + 1000)
  })
})

describe('reused subtrees are built once', () => {
  test('the same module call in many places gives the same result as the binary', () => {
    expectLike(`module post() difference() { cylinder(r = 3, h = 10, $fn = 30); translate([0, 0, 2]) cylinder(r = 1.5, h = 10, $fn = 20); }
for (x = [0 : 10 : 50]) translate([x, 0, 0]) post();
translate([0, 20, 0]) post();`, { v: 1575.403882, min: [-3, -2.98357, 0], max: [53, 22.98357, 10] }, 1e-6)
  })
  test('a reused result is still charged, with the description of what made it heavy', () => {
    const calls: [number, string][] = []
    runScad('for (i = [0 : 2]) translate([i * 10, 0, 0]) sphere(1, $fn = 40);', opts({ charge: (n, what) => { calls.push([n, what]) } }))
    expect(calls).toHaveLength(3)
    expect(calls[0][1]).toBe('sphere() with $fn = 40')
    expect(calls.map((c) => c[1])).toEqual(['sphere() with $fn = 40', 'sphere() with $fn = 40', 'sphere() with $fn = 40'])
    expect(calls[1][0]).toBe(calls[2][0])
  })
  test('the budget still stops many copies of one heavy shape', () => {
    let total = 0
    const charge = (n: number) => { total += n; if (total > 100_000) throw new ScadError('limit', 'Too much geometry') }
    expect(() => runScad('for (i = [0 : 99]) translate([i, 0, 0]) sphere(1, $fn = 100);', opts({ charge }))).toThrow('Too much geometry')
  })
})

describe('fine outlines and big hulls', () => {
  test('a circle with 3000 fragments', () => {
    expectLike('linear_extrude(1) circle(r = 10, $fn = 3000);', { v: 314.159036, min: [-10, -10, 0], max: [10, 10, 1] }, 1e-8)
  })
  test('a round offset with 2000 fragments', () => {
    // OpenSCAD's Clipper snaps 2D work to 1/65536 mm, which 3Dica does not copy: a few parts in a million
    expectLike('linear_extrude(1) offset(r = 2, $fn = 2000) square([10, 5]);', { v: 122.5660767, min: [-2, -2, 0], max: [12, 7, 1] }, 1e-5)
  })
  test('a huge round offset is built (no call-stack overflow on 200 000 points)', () => {
    const r = runScad('offset(r = 1, $fn = 1e7) square(1);', opts())
    // Clipper's cap of the arc steps (π · r · 2^16 per turn) makes about 205 900 points: area ≈ 1 + 4 + π
    expect(measure(r.geoms).v).toBeCloseTo(5 + Math.PI, 4)
  }, 30000)
  test('the hull of spheres in a row (the interior points are dropped first)', () => {
    expectLike('hull() for (i = [0 : 9]) translate([i * 5, i % 3, 0]) sphere(r = 4, $fn = 40);',
      { v: 3130.238482, min: [-3.98767, -3.98767, -3.98767], max: [48.98767, 5.98767, 3.98767] }, 1e-6)
  })
})

describe('console output', () => {
  test('import() and surface() stop with their error alone, without warnings about their arguments', () => {
    for (const src of ['import("part.stl", convexity = 5);', 'import(file = "a.dxf", layer = "x", origin = [0, 0], scale = 2);', 'surface(file = "h.dat", center = true, convexity = 5, invert = true);']) {
      let e: unknown
      try { runScad(src, opts()) } catch (x) { e = x }
      expect(e, src).toBeInstanceOf(ScadError)
      expect((e as ScadError).kind).toBe('runtime')
      expect((e as ScadError).messages ?? []).toEqual([])
    }
  })
})

describe('text() takes the size and place of OpenSCAD\'s default font (Liberation Sans)', () => {
  // the binary's numbers (v = 0: box only); the letter shapes differ (a stroke font), so volumes are only close
  const like = (src: string, want: { v: number; min: number[]; max: number[] }, volTol: number) => {
    const m = measure(runScad(src, opts()).geoms)
    if (want.v) expect(Math.abs(m.v - want.v) / want.v, `volume ${m.v} vs ${want.v}`).toBeLessThan(volTol)
    for (let k = 0; k < 2; k++) {
      expect(Math.abs(m.min[k] - want.min[k]), `min ${k}: ${m.min[k]} vs ${want.min[k]}`).toBeLessThan(0.02)
      expect(Math.abs(m.max[k] - want.max[k]), `max ${k}: ${m.max[k]} vs ${want.max[k]}`).toBeLessThan(0.02)
    }
  }
  test('glyph boxes, advances and area', () => {
    like('linear_extrude(1) text("H", size = 10);', { v: 30.35722527, min: [1.1393, 0], max: [8.89699, 9.55479] }, 1e-3)
    like('linear_extrude(1) text("0123456789", size = 10);', { v: 245.1258874, min: [0.5425, -0.13559], max: [74.95544, 9.69719] }, 1e-3)
    like('linear_extrude(1) text("Hello", size = 10);', { v: 99.53598048, min: [1.1393, -0.13559], max: [30.50574, 10.06339] }, 0.02)
    like('linear_extrude(1) text("agxyz", size = 10);', { v: 112.4620281, min: [0.59, -2.88199], max: [34.9023, 7.47289] }, 1e-3)
  })
  test('kerning, spacing and halign on the advance', () => {
    like('linear_extrude(1) text("AVATAR", size = 10);', { v: 159.5735987, min: [0.0271, 0], max: [49.83051, 9.55479] }, 1e-3)
    like('linear_extrude(1) text("Welcome, To You.", size = 7, halign = "center");', { v: 136.8461698, min: [-37.78409, -1.24368], max: [37.00221, 7.04437] }, 0.01)
    like('linear_extrude(1) text("Type", size = 10, spacing = 1.5);', { v: 90.54737021, min: [0.31189, -2.88199], max: [39.89937, 9.55479] }, 1e-3)
    like('linear_extrude(1) text("AVbC", size = 10, direction = "rtl");', { v: 104.8401198, min: [0.70529, -0.13559], max: [34.61441, 10.06339] }, 1e-3)
  })
  test('valign uses the largest ascent and descent of the glyphs', () => {
    like('linear_extrude(1) text("Hg", size = 10, valign = "top", halign = "right");', { v: 0, min: [-16.199, -12.213], max: [-0.715, 0.224] }, 0)
    like('linear_extrude(1) text("Hg", size = 10, valign = "center", halign = "center");', { v: 0, min: [-7.53, -6.138], max: [7.955, 6.299] }, 0)
    like('linear_extrude(1) text("3Dica", size = 10, valign = "bottom");', { v: 0, min: [0.529, 0.002], max: [34.857, 10.201] }, 0)
  })
})

