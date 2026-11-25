// The OpenSCAD builder's rules: fragment and slice counts, dimensions and OpenSCAD's warnings, lazy union and
// colours, part(), the geometry budget and errors. Counts and warning texts were recorded from the openscad binary
// (2021.01) on our own snippets.
import { describe, expect, test } from 'vitest'
import jscad from '@jscad/modeling'
import type { Geom3 } from '@jscad/modeling/src/geometries/types'
import { build, buildScad, HARD_LIMIT, WARN_2D_TOP, WARN_INSIDE_OUT } from '../../src/openscad/build'
import { linearSlices } from '../../src/openscad/build-extrude'
import { evenOdd, regionArea, union2, difference2, intersection2, pointInLoop } from '../../src/openscad/build-2d'
import { triangulateRegion } from '../../src/openscad/build-tri'
import { clampFragments, fragments } from '../../src/openscad/tess'
import { TEXT_WARNING } from '../../src/openscad/text'
import { ScadError, type BuildContext, type Fragments, type GeomNode, type Rgba, type Vec2, type Vec3 } from '../../src/openscad/types'

const F = (fn = 0, fa = 12, fs = 2): Fragments => ({ fn, fa, fs })
const cube = (s: number | Vec3, center = false): GeomNode => ({ kind: 'cube', size: typeof s === 'number' ? [s, s, s] : s, center })
const sphere = (r: number, frag = F()): GeomNode => ({ kind: 'sphere', r, frag })
const cyl = (h: number, r: number, frag = F()): GeomNode => ({ kind: 'cylinder', h, r1: r, r2: r, center: false, frag })
const square = (s: number | Vec2, center = false): GeomNode => ({ kind: 'square', size: typeof s === 'number' ? [s, s] : s, center })
const circle = (r: number, frag = F()): GeomNode => ({ kind: 'circle', r, frag })
const translate = (t: number[], ...children: GeomNode[]): GeomNode =>
  ({ kind: 'multmatrix', m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2] ?? 0, 1], children })
const op = (kind: 'group' | 'union' | 'difference' | 'intersection' | 'hull' | 'minkowski', ...children: GeomNode[]): GeomNode => ({ kind, children })
const color = (rgba: Rgba, ...children: GeomNode[]): GeomNode => ({ kind: 'color', rgba, children })
const lin = (height: number, ...children: GeomNode[]): GeomNode =>
  ({ kind: 'linear_extrude', height, center: false, twist: 0, scale: [1, 1], frag: F(), children })
const at = (line: number) => ({ file: '', line, col: 1 })
const RED: Rgba = [1, 0, 0, 1], BLUE: Rgba = [0, 0, 1, 1]

function ctxOf(opts: { budget?: number; parts?: Record<string, Geom3[]> } = {}) {
  const c = {
    charged: 0,
    calls: [] as { n: number; what: string }[],
    partCalls: [] as unknown[][],
    resolvePart(name: string, overrides: Record<string, unknown>, pos?: unknown) {
      c.partCalls.push([name, overrides, pos])
      const g = opts.parts?.[name]
      if (!g) throw new Error(`no part ${name}`)
      return g
    },
    charge(n: number, what: string) {
      c.charged += n
      c.calls.push({ n, what })
      if (opts.budget !== undefined && c.charged > opts.budget) throw new ScadError('limit', `Too much geometry: ${what}`)
    },
  }
  return c satisfies BuildContext
}

const volume = (g: Geom3): number => jscad.measurements.measureVolume(g) as number
const zRange = (g: Geom3): [number, number] => { const b = jscad.measurements.measureBoundingBox(g); return [b[0][2], b[1][2]] }
const texts = (nodes: GeomNode[]) => buildScad(nodes, ctxOf()).messages.map((m) => m.text)

describe('fragments ($fn, $fa, $fs)', () => {
  test.each([
    // r, $fn, $fa, $fs → fragments (from the binary's vertex counts)
    [1, 0, 12, 2, 5],
    [10, 0, 12, 2, 30],
    [1e-7, 0, 12, 2, 3],
    [1, 2, 12, 2, 3],
    [1, 3.9, 12, 2, 3],
    [1, 0, 1, 0.01, 360],
    [6, 0, 12, 2, 19],
    [6, 0, 12, 0.5, 30],
  ])('r=%s $fn=%s $fa=%s $fs=%s → %s', (r, fn, fa, fs, n) => {
    expect(fragments(r, F(fn, fa, fs))).toBe(n)
  })

  test('$fa / $fs below 0.01 are clamped with OpenSCAD\'s warnings', () => {
    const warnings: string[] = []
    const f = clampFragments(F(0, 0, 0), (m) => warnings.push(m))
    expect(f).toEqual(F(0, 0.01, 0.01))
    expect(fragments(1, f)).toBe(629)
    expect(warnings).toEqual(['$fs too small - clamping to 0.010000', '$fa too small - clamping to 0.010000'])
    expect(texts([circle(1, F(0, 12, 0.001))])).toContain('$fs too small - clamping to 0.010000')
  })
})

