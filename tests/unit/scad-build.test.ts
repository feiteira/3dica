// The OpenSCAD builder (src/openscad/build.ts) against OpenSCAD 2021.01. Hand-built CSG trees (no interpreter); the
// expected numbers were recorded from the openscad binary's binary STL export of the scad text above each row
// (our own snippets). Rows with n/s1/s2 are exact tessellations: the same vertices as the binary to 1e-6 (n = unique
// vertices, s1 = Σ(x + 2y + 3z), s2 = Σ(x² + y² + z²) over them). The others are CSG results compared by volume
// (1e-4 relative) and bounding box: OpenSCAD runs 2D work through Clipper on a 1/65536 grid and CGAL merges faces,
// so their vertices differ slightly.
import { describe, expect, test } from 'vitest'
import jscad from '@jscad/modeling'
import type { Geom3 } from '@jscad/modeling/src/geometries/types'
import { build } from '../../src/openscad/build'
import { ScadError, type BuildContext, type Fragments, type GeomNode, type Vec2, type Vec3 } from '../../src/openscad/types'

// ───────────────────────────── a tiny CSG-tree DSL ─────────────────────────────

const F = (fn = 0, fa = 12, fs = 2): Fragments => ({ fn, fa, fs })
const v3 = (s: number | Vec3): Vec3 => (typeof s === 'number' ? [s, s, s] : s)
const v2 = (s: number | Vec2): Vec2 => (typeof s === 'number' ? [s, s] : s)
const cube = (s: number | Vec3, center = false): GeomNode => ({ kind: 'cube', size: v3(s), center })
const sphere = (r: number, frag = F()): GeomNode => ({ kind: 'sphere', r, frag })
const cyl = (h: number, r1: number, r2: number, center = false, frag = F()): GeomNode => ({ kind: 'cylinder', h, r1, r2, center, frag })
const square = (s: number | Vec2, center = false): GeomNode => ({ kind: 'square', size: v2(s), center })
const circle = (r: number, frag = F()): GeomNode => ({ kind: 'circle', r, frag })
const polygon = (points: Vec2[], paths?: number[][]): GeomNode => ({ kind: 'polygon', points, paths })
const polyhedron = (points: Vec3[], faces: number[][]): GeomNode => ({ kind: 'polyhedron', points, faces })
const mul = (a: number[], b: number[]): number[] => {
  const o = new Array(16).fill(0)
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}
const cs = (a: number): [number, number] => {
  const x = ((a % 360) + 360) % 360
  return x === 0 ? [1, 0] : x === 90 ? [0, 1] : x === 180 ? [-1, 0] : x === 270 ? [0, -1] : [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)]
}
const mm = (m: number[], ...children: GeomNode[]): GeomNode => ({ kind: 'multmatrix', m, children })
const translate = (t: number[], ...c: GeomNode[]) => mm([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2] ?? 0, 1], ...c)
const scale = (s: number[], ...c: GeomNode[]) => mm([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2] ?? 1, 0, 0, 0, 0, 1], ...c)
const rotate = (r: number[], ...c: GeomNode[]) => {
  const [cx, sx] = cs(r[0]), [cy, sy] = cs(r[1]), [cz, sz] = cs(r[2])
  const Rx = [1, 0, 0, 0, 0, cx, sx, 0, 0, -sx, cx, 0, 0, 0, 0, 1]
  const Ry = [cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]
  const Rz = [cz, sz, 0, 0, -sz, cz, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  return mm(mul(Rz, mul(Ry, Rx)), ...c)
}
const mirror = (n: number[], ...c: GeomNode[]) => {
  const l = Math.hypot(n[0], n[1], n[2] ?? 0), a = n[0] / l, b = n[1] / l, d = (n[2] ?? 0) / l
  return mm([1 - 2 * a * a, -2 * a * b, -2 * a * d, 0, -2 * a * b, 1 - 2 * b * b, -2 * b * d, 0, -2 * a * d, -2 * b * d, 1 - 2 * d * d, 0, 0, 0, 0, 1], ...c)
}
const op = (kind: 'group' | 'union' | 'difference' | 'intersection' | 'hull' | 'minkowski', ...children: GeomNode[]): GeomNode => ({ kind, children })
const resize = (size: Vec3, auto: [boolean, boolean, boolean], ...children: GeomNode[]): GeomNode => ({ kind: 'resize', size, auto, children })
const offset = (o: { r?: number; delta?: number; chamfer?: boolean }, frag: Fragments, ...children: GeomNode[]): GeomNode =>
  ({ kind: 'offset', r: o.r, delta: o.delta, chamfer: o.chamfer ?? false, frag, children })
const lin = (o: { height: number; center?: boolean; twist?: number; slices?: number; scale?: number | Vec2 }, frag: Fragments, ...children: GeomNode[]): GeomNode => ({
  kind: 'linear_extrude', height: o.height, center: o.center ?? false, twist: o.twist ?? 0, slices: o.slices,
  scale: o.scale === undefined ? [1, 1] : v2(o.scale), frag, children,
})
const rot = (angle: number, frag: Fragments, ...children: GeomNode[]): GeomNode => ({ kind: 'rotate_extrude', angle, frag, children })
const projection = (cut: boolean, ...children: GeomNode[]): GeomNode => ({ kind: 'projection', cut, children })

// ───────────────────────────── measuring ─────────────────────────────

/** A context that never refuses (charges are recorded) and has no parts. */
function ctxOf(opts: { budget?: number; parts?: Record<string, Geom3[]> } = {}): BuildContext & { charged: number; whats: string[] } {
  const c = {
    charged: 0,
    whats: [] as string[],
    resolvePart(name: string) {
      const g = opts.parts?.[name]
      if (!g) throw new Error(`no part ${name}`)
      return g
    },
    charge(n: number, what: string) {
      c.charged += n
      c.whats.push(what)
      if (opts.budget !== undefined && c.charged > opts.budget) throw new ScadError('limit', `Too much geometry: ${what}`)
    },
  }
  return c
}

function measure(geoms: Geom3[]) {
  const list = geoms.length > 1 ? [jscad.booleans.union(geoms)] : geoms
  let volume = 0
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  const verts = new Map<string, number[]>()
  for (const g of list) for (const p of jscad.geometries.geom3.toPolygons(g)) {
    const v = p.vertices
    for (let i = 1; i + 1 < v.length; i++) {
      const a = v[0], b = v[i], c = v[i + 1]
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    }
    for (const q of v) {
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], q[k]); max[k] = Math.max(max[k], q[k]) }
      verts.set(q.map((x) => Math.fround(x) || 0).join(','), [q[0], q[1], q[2]]) // the binary writes float32
    }
  }
  let s1 = 0, s2 = 0
  for (const q of verts.values()) { s1 += q[0] + 2 * q[1] + 3 * q[2]; s2 += q[0] * q[0] + q[1] * q[1] + q[2] * q[2] }
  return { volume, min, max, n: verts.size, s1, s2 }
}

interface Ref { v: number; min: number[]; max: number[]; n?: number; s1?: number; s2?: number }

function check(node: GeomNode, ref: Ref) {
  const out = build([node], ctxOf())
  const m = measure(out.geoms)
  const size = Math.max(1, ...ref.min.map(Math.abs), ...ref.max.map(Math.abs))
  const exact = ref.n !== undefined
  const tol = exact ? 1e-6 : 1e-4
  expect(Math.abs(m.volume - ref.v)).toBeLessThanOrEqual(tol * Math.abs(ref.v))
  for (let k = 0; k < 3; k++) {
    expect(Math.abs(m.min[k] - ref.min[k])).toBeLessThanOrEqual(tol * size)
    expect(Math.abs(m.max[k] - ref.max[k])).toBeLessThanOrEqual(tol * size)
  }
  if (exact) {
    expect(m.n).toBe(ref.n)
    expect(Math.abs(m.s1 - ref.s1!)).toBeLessThanOrEqual(1e-6 * size * ref.n!)
    expect(Math.abs(m.s2 - ref.s2!)).toBeLessThanOrEqual(1e-6 * Math.max(ref.s2!, 1))
  }
}

// ───────────────────────────── recorded from the binary ─────────────────────────────

const REF: Record<string, [string, () => GeomNode, Ref][]> = {
  primitives: [
    // cube([10,7,5], center=false);
    ['cube', () => cube([10, 7, 5]), { v: 350, min: [0,0,0], max: [10,7,5], n: 8, s1: 156, s2: 696 }],
    // cube([1,2,3], center=true);
    ['cube centred', () => cube([1, 2, 3], true), { v: 6, min: [-0.5,-1,-1.5], max: [0.5,1,1.5], n: 8, s1: 0, s2: 28 }],
    // sphere(r=10, $fn=8, $fa=12, $fs=2);
    ['sphere $fn=8', () => sphere(10, F(8)), { v: 3229.045703, min: [-9.23879528,-9.23879528,-9.23879528], max: [9.23879528,9.23879528,9.23879528], n: 32, s1: 0, s2: 3200.000037 }],
    // sphere(r=1, $fn=0, $fa=12, $fs=2);
    ['sphere r=1 defaults (5 fragments)', () => sphere(1), { v: 2.402280727, min: [-0.8090170026,-0.95105654,-0.8660253882], max: [1,0.95105654,0.8660253882], n: 15, s1: 0, s2: 14.99999989 }],
    // sphere(r=10, $fn=0, $fa=12, $fs=2);
    ['sphere r=10 defaults (30 fragments)', () => sphere(10), { v: 4112.862156, min: [-10,-9.94521904,-9.94521904], max: [10,9.94521904,9.94521904], n: 450, s1: 0, s2: 44999.99995 }],
    // sphere(r=3, $fn=0, $fa=12, $fs=0.5);
    ['sphere $fs=0.5', () => sphere(3, F(0, 12, 0.5)), { v: 111.0472768, min: [-3,-2.983565569,-2.983565569], max: [3,2.983565569,2.983565569], n: 450, s1: 0, s2: 4049.999894 }],
    // sphere(r=1, $fn=3, $fa=12, $fs=2);
    ['sphere $fn=3', () => sphere(1, F(3)), { v: 0.9185586555, min: [-0.3535533845,-0.612372458,-0.7071067691], max: [0.7071067691,0.612372458,0.7071067691], n: 6, s1: 0, s2: 5.999999955 }],
    // sphere(r=2, $fn=7.9, $fa=12, $fs=2);
    ['sphere $fn=7.9 (truncated to 7)', () => sphere(2, F(7.9)), { v: 24.99196228, min: [-1.664773345,-1.801431894,-1.847759008], max: [1.847759008,1.801431894,1.847759008], n: 28, s1: 5.960464478e-8, s2: 111.9999962 }],
    // cylinder(h=5, r1=2, r2=2, center=false, $fn=0, $fa=12, $fs=2);
    ['cylinder defaults', () => cyl(5, 2, 2), { v: 54.72820318, min: [-1.801937699,-1.949855804,0], max: [2,1.949855804,5], n: 14, s1: 105.0000001, s2: 230.9999994 }],
    // cylinder(h=5, r1=3, r2=1, center=true, $fn=7, $fa=12, $fs=2);
    ['cone centred $fn=7', () => cyl(5, 3, 1, true, F(7)), { v: 59.28888782, min: [-2.702906609,-2.924783707,-2.5], max: [3,2.924783707,2.5], n: 14, s1: 1.490116119e-7, s2: 157.5000006 }],
    // cylinder(h=5, r1=0, r2=3, center=false, $fn=6, $fa=12, $fs=2);
    ['cone r1=0 (apex at the bottom)', () => cyl(5, 0, 3, false, F(6)), { v: 38.97114158, min: [-3,-2.598076105,0], max: [3,2.598076105,5], n: 7, s1: 90, s2: 203.9999978 }],
    // cylinder(h=5, r1=3, r2=0, center=true, $fn=6, $fa=12, $fs=2);
    ['cone r2=0 centred', () => cyl(5, 3, 0, true, F(6)), { v: 38.97114158, min: [-3,-2.598076105,-2.5], max: [3,2.598076105,2.5], n: 7, s1: -37.5, s2: 97.74999779 }],
    // cylinder(h=2, r1=10, r2=5, center=false, $fn=0, $fa=5, $fs=0.3);
    ['cylinder $fa=5 $fs=0.3', () => cyl(2, 10, 5, false, F(0, 5, 0.3)), { v: 366.0541243, min: [-10,-10,0], max: [10,10,2], n: 144, s1: 432, s2: 9288.000118 }],
    // linear_extrude(height=2, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { square([3,4], center=true); }
    ['square centred', () => lin({ height: 2 }, F(), square([3, 4], true)), { v: 24, min: [-1.5,-2,0], max: [1.5,2,2], n: 8, s1: 24, s2: 66 }],
    // linear_extrude(height=2, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { circle(r=5, $fn=0, $fa=6, $fs=0.4); }
    ['circle $fa=6 $fs=0.4', () => lin({ height: 2 }, F(), circle(5, F(0, 6, 0.4))), { v: 156.7926946, min: [-5,-5,0], max: [5,5,2], n: 120, s1: 360, s2: 3239.999994 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { circle(r=1, $fn=2, $fa=12, $fs=2); }
    ['circle $fn=2 (3 fragments)', () => lin({ height: 1 }, F(), circle(1, F(2))), { v: 1.299038082, min: [-0.5,-0.8660253882,0], max: [1,0.8660253882,1], n: 6, s1: 9, s2: 8.999999892 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { circle(r=1, $fn=0, $fa=1, $fs=0.01); }
    ['circle r=1 $fa=1 $fs=0.01 (360 fragments)', () => lin({ height: 1 }, F(), circle(1, F(0, 1, 0.01))), { v: 3.141433166, min: [-1,-1,0], max: [1,1,1], n: 720, s1: 1080, s2: 1080.000002 }],
    // polyhedron([[0,0,0],[1,0,0],[0,1,0],[0,0,1]], [[0,1,2],[0,3,1],[0,2,3],[1,3,2]]);
    ['polyhedron tetrahedron', () => polyhedron([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]), { v: 0.1666666667, min: [0,0,0], max: [1,1,1], n: 4, s1: 6, s2: 3 }],
    // polyhedron([[0,0,0],[10,0,0],[10,7,0],[0,7,0],[0,0,5],[10,0,5],[10,7,5],[0,7,5]], [[0,1,2,3],[4,5,1,0],[7,6,5,4],[5,6,2,1],[6,7,3,2],[7,4,0,3]]);
    ['polyhedron with quad faces', () => polyhedron([[0,0,0],[10,0,0],[10,7,0],[0,7,0],[0,0,5],[10,0,5],[10,7,5],[0,7,5]], [[0,1,2,3],[4,5,1,0],[7,6,5,4],[5,6,2,1],[6,7,3,2],[7,4,0,3]]), { v: 350, min: [0,0,0], max: [10,7,5], n: 8, s1: 156, s2: 696 }],
    // polyhedron([[0,0,0],[10,0,0],[10,10,0],[5,4,0],[0,10,0],[5,5,6]], [[0,1,2,3,4],[0,5,1],[1,5,2],[2,5,3],[3,5,4],[4,5,0]]);
    ['polyhedron non-convex face', () => polyhedron([[0,0,0],[10,0,0],[10,10,0],[5,4,0],[0,10,0],[5,5,6]], [[0,1,2,3,4],[0,5,1],[1,5,2],[2,5,3],[3,5,4],[4,5,0]]), { v: 140, min: [0,0,0], max: [10,10,6], n: 6, s1: 106, s2: 527 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { polygon([[0,0],[5,0],[10,0],[10,10],[0,10]]); }
    ['polygon drops collinear points', () => lin({ height: 1 }, F(), polygon([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]])), { v: 100, min: [0,0,0], max: [10,10,1], n: 8, s1: 132, s2: 804 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { polygon([[0,0],[10,0],[10,10],[0,10],[2,2],[8,2],[8,8],[2,8]], [[0,1,2,3],[4,5,6,7]]); }
    ['polygon with a hole path', () => lin({ height: 1 }, F(), polygon([[0,0],[10,0],[10,10],[0,10],[2,2],[8,2],[8,8],[2,8]], [[0,1,2,3],[4,5,6,7]])), { v: 64, min: [0,0,0], max: [10,10,1], n: 16, s1: 264, s2: 1352 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { polygon([[0,0],[10,0],[10,10],[0,10],[2,2],[8,2],[8,8],[2,8],[4,4],[6,4],[6,6],[4,6]], [[0,1,2,3],[4,5,6,7],[8,9,10,11]]); }
    ['polygon three nested paths (even-odd)', () => lin({ height: 1 }, F(), polygon([[0,0],[10,0],[10,10],[0,10],[2,2],[8,2],[8,8],[2,8],[4,4],[6,4],[6,6],[4,6]], [[0,1,2,3],[4,5,6,7],[8,9,10,11]])), { v: 68, min: [0,0,0], max: [10,10,1], n: 24, s1: 396, s2: 1772 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { polygon([[0,0],[10,0],[10,10],[0,10],[5,5],[15,5],[15,15],[5,15]], [[0,1,2,3],[4,5,6,7]]); }
    ['polygon overlapping paths (even-odd)', () => lin({ height: 1 }, F(), polygon([[0,0],[10,0],[10,10],[0,10],[5,5],[15,5],[15,15],[5,15]], [[0,1,2,3],[4,5,6,7]])), { v: 150, min: [0,0,0], max: [15,15,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { polygon([[10,0],[-8.090169943749473,5.877852522924733],[3.0901699437494736,-9.510565162951535],[3.0901699437494727,9.510565162951536],[-8.090169943749476,-5.87785252292473]]); }
    ['polygon self-intersecting star', () => lin({ height: 1 }, F(), polygon([[10, 0], [-8.090169943749473, 5.877852522924733], [3.0901699437494736, -9.510565162951535], [3.0901699437494727, 9.510565162951536], [-8.090169943749476, -5.87785252292473]])), { v: 77.56750892, min: [-8.090164185,-9.510559082,0], max: [10,9.510559082,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { polygon([[0,0],[10,0],[0,10],[10,10]]); }
    ['polygon bow tie', () => lin({ height: 1 }, F(), polygon([[0, 0], [10, 0], [0, 10], [10, 10]])), { v: 50, min: [0,0,0], max: [10,10,1] }],
  ],
  transforms: [
    // translate([1,2,3]) { cube([2,2,2], center=false); }
    ['translate', () => translate([1, 2, 3], cube(2)), { v: 8, min: [1,2,3], max: [3,4,5], n: 8, s1: 160, s2: 256 }],
    // rotate([30,40,50]) { cube([1,2,3], center=false); }
    ['rotate', () => rotate([30, 40, 50], cube([1, 2, 3])), { v: 6.000000567, min: [-0.9136520028,0,-0.6427876353], max: [2.714933157,2.507690191,2.756286383], n: 8, s1: 52.62862998, s2: 56.00000171 }],
    // scale([1,2,0.5]) { sphere(r=2, $fn=8, $fa=12, $fs=2); }
    ['scale', () => scale([1, 2, 0.5], sphere(2, F(8))), { v: 25.83236451, min: [-1.847759008,-3.695518017,-0.9238795042], max: [1.847759008,3.695518017,0.9238795042], n: 32, s1: 0, s2: 176.0000006 }],
    // mirror([1,1,0]) { translate([2,0,0]) { cube([1,2,3], center=false); } }
    ['mirror', () => mirror([1, 1, 0], translate([2, 0, 0], cube([1, 2, 3]))), { v: 6, min: [-2,-3,0], max: [0,-2,3], n: 8, s1: -12, s2: 104 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { rotate([0,0,30]) { square([3,1], center=false); } }
    ['2D rotate', () => lin({ height: 1 }, F(), rotate([0, 0, 30], square([3, 1]))), { v: 2.99999996, min: [-0.5,0,0], max: [2.598076105,2.366025448,1], n: 8, s1: 39.32050776, s2: 43.99999837 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { rotate([0,180,0]) { square([10,10], center=false); } }
    ['2D rotate about y by 180 (mirrors)', () => lin({ height: 1 }, F(), rotate([0, 180, 0], square(10))), { v: 100, min: [-10,0,0], max: [0,10,1], n: 8, s1: 52, s2: 804 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { mirror([1,0,0]) { translate([1,0,0]) { circle(r=2, $fn=5, $fa=12, $fs=2); } } }
    ['2D mirror', () => lin({ height: 1 }, F(), mirror([1, 0, 0], translate([1, 0, 0], circle(2, F(5))))), { v: 9.510479304, min: [-3,-1.902099609,0], max: [0.6180267334,1.902099609,1] }],
    // resize([10,0,0], auto=[true,true,true]) { cube([1,2,3], center=false); }
    ['resize auto', () => resize([10, 0, 0], [true, true, true], cube([1, 2, 3])), { v: 6000, min: [0,0,0], max: [10,20,30], n: 8, s1: 560, s2: 5600 }],
    // resize([0,0,10], auto=[true,false,false]) { cube([1,2,4], center=false); }
    ['resize partial auto', () => resize([0, 0, 10], [true, false, false], cube([1, 2, 4])), { v: 50, min: [0,0,0], max: [2.5,2,10], n: 8, s1: 146, s2: 441 }],
    // resize([10,10,0], auto=[true,true,true]) { cube([1,2,3], center=false); }
    ['resize ties take the first axis', () => resize([10, 10, 0], [true, true, true], cube([1, 2, 3])), { v: 3000, min: [0,0,0], max: [10,10,30], n: 8, s1: 480, s2: 4400 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { resize([0,30,10], auto=[true,true,true]) { square([1,2], center=false); } }
    ['resize 2D', () => lin({ height: 1 }, F(), resize([0, 30, 10], [true, true, true], square([1, 2]))), { v: 450, min: [0,0,0], max: [15,30,1], n: 8, s1: 312, s2: 4504 }],
  ],
  booleans: [
    // union() { cube([10,10,10], center=false); translate([5,5,5]) { cube([10,10,10], center=false); } }
    ['union', () => op('union', cube(10), translate([5, 5, 5], cube(10))), { v: 1875, min: [0,0,0], max: [15,15,15] }],
    // difference() { cube([10,10,10], center=true); cylinder(h=12, r1=3, r2=3, center=true, $fn=24, $fa=12, $fs=2); }
    ['difference', () => op('difference', cube(10, true), cyl(12, 3, 3, true, F(24))), { v: 720.4755324, min: [-5,-5,-5], max: [5,5,5] }],
    // difference() { cube([10,10,10], center=false); translate([5,5,-1]) { cylinder(h=12, r1=3, r2=3, center=false, $fn=16, $fa=12, $fs=2); } translate([-1,-1,8]) { cube([4,4,4], center=false); } }
    ['difference, several cutters', () => op('difference', cube(10), translate([5, 5, -1], cyl(12, 3, 3, false, F(16))), translate([-1, -1, 8], cube(4))), { v: 706.5170747, min: [0,0,0], max: [10,10,10] }],
    // intersection() { cube([10,10,10], center=true); sphere(r=6.5, $fn=24, $fa=12, $fs=2); }
    ['intersection', () => op('intersection', cube(10, true), sphere(6.5, F(24))), { v: 885.2061829, min: [-5,-5,-5], max: [5,5,5] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { union() { square([10,10], center=false); translate([5,5]) { circle(r=5, $fn=16, $fa=12, $fs=2); } } }
    ['2D union', () => lin({ height: 1 }, F(), op('union', square(10), translate([5, 5], circle(5, F(16))))), { v: 100, min: [0,0,0], max: [10,10,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { difference() { square([10,10], center=false); translate([5,5]) { circle(r=3, $fn=16, $fa=12, $fs=2); } translate([-1,-1]) { square([3,3], center=false); } } }
    ['2D difference', () => lin({ height: 1 }, F(), op('difference', square(10), translate([5, 5], circle(3, F(16))), translate([-1, -1], square(3)))), { v: 68.44678335, min: [0,0,0], max: [10,10,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { intersection() { square([10,10], center=false); translate([5,5]) { circle(r=6, $fn=16, $fa=12, $fs=2); } } }
    ['2D intersection', () => lin({ height: 1 }, F(), op('intersection', square(10), translate([5, 5], circle(6, F(16))))), { v: 94.27182306, min: [0,0,0], max: [10,10,1] }],
    // hull() { cube([1,1,1], center=false); translate([5,5,5]) { sphere(r=1, $fn=8, $fa=12, $fs=2); } }
    ['hull 3D', () => op('hull', cube(1), translate([5, 5, 5], sphere(1, F(8)))), { v: 19.79200234, min: [0,0,0], max: [5.923879623,5.923879623,5.923879623] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { hull() { square([10,10], center=false); translate([20,0]) { circle(r=1, $fn=8, $fa=12, $fs=2); } } }
    ['hull 2D', () => lin({ height: 1 }, F(), op('hull', square(10), translate([20, 0], circle(1, F(8))))), { v: 168.1317321, min: [0,-1,0], max: [21,10,1], n: 14, s1: 281.8284302, s2: 4008.137211 }],
    // minkowski() { cube([10,10,10], center=false); sphere(r=1, $fn=8, $fa=12, $fs=2); }
    ['minkowski convex', () => op('minkowski', cube(10), sphere(1, F(8))), { v: 1638.266767, min: [-0.9238786697,-0.9238786697,-0.9238786697], max: [10.92387867,10.92387867,10.92387867] }],
    // minkowski() { difference() { cube([10,10,10], center=false); translate([5,5,-1]) { cube([10,10,10], center=false); } } sphere(r=1, $fn=8, $fa=12, $fs=2); }
    ['minkowski non-convex', () => op('minkowski', op('difference', cube(10), translate([5, 5, -1], cube(10))), sphere(1, F(8))), { v: 1409.576461, min: [-0.9238786697,-0.9238786697,-0.9238786697], max: [10.92387867,10.92387867,10.92387867] }],
    // minkowski() { difference() { cube([10,10,10], center=false); translate([5,5,-1]) { cube([10,10,10], center=false); } } difference() { cube([2,2,2], center=true); cube([1,1,3], center=true); } }
    ['minkowski both non-convex', () => op('minkowski', op('difference', cube(10), translate([5, 5, -1], cube(10))), op('difference', cube(2, true), cube([1, 1, 3], true))), { v: 1503, min: [-1,-1,-1], max: [11,11,11] }],
    // minkowski() { cube([4,4,4], center=false); sphere(r=1, $fn=6, $fa=12, $fs=2); cylinder(h=1, r1=1, r2=1, center=false, $fn=5, $fa=12, $fs=2); }
    ['minkowski of three', () => op('minkowski', cube(4), sphere(1, F(6)), cyl(1, 1, 1, false, F(5))), { v: 368.7226418, min: [-1.809016228,-1.817081451,-0.866024971], max: [6,5.817081451,5.866024971] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { minkowski() { square([10,10], center=false); circle(r=1, $fn=8, $fa=12, $fs=2); } }
    ['minkowski 2D', () => lin({ height: 1 }, F(), op('minkowski', square(10), circle(1, F(8)))), { v: 142.8283691, min: [-1,-1,0], max: [11,11,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { minkowski() { difference() { square([10,10], center=false); translate([5,5]) { square([10,10], center=false); } } circle(r=1, $fn=8, $fa=12, $fs=2); } }
    ['minkowski 2D non-convex', () => lin({ height: 1 }, F(), op('minkowski', op('difference', square(10), translate([5, 5], square(10))), circle(1, F(8)))), { v: 117.5354614, min: [-1,-1,0], max: [11,11,1] }],
  ],
  offset: [
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(r=1, $fn=8, $fa=12, $fs=2) { square([10,10], center=false); } }
    ['r, $fn=8', () => lin({ height: 1 }, F(), offset({ r: 1 }, F(8), square(10))), { v: 142.8284302, min: [-1,-1,0], max: [11,11,1], n: 24, s1: 396, s2: 2709.137224 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(r=1, $fn=6, $fa=12, $fs=2) { square([10,10], center=false); } }
    ['r, $fn=6 (one step per corner, as the binary rounds it)', () => lin({ height: 1 }, F(), offset({ r: 1 }, F(6), square(10))), { v: 142, min: [-1,-1,0], max: [11,11,1], n: 16, s1: 264, s2: 1784 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(r=1, $fn=0, $fa=12, $fs=2) { square([10,10], center=false); } }
    ['r, defaults', () => lin({ height: 1 }, F(), offset({ r: 1 }, F(), square(10))), { v: 142, min: [-1,-1,0], max: [11,11,1], n: 16, s1: 264, s2: 1784 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(r=1, $fn=16, $fa=12, $fs=2) { circle(r=5, $fn=6, $fa=12, $fs=2); } }
    ['r on a hexagon, $fn=16', () => lin({ height: 1 }, F(), offset({ r: 1 }, F(16), circle(5, F(6)))), { v: 98.02444628, min: [-5.991439819,-5.330123901,0], max: [5.991439819,5.330123901,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(r=-1, $fn=8, $fa=12, $fs=2) { square([10,10], center=false); } }
    ['negative r', () => lin({ height: 1 }, F(), offset({ r: -1 }, F(8), square(10))), { v: 64, min: [1,1,0], max: [9,9,1], n: 8, s1: 132, s2: 660 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(delta=1, chamfer=false, $fn=0, $fa=12, $fs=2) { square([10,10], center=false); } }
    ['delta', () => lin({ height: 1 }, F(), offset({ delta: 1 }, F(), square(10))), { v: 144, min: [-1,-1,0], max: [11,11,1], n: 8, s1: 132, s2: 980 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(delta=1, chamfer=true, $fn=0, $fa=12, $fs=2) { square([10,10], center=false); } }
    ['delta chamfer', () => lin({ height: 1 }, F(), offset({ delta: 1, chamfer: true }, F(), square(10))), { v: 143.3137121, min: [-1,-1,0], max: [11,11,1], n: 16, s1: 264, s2: 1853.0196 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(r=2, $fn=0, $fa=12, $fs=0.5) { polygon([[0,0],[10,0],[10,3],[3,3],[3,10],[0,10]]); } }
    ['r on an L', () => lin({ height: 1 }, F(), offset({ r: 2 }, F(0, 12, 0.5), polygon([[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]]))), { v: 142.5117878, min: [-2,-2,0], max: [12,12,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(r=-1, $fn=0, $fa=12, $fs=0.5) { polygon([[0,0],[10,0],[10,3],[3,3],[3,10],[0,10]]); } }
    ['negative r on an L', () => lin({ height: 1 }, F(), offset({ r: -1 }, F(0, 12, 0.5), polygon([[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]]))), { v: 15.25124554, min: [1,1,0], max: [9,9,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(delta=1, chamfer=false, $fn=0, $fa=12, $fs=2) { difference() { square([20,20], center=false); translate([5,5]) { square([10,10], center=false); } } } }
    ['delta around a hole', () => lin({ height: 1 }, F(), offset({ delta: 1 }, F(), op('difference', square(20), translate([5, 5], square(10))))), { v: 420, min: [-1,-1,0], max: [21,21,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(r=-1, $fn=10, $fa=12, $fs=2) { difference() { square([20,20], center=false); translate([5,5]) { square([10,10], center=false); } } } }
    ['negative r around a hole', () => lin({ height: 1 }, F(), offset({ r: -1 }, F(10), op('difference', square(20), translate([5, 5], square(10))))), { v: 181.2063904, min: [1,1,0], max: [19,19,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { offset(r=2, $fn=10, $fa=12, $fs=2) { { square([5,5], center=false); translate([7,0]) { square([5,5], center=false); } } } }
    ['r merges shapes', () => lin({ height: 1 }, F(), offset({ r: 2 }, F(10), op('group', square(5), translate([7, 0], square(5))))), { v: 138.3796109, min: [-2,-2,0], max: [14,7,1] }],
    // steps × corner angle exactly k + ½: OpenSCAD's grid decides the rounding (one arc step more or less per corner)
    // linear_extrude(1) offset(r = 2, $fn = 12) circle(4, $fn = 8);   (45° corners, 1.5 steps → 1)
    ['r, 1.5 steps per corner', () => lin({ height: 1 }, F(), offset({ r: 2 }, F(12), circle(4, F(8)))), { v: 105.965309, min: [-5.98289,-5.98289,0], max: [5.98289,5.98289,1] }],
    // linear_extrude(1) offset(r = 2, $fn = 30) circle(4, $fn = 12);   (30° corners, 2.5 steps → 3)
    ['r, 2.5 steps per corner', () => lin({ height: 1 }, F(), offset({ r: 2 }, F(30), circle(4, F(12)))), { v: 110.126854, min: [-5.99725,-5.99725,0], max: [5.99725,5.99725,1] }],
    // linear_extrude(1) offset(r = 0.5, $fn = 12) circle(4, $fn = 8);
    ['small r, 1.5 steps per corner', () => lin({ height: 1 }, F(), offset({ r: 0.5 }, F(12), circle(4, F(8)))), { v: 58.233555, min: [-4.49573,-4.49573,0], max: [4.49573,4.49573,1] }],
  ],
  extrusions: [
    // linear_extrude(height=5, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { circle(r=3, $fn=7, $fa=12, $fs=2); }
    ['linear', () => lin({ height: 5 }, F(), circle(3, F(7))), { v: 123.1384598, min: [-2.702906609,-2.924783707,0], max: [3,2.924783707,5], n: 14, s1: 105.0000002, s2: 301.0000014 }],
    // linear_extrude(height=5, center=true, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { square([2,3], center=false); }
    ['linear centred', () => lin({ height: 5, center: true }, F(), square([2, 3])), { v: 30, min: [0,0,-2.5], max: [2,3,2.5], n: 8, s1: 32, s2: 102 }],
    // linear_extrude(height=10, center=false, twist=90, scale=[1,1], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['twist 90 (8 slices)', () => lin({ height: 10, twist: 90 }, F(), square(5)), { v: 264.6563015, min: [0,-5,0], max: [7.07106781,5,10], n: 36, s1: 651.5317039, s2: 2175.000004 }],
    // linear_extrude(height=10, center=false, twist=-90, scale=[1,1], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['twist -90', () => lin({ height: 10, twist: -90 }, F(), square(5)), { v: 264.6563015, min: [-5,0,0], max: [5,7.07106781,10], n: 36, s1: 763.0634079, s2: 2175.000004 }],
    // linear_extrude(height=10, center=false, twist=360, scale=[1,1], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['twist 360 (23 slices)', () => lin({ height: 10, twist: 360 }, F(), square(5)), { v: 269.3928404, min: [-7.033996105,-7.033996105,0], max: [7.066945553,7.066945553,10], n: 96, s1: 1469.999998, s2: 5669.565229 }],
    // linear_extrude(height=10, center=false, twist=720, scale=[1,1], $fn=9, $fa=12, $fs=2) { translate([2,0]) { square([3,3], center=false); } }
    ['twist 720, $fn=9, off-centre', () => lin({ height: 10, twist: 720 }, F(9), translate([2, 0], square(3))), { v: 92.62315042, min: [-5.724523544,-5.830127239,0], max: [5.758584976,5.512071609,10], n: 76, s1: 1166.000001, s2: 4047.703735 }],
    // linear_extrude(height=10, center=false, twist=120, scale=[1,1], $fn=0, $fa=12, $fs=2) { difference() { square([10,10], center=true); square([4,4], center=true); } }
    ['twist with a hole', () => lin({ height: 10, twist: 120 }, F(), op('difference', square(10, true), square(4, true))), { v: 897.0250226, min: [-7.044160366,-7.044160366,0], max: [7.044160366,7.044160366,10], n: 80, s1: 1200.000006, s2: 5134.814868 }],
    // linear_extrude(height=10, center=false, twist=0, scale=[0.5,0.5], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['scale', () => lin({ height: 10, scale: 0.5 }, F(), square(5)), { v: 145.8333333, min: [0,0,0], max: [5,5,10], n: 8, s1: 165, s2: 525 }],
    // linear_extrude(height=10, center=false, twist=0, scale=[0.5,1], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['scale vector (6 slices)', () => lin({ height: 10, scale: [0.5, 1] }, F(), square(5)), { v: 187.4999988, min: [0,0,0], max: [5,5,10], n: 28, s1: 612.4999928, s2: 1567.708301 }],
    // linear_extrude(height=10, center=false, twist=0, scale=[0,0], $fn=0, $fa=12, $fs=2) { circle(r=4, $fn=6, $fa=12, $fs=2); }
    ['scale 0 (apex)', () => lin({ height: 10, scale: 0 }, F(), circle(4, F(6))), { v: 138.5640621, min: [-4,-3.464101553,0], max: [4,3.464101553,10], n: 7, s1: 30, s2: 195.9999983 }],
    // linear_extrude(height=10, center=false, twist=360, scale=[0.5,0.5], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['scale and twist (18 slices)', () => lin({ height: 10, scale: 0.5, twist: 360 }, F(), square(5)), { v: 151.2123429, min: [-4.891777992,-5.691772461,0], max: [6.652818203,5,10], n: 76, s1: 1148.321798, s2: 3716.435208 }],
    // linear_extrude(height=10, center=false, twist=360, scale=[4,4], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['scale 4 and twist (16 slices)', () => lin({ height: 10, scale: 4, twist: 360 }, F(), square(5)), { v: 1817.099899, min: [-20.32932091,-15.10713387,0], max: [20,25.63262177,10], n: 68, s1: 1170.410097, s2: 14396.87514 }],
    // linear_extrude(height=10, center=false, twist=90, scale=[0,0], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['scale 0 and twist', () => lin({ height: 10, scale: 0, twist: 90 }, F(), square(5)), { v: 85.62453399, min: [0,-1.781399488,0], max: [5.131923676,5,10], n: 29, s1: 474.5808876, s2: 1128.571413 }],
    // linear_extrude(height=10, center=false, twist=360, scale=[1.5,0.5], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['non-uniform scale and twist', () => lin({ height: 10, scale: [1.5, 0.5], twist: 360 }, F(), square(5)), { v: 235.0228124, min: [-9.240507126,-5.756381512,0], max: [7.527833462,5,10], n: 96, s1: 1412.933442, s2: 5784.686885 }],
    // linear_extrude(height=10, center=false, twist=0, slices=7, scale=[1,1], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['slices 7', () => lin({ height: 10, slices: 7 }, F(), square(5)), { v: 250, min: [0,0,0], max: [5,5,10], n: 32, s1: 719.9999971, s2: 1942.857124 }],
    // linear_extrude(height=10, center=false, twist=90, slices=2.5, scale=[1,1], $fn=0, $fa=12, $fs=2) { square([5,5], center=false); }
    ['slices 2.5 → 2', () => lin({ height: 10, slices: 2.5, twist: 90 }, F(), square(5)), { v: 284.5177968, min: [0,-5,0], max: [7.07106781,5,10], n: 12, s1: 214.1421356, s2: 799.9999999 }],
    // linear_extrude(height=10, center=false, twist=0, scale=[0.5,1], $fn=0, $fa=12, $fs=0.1) { square([5,5], center=false); }
    ['scale vector, $fs=0.1 (104 slices)', () => lin({ height: 10, scale: [0.5, 1] }, F(0, 12, 0.1), square(5)), { v: 187.5000001, min: [0,0,0], max: [5,5,10], n: 420, s1: 9187.500007, s2: 22381.91108 }],
    // rotate_extrude(angle=360, $fn=4, $fa=12, $fs=2) { translate([5,0]) { square([1,1], center=false); } }
    ['rotate_extrude $fn=4', () => rot(360, F(4), translate([5, 0], square(1))), { v: 22, min: [-6,-6,0], max: [6,6,1], n: 16, s1: 24, s2: 496 }],
    // rotate_extrude(angle=360, $fn=0, $fa=12, $fs=2) { translate([5,0]) { square([1,1], center=false); } }
    ['rotate_extrude defaults (starts on -X)', () => rot(360, F(), translate([5, 0], square(1))), { v: 33.93109016, min: [-6,-5.979506969,0], max: [5.918167591,5.979506969,1], n: 76, s1: 113.9999982, s2: 2355.999997 }],
    // rotate_extrude(angle=360, $fn=5, $fa=12, $fs=2) { translate([-6,0]) { square([1,1], center=false); } }
    ['rotate_extrude, profile at negative x', () => rot(360, F(5), translate([-6, 0], square(1))), { v: 26.15405531, min: [-4.854102135,-5.706338882,0], max: [6,5.706338882,1], n: 20, s1: 29.99999952, s2: 619.9999874 }],
    // rotate_extrude(angle=90, $fn=0, $fa=12, $fs=0.5) { translate([5,0]) { square([1,1], center=false); } }
    ['rotate_extrude angle 90', () => rot(90, F(0, 12, 0.5), translate([5, 0], square(1))), { v: 8.567056357, min: [0,0,0], max: [6,6,1], n: 32, s1: 373.8831017, s2: 992.0000037 }],
    // rotate_extrude(angle=-90, $fn=0, $fa=12, $fs=0.5) { translate([5,0]) { square([1,1], center=false); } }
    ['rotate_extrude angle -90', () => rot(-90, F(0, 12, 0.5), translate([5, 0], square(1))), { v: 8.567056357, min: [0,-6,0], max: [6,0,1], n: 32, s1: -60.62770057, s2: 992.0000037 }],
    // rotate_extrude(angle=400, $fn=0, $fa=12, $fs=0.5) { translate([5,0]) { square([1,1], center=false); } }
    ['rotate_extrude angle 400 = 360', () => rot(400, F(0, 12, 0.5), translate([5, 0], square(1))), { v: 34.30542697, min: [-6,-5.967131138,0], max: [6,5.967131138,1], n: 120, s1: 180, s2: 3719.999955 }],
    // rotate_extrude(angle=10, $fn=0, $fa=12, $fs=2) { translate([5,0]) { square([1,1], center=false); } }
    ['rotate_extrude angle 10 (one segment)', () => rot(10, F(), translate([5, 0], square(1))), { v: 0.955064858, min: [4.924038887,0,0], max: [6,1.041889071,1], n: 8, s1: 63.30629039, s2: 247.9999991 }],
    // rotate_extrude(angle=360, $fn=8, $fa=12, $fs=2) { translate([3,0]) { circle(r=1, $fn=8, $fa=12, $fs=2); } }
    ['rotate_extrude torus', () => rot(360, F(8), translate([3, 0], circle(1, F(8)))), { v: 47.99999832, min: [-4,-4,-1], max: [4,4,1], n: 64, s1: 0, s2: 639.9999844 }],
    // rotate_extrude(angle=360, $fn=0, $fa=12, $fs=2) { square([1,1], center=false); }
    ['rotate_extrude touching the axis', () => rot(360, F(), square(1)), { v: 2.377641342, min: [-1,-0.95105654,0], max: [0.8090170026,0.95105654,1], n: 12, s1: 18, s2: 16.00000021 }],
    // rotate_extrude(angle=180, $fn=0, $fa=12, $fs=2) { translate([-3,0]) { circle(r=1, $fn=0, $fa=12, $fs=2); } }
    ['rotate_extrude 180 at negative x', () => rot(180, F(), translate([-3, 0], circle(1))), { v: 21.39877253, min: [-3.809016943,-3.809016943,-0.95105654], max: [3.809016943,0,0.95105654], n: 35, s1: -111.9615245, s2: 350.0000024 }],
    // rotate_extrude(angle=270, $fn=12, $fa=12, $fs=2) { translate([5,0]) { difference() { square([10,10], center=true); square([4,4], center=true); } } }
    ['rotate_extrude 270 with a hole', () => rot(270, F(12), translate([5, 0], op('difference', square(10, true), square(4, true)))), { v: 1890.000123, min: [-10,-10,-5], max: [10,10,5] }],
  ],
  projection: [
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { projection(cut=false) { sphere(r=10, $fn=8, $fa=12, $fs=2); } }
    ['shadow of a sphere', () => lin({ height: 1 }, F(), projection(false, sphere(10, F(8)))), { v: 241.4207695, min: [-9.23878479,-9.23878479,0], max: [9.23878479,9.23878479,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { projection(cut=false) { rotate([30,40,0]) { cube([10,10,10], center=false); } } }
    ['shadow of a rotated cube', () => lin({ height: 1 }, F(), projection(false, rotate([30, 40, 0], cube(10)))), { v: 168.9223065, min: [0,-5,0], max: [16.44108582,8.660247803,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { projection(cut=false) { rotate([20,30,0]) { difference() { cube([10,10,10], center=true); cylinder(h=20, r1=3, r2=3, center=true, $fn=12, $fa=12, $fs=2); } } } }
    ['shadow of a non-convex solid', () => lin({ height: 1 }, F(), projection(false, rotate([20, 30, 0], op('difference', cube(10, true), cyl(20, 3, 3, true, F(12)))))), { v: 160.9991789, min: [-7.534408569,-6.408554077,0], max: [7.534408569,6.408554077,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { projection(cut=true) { cube([10,10,10], center=false); } }
    ['cut through a cube standing on z = 0', () => lin({ height: 1 }, F(), projection(true, cube(10))), { v: 100, min: [0,0,0], max: [10,10,1], n: 8, s1: 132, s2: 804 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { projection(cut=true) { translate([0,0,-10]) { cube([10,10,10], center=false); } } }
    ['cut through a cube hanging below z = 0', () => lin({ height: 1 }, F(), projection(true, translate([0, 0, -10], cube(10)))), { v: 100, min: [0,0,0], max: [10,10,1], n: 8, s1: 132, s2: 804 }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { projection(cut=true) { translate([0,0,-5]) { sphere(r=10, $fn=8, $fa=12, $fs=2); } } }
    ['cut through a sphere', () => lin({ height: 1 }, F(), projection(true, translate([0, 0, -5], sphere(10, F(8))))), { v: 184.0015709, min: [-8.065629959,-8.065629959,0], max: [8.065629959,8.065629959,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { projection(cut=true) { rotate([30,40,0]) { cube([10,10,10], center=true); } } }
    ['cut through a rotated cube', () => lin({ height: 1 }, F(), projection(true, rotate([30, 40, 0], cube(10, true)))), { v: 130.6338526, min: [-6.527036667,-6.830126762,0], max: [6.527036667,6.830126762,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { projection(cut=true) { union() { translate([0,0,-5]) { cube([10,10,10], center=false); } translate([10,0,0]) { cube([10,10,5], center=false); } } } }
    ['cut through a step', () => lin({ height: 1 }, F(), projection(true, op('union', translate([0, 0, -5], cube([10, 10, 10])), translate([10, 0, 0], cube([10, 10, 5]))))), { v: 200, min: [0,0,0], max: [20,10,1] }],
    // linear_extrude(height=1, center=false, twist=0, scale=[1,1], $fn=0, $fa=12, $fs=2) { projection(cut=true) { difference() { cube([10,10,10], center=true); cylinder(h=20, r1=3, r2=3, center=true, $fn=12, $fa=12, $fs=2); } } }
    ['cut through a hole', () => lin({ height: 1 }, F(), projection(true, op('difference', cube(10, true), cyl(20, 3, 3, true, F(12))))), { v: 73.00000358, min: [-5,-5,0], max: [5,5,1] }],
  ],
}

for (const [group, rows] of Object.entries(REF)) {
  describe(`matches OpenSCAD 2021.01: ${group}`, () => {
    test.each(rows)('%s', (_name, node, ref) => check(node(), ref))
  })
}