describe('linear_extrude default slices (recorded from the binary)', () => {
  const sq = (s: number): [number, number][][] => [[[0, 0], [s, 0], [s, s], [0, s]]]
  const moved: [number, number][][] = [[[20, 0], [21, 0], [21, 1], [20, 1]]]
  const circle5: [number, number][][] = [[0, 72, 144, 216, 288].map((a) => [Math.cos((a * Math.PI) / 180), Math.sin((a * Math.PI) / 180)])]
  const L = (r: [number, number][][], o: { h?: number; twist?: number; scale?: number | Vec2; slices?: number; frag?: Fragments }) =>
    linearSlices(r, { height: o.h ?? 10, center: false, twist: o.twist ?? 0, slices: o.slices, scale: typeof o.scale === 'number' ? [o.scale, o.scale] : o.scale ?? [1, 1], frag: o.frag ?? F() })
  test('twist: min($fa angle steps, helix length / $fs), at least 3 per turn', () => {
    const twists = [10, 30, 45, 60, 90, 120, 180, 270, 360, 720]
    expect(twists.map((t) => L(sq(5), { twist: t }))).toEqual([1, 3, 4, 5, 8, 9, 13, 18, 23, 45])
    expect([30, 90, 180, 360].map((t) => L(sq(1), { twist: t }))).toEqual([3, 6, 6, 7])
    expect([30, 90, 180, 360].map((t) => L(moved, { twist: t }))).toEqual([3, 8, 15, 30])
    expect([90, 360].map((t) => L(sq(5), { twist: t, frag: F(0, 6) }))).toEqual([8, 23])
    expect([90, 360].map((t) => L(sq(5), { twist: t, frag: F(0, 12, 1) }))).toEqual([8, 30])
    expect([90, 360].map((t) => L(sq(5), { twist: t, frag: F(7) }))).toEqual([2, 7])
    expect([90, 360].map((t) => L(circle5, { twist: t }))).toEqual([6, 6])
    expect([360, 720, 180, 100].map((t) => L(sq(0.1), { h: 0.1, twist: t }))).toEqual([3, 6, 2, 1])
  })
  test('twist with a uniform scale: conical spiral length (scale s > 1 counts as 1/s)', () => {
    expect(L(sq(5), { twist: 360, scale: 0.5 })).toBe(18)
    expect(L(sq(5), { twist: 360, scale: 2 })).toBe(18)
    expect(L(sq(5), { twist: 90, scale: 0.5 })).toBe(7)
    expect(L(sq(5), { twist: 90, scale: 0 })).toBe(7)
    expect(L(sq(5), { twist: 360, scale: 0 })).toBe(13)
    expect(L(sq(5), { h: 1, twist: 360, scale: 0.5 })).toBe(17)
    expect(L(sq(5), { twist: 360, scale: 0.5, frag: F(0, 12, 0.5) })).toBe(30)
    expect(L(sq(5), { twist: 360, scale: 0.5, frag: F(9) })).toBe(9)
    expect(L(sq(5), { twist: 360, scale: 0.5, frag: F(0, 40) })).toBe(9)
    expect([4, 0.25, 0.9, 1.1].map((s) => L(sq(5), { twist: 360, scale: s }))).toEqual([16, 16, 22, 22])
  })
  test('twist with a non-uniform scale: the helix of the unscaled outline', () => {
    expect(L(sq(5), { twist: 360, scale: [0.5, 1] })).toBe(23)
    expect(L(sq(5), { twist: 90, scale: [0.5, 1] })).toBe(8)
    expect(L(sq(5), { twist: 360, scale: [2, 1] })).toBe(23)
    expect(L(sq(5), { twist: 360, scale: [0.5, 0.2] })).toBe(23)
    expect(L(sq(5), { twist: 360, scale: [0.5, 1], frag: F(9) })).toBe(9)
    expect(L(sq(5), { twist: 90, scale: [0.5, 1], frag: F(9) })).toBe(3)
    expect(L(sq(5), { twist: 360, scale: [0.5, 1], frag: F(0, 12, 0.1) })).toBe(30)
    expect(L(sq(5), { twist: 1, scale: [0.5, 1], frag: F(0, 12, 0.1) })).toBe(1)
  })
  test('non-uniform scale without twist: the longest diagonal / $fs', () => {
    expect(L(sq(5), { scale: [0.5, 1] })).toBe(6)
    expect(L(sq(5), { h: 20, scale: [0.5, 1] })).toBe(11)
    expect(L(sq(5), { scale: [0.5, 1], frag: F(0, 12, 1) })).toBe(11)
    expect(L(sq(5), { scale: [0.5, 1], frag: F(0, 12, 0.1) })).toBe(104)
    expect(L(sq(5), { scale: [0.5, 1], frag: F(0, 1) })).toBe(6)
    expect([10, 3, 2, 1].map((fn) => L(sq(5), { scale: [0.5, 1], frag: F(fn) }))).toEqual([10, 3, 2, 1])
    expect(L(sq(5), { scale: [0.1, 1] })).toBe(6)
    expect(L(sq(5), { h: 1, scale: [0.1, 1] })).toBe(3)
    expect(L(sq(50), { scale: [0.5, 1] })).toBe(14)
    expect(L(sq(0.1), { h: 0.1, scale: [0.5, 1] })).toBe(1)
  })
  test('explicit slices are truncated; below 1 means the default', () => {
    expect([0.5, 1.7, -3, 2.5, 7].map((s) => L(sq(5), { twist: 90, slices: s }))).toEqual([8, 1, 8, 2, 7])
    expect(L(sq(5), { scale: 0.5 })).toBe(1)
  })
})

describe('dimensions and OpenSCAD\'s warnings', () => {
  const MIX = 'Mixing 2D and 3D objects is not supported'
  test('an operation takes the dimension of its first child (texts as the binary prints them)', () => {
    expect(texts([op('union', cube(1), square(5))])).toEqual([MIX, 'Ignoring 2D child object for 3D operation'])
    expect(texts([lin(1, op('union', square(5), cube(1)))])).toEqual([MIX, 'Ignoring 3D child object for 2D operation'])
    expect(texts([lin(1, cube(1))])).toEqual(['Ignoring 3D child object for 2D operation'])
    // an ignored child is an empty operand: intersection with it is empty, difference keeps the first child
    expect(build([op('intersection', cube(1), square(5))], ctxOf()).geoms).toEqual([])
    expect(volume(build([op('difference', cube(1), square(5))], ctxOf()).geoms[0])).toBeCloseTo(1, 9)
    // an empty primitive still has a dimension (square(0) makes the union 2D)
    expect(texts([op('union', square(0), cube(1))])).toEqual([MIX, 'Ignoring 3D child object for 2D operation'])
  })

  test('top level: 3D wins, 2D next to it is dropped with a warning', () => {
    const out = buildScad([{ ...square(10), pos: at(1) }, { ...cube(2), pos: at(2) }], ctxOf())
    expect(out.geoms).toHaveLength(1)
    expect(volume(out.geoms[0])).toBeCloseTo(8, 9)
    expect(out.messages).toEqual([
      { level: 'warning', text: MIX, pos: at(1) },
      { level: 'warning', text: 'Ignoring 2D child object for 3D operation', pos: at(1) },
    ])
  })

  test('a 2D-only top level is shown 1 mm thick, centred on z = 0, like OpenSCAD\'s preview', () => {
    const out = build([square(10), translate([20, 0], circle(3, F(6)))], ctxOf())
    expect(out.warnings).toEqual([WARN_2D_TOP])
    expect(out.geoms).toHaveLength(1) // uncoloured pieces are unioned into one slab
    expect(zRange(out.geoms[0])).toEqual([-0.5, 0.5])
    expect(volume(out.geoms[0])).toBeCloseTo(100 + 1.5 * Math.sqrt(3) * 9, 6)
  })

  test('rotate_extrude across the Y axis: OpenSCAD\'s message, nothing built', () => {
    const out = buildScad([{ kind: 'rotate_extrude', angle: 360, frag: F(), children: [translate([-0.5, 0], square(1))], pos: at(3) }], ctxOf())
    expect(out.geoms).toEqual([])
    expect(out.messages).toEqual([{ level: 'warning', text: 'all points for rotate_extrude() must have the same X coordinate sign (range is -0.50 -> 0.50)', pos: at(3) }])
  })

  test('a 2D object squashed by a transform is removed with OpenSCAD\'s warning', () => {
    const flat: GeomNode = { kind: 'multmatrix', m: [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1], children: [square(10)] } // rotate([90, 0, 0])
    expect(texts([lin(1, flat)])).toEqual(['Scaling a 2D object with 0 - removing object'])
    const nan: GeomNode = { kind: 'multmatrix', m: [NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], children: [cube(1)] }
    expect(texts([nan])).toEqual(['Transformation matrix contains Not-a-Number and/or Infinity - removing object.'])
  })

  test('empty primitives build nothing', () => {
    const out = build([cube(0), cube([1, 0, 1]), sphere(0), cyl(0, 1), { kind: 'cylinder', h: 5, r1: 0, r2: 0, center: false, frag: F() }], ctxOf())
    expect(out.geoms).toEqual([])
    expect(out.warnings).toEqual([])
  })
})

describe('lazy union and colours', () => {
  test('top-level objects and groups stay separate pieces', () => {
    const out = build([cube(10), op('group', translate([5, 0, 0], cube(10)), translate([30, 0, 0], sphere(2)))], ctxOf())
    expect(out.geoms).toHaveLength(3)
  })
  test('union() is one solid per colour', () => {
    const same = build([op('union', color(RED, cube(10)), translate([5, 0, 0], color(RED, cube(10))))], ctxOf()).geoms
    expect(same).toHaveLength(1)
    expect(volume(same[0])).toBeCloseTo(1500, 6)
    expect(same[0].color).toEqual(RED)
    const mixed = build([op('union', color(RED, cube(10)), translate([5, 0, 0], color(BLUE, cube(10))))], ctxOf()).geoms
    expect(mixed.map((g) => g.color)).toEqual([RED, BLUE])
  })
  test('difference() keeps each piece of the first child with its colour', () => {
    const out = build([op('difference', op('group', color(RED, cube(10)), translate([12, 0, 0], color(BLUE, cube(10)))), translate([5, 5, -1], cyl(12, 3, F(16))))], ctxOf())
    expect(out.geoms.map((g) => g.color)).toEqual([RED, BLUE])
    expect(volume(out.geoms[0])).toBeLessThan(1000)
    expect(volume(out.geoms[1])).toBeCloseTo(1000, 6) // not touched by the cutter
  })
  test('the innermost color() wins; extrusions keep a shared colour', () => {
    const out = build([color(RED, cube(10), color(BLUE, translate([20, 0, 0], sphere(3))))], ctxOf())
    expect(out.geoms.map((g) => g.color)).toEqual([RED, BLUE])
    expect(build([lin(2, color(BLUE, square(3)))], ctxOf()).geoms[0].color).toEqual(BLUE)
    expect(build([op('hull', color(RED, cube(1)), color(BLUE, translate([3, 0, 0], cube(1))))], ctxOf()).geoms[0].color).toBeUndefined()
  })
})

describe('part()', () => {
  test('part nodes come from ctx.resolvePart, with the overrides and position', () => {
    const bolt = jscad.colors.colorize(RED, jscad.primitives.cuboid({ size: [2, 2, 2] }))
    const ctx = ctxOf({ parts: { Bolt: [bolt] } })
    const node: GeomNode = { kind: 'part', name: 'Bolt', overrides: { length: 20 }, pos: at(4) }
    const out = build([op('difference', node, cube(1))], ctx)
    expect(ctx.partCalls).toEqual([['Bolt', { length: 20 }, at(4)]])
    expect(out.geoms).toHaveLength(1)
    expect(volume(out.geoms[0])).toBeCloseTo(8 - 1, 6)
    expect(out.geoms[0].color).toEqual(RED)
  })
  test('resolvePart errors pass through unchanged', () => {
    const err = new Error('Cycle: A → B → A')
    const ctx = { resolvePart: () => { throw err }, charge: () => {} }
    expect(() => build([{ kind: 'part', name: 'B', overrides: {} }], ctx)).toThrow(err)
  })
})

describe('geometry budget and errors', () => {
  test('primitives are charged before they are created, and only once in total', () => {
    const ctx = ctxOf()
    build([sphere(10, F(8))], ctx)
    // estimate before (8 fragments × 4 rings + 2), nothing more after: the sphere has 8 × 3 + 2 polygons
    expect(ctx.calls).toEqual([{ n: 34, what: 'sphere() with $fn = 8' }])
  })
  test('cylinder($fn = 1e7) is refused before it allocates, naming $fn', () => {
    const ctx = ctxOf({ budget: 2_000_000 })
    let e: unknown
    try { build([{ ...cyl(1, 1, F(1e7)), pos: at(7) }], ctx) } catch (x) { e = x }
    expect(e).toBeInstanceOf(ScadError)
    expect((e as ScadError).kind).toBe('limit')
    expect((e as ScadError).message).toContain('$fn = 10000000')
  })
  test('one operation above the hard limit is refused even when the context allows it', () => {
    let e: unknown
    try { build([{ ...sphere(1, F(1e5)), pos: at(2) }], ctxOf()) } catch (x) { e = x }
    expect(e).toBeInstanceOf(ScadError)
    expect((e as ScadError).kind).toBe('limit')
    expect((e as ScadError).message).toMatch(/sphere\(\) with \$fn = 100000 makes about 5,000,000,002 polygons/)
    expect((e as ScadError).pos).toEqual(at(2))
    expect(HARD_LIMIT).toBe(20_000_000)
  })
  test('$fa / $fs fragments are named too', () => {
    const ctx = ctxOf()
    build([circle(10, F(0, 1, 0.01))], ctx)
    expect(ctx.calls[0].what).toBe('circle() with 360 fragments ($fa = 1, $fs = 0.01)')
  })
  test('polyhedron() refuses bad indices, naming the face', () => {
    const node: GeomNode = { kind: 'polyhedron', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 1, 2], [0, 3, 9]], pos: at(5) }
    let e: unknown
    try { build([node], ctxOf()) } catch (x) { e = x }
    expect(e).toBeInstanceOf(ScadError)
    expect((e as ScadError).kind).toBe('runtime')
    expect((e as ScadError).message).toBe('polyhedron(): face 1 refers to point 9, but there are only 4 points (0 to 3)')
    expect((e as ScadError).pos).toEqual(at(5))
  })
  test('an inside-out polyhedron is turned right side out, with a warning', () => {
    const inverted: GeomNode = { kind: 'polyhedron', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], faces: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] }
    const out = build([inverted], ctxOf())
    // the binary's render does the same once the polyhedron meets a boolean: cube(2) minus an inverted unit cube is 7
    expect(volume(out.geoms[0])).toBeCloseTo(1 / 6, 9)
    expect(out.warnings).toEqual([WARN_INSIDE_OUT])
  })
  test('polygon() refuses bad path indices', () => {
    expect(() => build([{ kind: 'polygon', points: [[0, 0], [1, 0], [0, 1]], paths: [[0, 1, 3]] }], ctxOf()))
      .toThrow('polygon(): path 0 refers to point 3, but there are only 3 points (0 to 2)')
  })
  test('minkowski() of shapes that split into too many convex pieces is refused as a limit', () => {
    // 60 × 40 separate convex pieces (minkowski distributes over them) → 2,400 pairs, more than the limit
    const row = (n: number) => op('group', ...Array.from({ length: n }, (_, i) => translate([i * 2, 0, 0], cube(1))))
    let e: unknown
    try { build([op('minkowski', row(60), row(40))], ctxOf()) } catch (x) { e = x }
    expect(e).toBeInstanceOf(ScadError)
    expect((e as ScadError).kind).toBe('limit')
    expect((e as ScadError).message).toMatch(/^minkowski\(\) is too heavy/)
  })
})

describe('text()', () => {
  test('approximated with the built-in stroke font, with a one-time warning', () => {
    const t: GeomNode = { kind: 'text', text: 'HE', size: 10, font: '', halign: 'left', valign: 'baseline', spacing: 1, direction: 'ltr', frag: F() }
    const out = build([lin(1, t), translate([0, 20, 0], lin(1, t))], ctxOf())
    expect(out.warnings).toEqual([TEXT_WARNING])
    expect(out.geoms).toHaveLength(2)
    const b = jscad.measurements.measureBoundingBox(out.geoms[0])
    // capitals about 0.955 × size tall (plus the stroke), starting near the origin like OpenSCAD's
    expect(b[1][1] - b[0][1]).toBeGreaterThan(9.5)
    expect(b[1][1] - b[0][1]).toBeLessThan(11)
    expect(b[0][0]).toBeGreaterThan(0)
    expect(b[0][0]).toBeLessThan(3)
  })
  test('halign center centres the advance on x = 0', () => {
    const t: GeomNode = { kind: 'text', text: 'HH', size: 10, font: '', halign: 'center', valign: 'baseline', spacing: 1, direction: 'ltr', frag: F() }
    const b = jscad.measurements.measureBoundingBox(build([lin(1, t)], ctxOf()).geoms[0])
    expect(Math.abs(b[0][0] + b[1][0])).toBeLessThan(0.5)
  })
})

describe('2D engine', () => {
  const sq = (x: number, y: number, s: number): Vec2[] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]]
  test('fill rules', () => {
    expect(regionArea(evenOdd([sq(0, 0, 10), sq(5, 5, 10)]))).toBeCloseTo(150, 9) // xor
    expect(regionArea(union2([[sq(0, 0, 10)], [sq(5, 5, 10)]]))).toBeCloseTo(175, 9)
    expect(regionArea(difference2([sq(0, 0, 10)], [[sq(5, 5, 10)]]))).toBeCloseTo(75, 9)
    expect(regionArea(intersection2([[sq(0, 0, 10)], [sq(5, 5, 10)]]))).toBeCloseTo(25, 9)
    expect(evenOdd([sq(0, 0, 10), sq(0, 0, 10)])).toEqual([]) // a path twice cancels
  })
  test('touching shapes merge, collinear vertices go, holes are clockwise', () => {
    const u = union2([[sq(0, 0, 1)], [sq(1, 0, 1)]])
    expect(u).toEqual([[[0, 0], [2, 0], [2, 1], [0, 1]]].map((l) => expect.arrayContaining(l)))
    expect(u[0]).toHaveLength(4)
    const ring = difference2([sq(0, 0, 10)], [[sq(3, 3, 4)]])
    expect(ring).toHaveLength(2)
    expect(regionArea(ring)).toBeCloseTo(84, 9)
    const { tris, points } = triangulateRegion(ring)
    let a = 0
    for (const [i, j, k] of tris) a += ((points[j][0] - points[i][0]) * (points[k][1] - points[i][1]) - (points[j][1] - points[i][1]) * (points[k][0] - points[i][0])) / 2
    expect(a).toBeCloseTo(84, 9)
  })
})

describe('2D engine on random inputs (many touching and collinear edges)', () => {
  // deterministic PRNG
  let seed = 7
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const poly = (n: number, grid: boolean): Vec2[] => Array.from({ length: n }, (): Vec2 => (grid ? [Math.round(rnd() * 8), Math.round(rnd() * 8)] : [rnd() * 8, rnd() * 8]))
  const parity = (p: Vec2, loops: Vec2[][]) => loops.reduce((c, l) => c !== pointInLoop(p, l), false)
  const triArea = (r: Vec2[][]) => {
    const { points, tris } = triangulateRegion(r)
    let a = 0
    for (const [i, j, k] of tris) a += ((points[j][0] - points[i][0]) * (points[k][1] - points[i][1]) - (points[j][1] - points[i][1]) * (points[k][0] - points[i][0])) / 2
    return a
  }
  test('booleans: membership at sample points matches the inputs; triangulations cover the result', () => {
    for (let it = 0; it < 120; it++) {
      const grid = it % 2 === 0
      const A = [poly(3 + (it % 6), grid), ...(it % 3 === 0 ? [poly(4, grid)] : [])], B = [poly(3 + (it % 4), grid)]
      const a = evenOdd(A), b = evenOdd(B)
      const cases: [Vec2[][], (p: Vec2) => boolean][] = [
        [a, (p) => parity(p, A)],
        [union2([a, b]), (p) => parity(p, A) || parity(p, B)],
        [difference2(a, [b]), (p) => parity(p, A) && !parity(p, B)],
        [intersection2([a, b]), (p) => parity(p, A) && parity(p, B)],
      ]
      for (const [r, inside] of cases) {
        for (let k = 0; k < 150; k++) {
          const p: Vec2 = [rnd() * 9 - 0.5, rnd() * 9 - 0.5]
          expect(parity(p, r)).toBe(inside(p))
        }
        expect(triArea(r)).toBeCloseTo(regionArea(r), 9)
      }
    }
  })
})

test('build() (the contract) reports the warnings as texts', () => {
  const out = build([square(10)], ctxOf())
  expect(out.warnings).toEqual([WARN_2D_TOP])
  expect(out.geoms).toHaveLength(1)
})
