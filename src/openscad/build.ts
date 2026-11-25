// The build side of the OpenSCAD support: CSG tree (GeomNode) → JSCAD geometry, with OpenSCAD 2021.01's
// tessellation and rules, so models look and measure like they do in OpenSCAD. Pure: no DOM; runs in the eval worker.
//
// Shapes are kept as lists of pieces and only unioned when an operation needs it ("lazy union"):
//   group / top level   pieces side by side, each with its colour (the 3Dica view shows them like OpenSCAD's preview)
//   union()             one solid per colour (a single solid when all children share a colour, the usual case)
//   difference()        each piece of the first child minus the other children: (A∪B)−C = (A−C)∪(B−C), keeps colours
//   intersection()      each piece of the first child ∩ the union of each other child
//   hull, minkowski, extrusions, offset, projection, resize: work on all pieces at once
// 2D work happens in build-2d (Clipper-like); 3D booleans in build-csg (JSCAD's BSP rules, clipped locally so many
// operands stay fast); hulls use JSCAD. Identical subtrees (a module called again with the same arguments) are built
// once, like OpenSCAD's geometry cache.
//
// Colours: color() colours the pieces that have no colour yet (the innermost color() wins, as in OpenSCAD). Results of
// difference / intersection keep the first child's colours; hull, minkowski, extrusions, offset and projection keep a
// colour shared by all their inputs.
//
// Dimensions: an operation takes the dimension of its first child that has one; children of the other dimension are
// ignored with OpenSCAD's warnings. At the top level 3D wins: 2D next to 3D is dropped (with the same warnings), and a
// 2D-only result is shown 1 mm thick, centred on z = 0, as OpenSCAD's preview does.
import jscad from '@jscad/modeling'
import type { Geom3 } from '@jscad/modeling/src/geometries/types'
import { ScadError, type Build, type BuildContext, type Fragments, type GeomNode, type Rgba, type ScadMessage, type SourcePos, type Vec2, type Vec3 } from './types'
import { bbox2, difference2, evenOdd, hull2, intersection2, pointCount, transformRegion, union2, type Region } from './build-2d'
import { triangulateLoop } from './build-tri'
import { intersectMany, subtractMany, unionMany, unionParts } from './build-csg'
import { offsetRegion, roundSteps, type Join } from './build-offset'
import { linearExtrude, linearSlices, rotateExtrude, rotateSetup, signedVolume } from './build-extrude'
import { projectCut, projectShadow } from './build-project'
import { convexCells, minkowski2, minkowski2Cost, minkowskiSums } from './minkowski'
import { clampFragments, convexPieces, circlePoints, cubePolygons, cylinderPolygons, fragments, sphereRings, spherePolygons, squarePoints } from './tess'
import { textRegion, TEXT_WARNING } from './text'

const { geom3, poly3 } = jscad.geometries
const { measureBoundingBox } = jscad.measurements
type JMat4 = Parameters<typeof jscad.transforms.transform>[0]

/** No single operation may allocate more than this many polygons / points, whatever the context's budget says. */
export const HARD_LIMIT = 20_000_000
/** Convex pieces × pieces in one minkowski() before it is refused as too heavy. */
export const MINKOWSKI_MAX_HULLS = 2000
/** Messages kept per build (identical ones are merged). */
const MAX_MESSAGES = 200

export const WARN_2D_TOP = "2D result shown 1 mm thick, like OpenSCAD's preview — use linear_extrude() for a solid"
const WARN_MIXING = 'Mixing 2D and 3D objects is not supported'
export const WARN_INSIDE_OUT = "polyhedron() faces are listed counter-clockwise seen from outside (inside out); it was turned right side out"

interface P3 { g: Geom3; color?: Rgba; /** known convex (primitives, hulls) */ convex?: boolean }
interface P2 { r: Region; color?: Rgba }
type Shape = { dim: 0 } | { dim: 2; p: P2[] } | { dim: 3; p: P3[] }
const NOTHING: Shape = { dim: 0 }
/** no geometry at all: an empty group, or a 2D/3D result with no pieces */
const isEmptyShape = (s: Shape): boolean => s.dim === 0 || s.p.length === 0

export interface BuildOutput {
  geoms: Geom3[]
  /** build warnings with their source positions (BuildResult.warnings is these texts) */
  messages: ScadMessage[]
}

const thousands = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const num = (n: number): string => String(Number.isInteger(n) ? n : +n.toPrecision(6))

function fragWhat(name: string, f: Fragments, n: number): string {
  return f.fn > 0 ? `${name}() with $fn = ${num(f.fn)}` : `${name}() with ${thousands(n)} fragments ($fa = ${num(f.fa)}, $fs = ${num(f.fs)})`
}

const colorKey = (c?: Rgba): string => (c ? c.join(',') : '')

function commonColor(cs: (Rgba | undefined)[]): Rgba | undefined {
  if (cs.length === 0 || !cs[0]) return undefined
  const k = colorKey(cs[0])
  return cs.every((c) => colorKey(c) === k) ? cs[0] : undefined
}

function toRgba(c: unknown): Rgba | undefined {
  if (!Array.isArray(c) || c.length < 3 || !c.every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined
  return [c[0], c[1], c[2], c.length > 3 ? c[3] : 1]
}

const polysOf = (g: Geom3): Vec3[][] => geom3.toPolygons(g).map((p) => p.vertices as unknown as Vec3[])

function solid(polys: Vec3[][]): Geom3 {
  return geom3.create(polys.map((p) => poly3.create(p as unknown as Parameters<typeof poly3.create>[0])))
}

type Box3 = [number[], number[]]
const boxOf = (g: Geom3): Box3 => measureBoundingBox(g) as unknown as Box3
const overlap3 = (a: Box3, b: Box3): boolean =>
  a[0][0] <= b[1][0] && b[0][0] <= a[1][0] && a[0][1] <= b[1][1] && b[0][1] <= a[1][1] && a[0][2] <= b[1][2] && b[0][2] <= a[1][2]
const isEmpty3 = (g: Geom3): boolean => geom3.toPolygons(g).length === 0

const isIdentity = (m: number[]): boolean => m.every((v, i) => v === (i % 5 === 0 ? 1 : 0))

/** Nodes whose results are cached by content (cheap wrappers like group / multmatrix / color are not). */
const CACHED = new Set<GeomNode['kind']>([
  'sphere', 'cylinder', 'circle', 'polyhedron', 'polygon', 'text', 'resize', 'offset', 'union', 'difference',
  'intersection', 'hull', 'minkowski', 'linear_extrude', 'rotate_extrude', 'projection', 'part',
])

/** polygons (3D) or points (2D) in a shape: what reusing it costs */
function shapeSize(s: Shape): number {
  if (s.dim === 0) return 0
  if (s.dim === 2) return s.p.reduce((t, x) => t + pointCount(x.r), 0)
  return s.p.reduce((t, x) => t + geom3.toPolygons(x.g).length, 0)
}

class Builder {
  readonly messages: ScadMessage[] = []
  private readonly seen = new Set<string>()
  private readonly cache = new Map<number, { shape: Shape; size: number; what: string }>()
  private lastWhat = ''
  private readonly ids = new WeakMap<GeomNode, number>()
  private readonly intern = new Map<string, number>()
  private textWarned = false
  private readonly ctx: BuildContext
  constructor(ctx: BuildContext) { this.ctx = ctx }

  warn(text: string, pos?: SourcePos): void {
    const key = text + '\u0000' + (pos ? `${pos.file}:${pos.line}:${pos.col}` : '')
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.messages.length < MAX_MESSAGES) this.messages.push(pos ? { level: 'warning', text, pos } : { level: 'warning', text })
    else if (this.messages.length === MAX_MESSAGES) this.messages.push({ level: 'warning', text: 'Too many warnings; the rest are not shown' })
  }

  charge(n: number, what: string, pos?: SourcePos): void {
    if (!(n <= HARD_LIMIT)) {
      const hint = what.includes('$fn') ? ' — lower $fn' : what.includes('$fa') ? ' — raise $fa / $fs' : ''
      throw new ScadError('limit', `Too much geometry: ${what} makes about ${thousands(n)} polygons (the limit is ${thousands(HARD_LIMIT)})${hint}`, pos)
    }
    if (n > 0) {
      this.lastWhat = what
      this.ctx.charge(n, what, pos)
    }
  }

  /** charge the part of `actual` that the estimate did not cover */
  settle(actual: number, estimate: number, what: string, pos?: SourcePos): void {
    if (actual > estimate) this.charge(actual - estimate, what, pos)
  }

  frag(f: Fragments, pos?: SourcePos): Fragments {
    return clampFragments(f, (m) => this.warn(m, pos))
  }

  // ───────────────────────────── children and dimensions ─────────────────────────────

  /** Drops (with OpenSCAD's warnings) the children whose dimension is not `dim`. */
  private keepDim<T extends Shape>(shapes: Shape[], dim: 2 | 3, pos?: SourcePos): T[] {
    const out: T[] = []
    let warned = false
    for (const s of shapes) {
      if (s.dim === 0) continue
      if (s.dim === dim) { out.push(s as T); continue }
      if (!warned) { this.warn(WARN_MIXING, pos); warned = true }
      this.warn(`Ignoring ${s.dim}D child object for ${dim}D operation`, pos)
      out.push({ dim, p: [] } as unknown as T) // an ignored child is an empty operand
    }
    return out
  }

  private firstDim(shapes: Shape[]): 0 | 2 | 3 {
    for (const s of shapes) if (s.dim !== 0) return s.dim
    return 0
  }

  /** implicit union, lazily: the pieces side by side */
  group(kids: GeomNode[], pos?: SourcePos): Shape {
    const shapes = kids.map((k) => this.walk(k))
    const dim = this.firstDim(shapes)
    if (dim === 0) return NOTHING
    const kept = this.keepDim<Extract<Shape, { dim: 2 | 3 }>>(shapes, dim, pos)
    return dim === 3
      ? { dim: 3, p: kept.flatMap((s) => (s as Extract<Shape, { dim: 3 }>).p) }
      : { dim: 2, p: kept.flatMap((s) => (s as Extract<Shape, { dim: 2 }>).p) }
  }

  /** the 2D children of a 2D operation, unioned; 3D children are ignored with a warning */
  private region2D(kids: GeomNode[], pos?: SourcePos): { r: Region; color?: Rgba } | null {
    const shapes = kids.map((k) => this.walk(k))
    const pieces: P2[] = []
    for (const s of shapes) {
      if (s.dim === 3) this.warn('Ignoring 3D child object for 2D operation', pos)
      else if (s.dim === 2) for (const p of s.p) pieces.push(p)
    }
    if (pieces.length === 0) return null
    return { r: union2(pieces.map((p) => p.r)), color: commonColor(pieces.map((p) => p.color)) }
  }

  /** the union of pieces as one or more closed solids (only parts that meet along an edge or at a corner stay
   *  apart, see unionParts in build-csg.ts); one piece stays as it is */
  private merge3(pieces: P3[], pos?: SourcePos): { g: Geom3; convex: boolean }[] {
    if (pieces.length === 1) return [{ g: pieces[0].g, convex: pieces[0].convex === true }]
    return unionParts(pieces, (n) => { if (n > 0) this.charge(n, 'union()', pos) }).map((x) => ({ g: x.g, convex: x.convex === true }))
  }

  /** union per colour */
  private unionByColor(s: Shape): Shape {
    if (s.dim === 0) return s
    const groups = new Map<string, number[]>()
    s.p.forEach((p, i) => {
      const k = colorKey(p.color)
      const l = groups.get(k)
      if (l) l.push(i)
      else groups.set(k, [i])
    })
    if (s.dim === 3) {
      const out: P3[] = []
      for (const idx of groups.values()) {
        const ps = idx.map((i) => s.p[i])
        if (ps.length === 1) out.push(ps[0])
        else for (const m of this.merge3(ps)) out.push({ g: m.g, color: ps[0].color, ...(m.convex ? { convex: true } : {}) })
      }
      return { dim: 3, p: out }
    }
    const out: P2[] = []
    for (const idx of groups.values()) {
      const ps = idx.map((i) => s.p[i])
      const r = ps.length === 1 ? ps[0].r : union2(ps.map((p) => p.r))
      if (r.length) out.push({ r, color: ps[0].color })
    }
    return { dim: 2, p: out }
  }

  private transform(s: Shape, m: number[], pos?: SourcePos): Shape {
    if (s.dim === 0) return s
    if (s.p.length === 0) return NOTHING
    if (!m.every(Number.isFinite)) {
      this.warn('Transformation matrix contains Not-a-Number and/or Infinity - removing object.', pos)
      return NOTHING
    }
    if (isIdentity(m)) return s
    if (s.dim === 3) return { dim: 3, p: s.p.map((x) => ({ ...x, g: jscad.transforms.transform(m as unknown as JMat4, x.g) })) }
    const out: P2[] = []
    for (const x of s.p) {
      const r = transformRegion(x.r, m)
      if (r) out.push({ ...x, r })
      else this.warn('Scaling a 2D object with 0 - removing object', pos)
    }
    return { dim: 2, p: out }
  }

  // ───────────────────────────── nodes ─────────────────────────────

  /** The shape of a node. Identical subtrees (the same module called again with the same arguments) are built once,
   *  like OpenSCAD's geometry cache; a reused result is still charged to the budget, as its copies cost memory too. */
  walk(n: GeomNode): Shape {
    if (!CACHED.has(n.kind)) return this.make(n)
    const id = this.keyOf(n)
    const hit = this.cache.get(id)
    if (hit) {
      this.charge(hit.size, hit.what, n.pos)
      return hit.shape
    }
    const before = this.lastWhat
    this.lastWhat = ''
    const shape = this.make(n)
    // a reuse is described like the geometry that made it heavy (e.g. "sphere() with $fn = 400")
    this.cache.set(id, { shape, size: shapeSize(shape), what: this.lastWhat || `${n.kind}()` })
    this.lastWhat = this.lastWhat || before
    return shape
  }

  /** An id per distinct subtree: the node's own fields plus its children's ids, interned. */
  private keyOf(n: GeomNode): number {
    const known = this.ids.get(n)
    if (known !== undefined) return known
    const kids = 'children' in n ? n.children.map((k) => this.keyOf(k)) : []
    const own = JSON.stringify(n, (k, v) => (k === 'children' || k === 'pos' ? undefined : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))
    const key = own + '|' + kids.join(',')
    let id = this.intern.get(key)
    if (id === undefined) { id = this.intern.size; this.intern.set(key, id) }
    this.ids.set(n, id)
    return id
  }

  private make(n: GeomNode): Shape {
    const pos = n.pos
    switch (n.kind) {
      case 'cube': {
        const polys = cubePolygons(n.size, n.center)
        if (!polys.length) return { dim: 3, p: [] }
        this.charge(6, 'cube()', pos)
        return { dim: 3, p: [{ g: solid(polys), convex: true }] }
      }
      case 'sphere': {
        if (!(n.r > 0) || !Number.isFinite(n.r)) return { dim: 3, p: [] }
        const f = this.frag(n.frag, pos)
        const k = fragments(n.r, f)
        const est = k * sphereRings(k) + 2
        this.charge(est, fragWhat('sphere', f, k), pos)
        const polys = spherePolygons(n.r, k)
        return { dim: 3, p: [{ g: solid(polys), convex: true }] }
      }
      case 'cylinder': {
        // OpenSCAD makes nothing for h ≤ 0, a negative radius or two zero radii
        if (!(n.h > 0) || !(n.r1 >= 0) || !(n.r2 >= 0) || (n.r1 === 0 && n.r2 === 0) || ![n.h, n.r1, n.r2].every(Number.isFinite)) return { dim: 3, p: [] }
        const f = this.frag(n.frag, pos)
        const k = fragments(Math.max(n.r1, n.r2), f)
        this.charge(k + 2, fragWhat('cylinder', f, k), pos)
        return { dim: 3, p: [{ g: solid(cylinderPolygons(n.h, n.r1, n.r2, n.center, k)), convex: true }] }
      }
      case 'polyhedron':
        return this.polyhedron(n.points, n.faces, pos)
      case 'square': {
        const pts = squarePoints(n.size, n.center)
        return { dim: 2, p: pts.length ? [{ r: [pts] }] : [] }
      }
      case 'circle': {
        if (!(n.r > 0) || !Number.isFinite(n.r)) return { dim: 2, p: [] }
        const f = this.frag(n.frag, pos)
        const k = fragments(n.r, f)
        this.charge(k, fragWhat('circle', f, k), pos)
        return { dim: 2, p: [{ r: [circlePoints(n.r, k)] }] }
      }
      case 'polygon':
        return this.polygon(n.points, n.paths, pos)
      case 'text': {
        const f = this.frag(n.frag, pos)
        if (!this.textWarned) { this.textWarned = true; this.warn(TEXT_WARNING, pos) }
        this.charge(n.text.length * 64, 'text()', pos)
        const r = textRegion({ ...n, frag: f })
        this.settle(pointCount(r), n.text.length * 64, 'text()', pos)
        return { dim: 2, p: r.length ? [{ r }] : [] }
      }
      case 'multmatrix':
        return this.transform(this.group(n.children, pos), n.m, pos)
      case 'color': {
        const s = this.group(n.children, pos)
        if (s.dim === 0) return s
        const rgba = n.rgba
        return s.dim === 3
          ? { dim: 3, p: s.p.map((x) => (x.color ? x : { ...x, color: rgba })) }
          : { dim: 2, p: s.p.map((x) => (x.color ? x : { ...x, color: rgba })) }
      }
      case 'resize':
        return this.resize(this.group(n.children, pos), n.size, n.auto, pos)
      case 'offset': {
        const src = this.region2D(n.children, pos)
        if (!src) return { dim: 2, p: [] }
        const delta = n.r ?? n.delta ?? 0
        const join: Join = n.r !== undefined ? 'round' : n.chamfer ? 'square' : 'miter'
        const f = this.frag(n.frag, pos)
        // round joins add about one full circle of arc points per outline (more for wiggly ones: settled after)
        const per = join === 'round' ? Math.min(roundSteps(delta, f), HARD_LIMIT) : 0
        const est = pointCount(src.r) * 3 + per * src.r.length
        const what = join === 'round' ? fragWhat('offset', f, per) : 'offset()'
        this.charge(est, what, pos)
        const r = offsetRegion(src.r, delta, join, f)
        this.settle(pointCount(r), est, what, pos)
        return { dim: 2, p: r.length ? [{ r, color: src.color }] : [] }
      }
      case 'group':
        return this.group(n.children, pos)
      case 'union':
        return this.unionByColor(this.group(n.children, pos))
      case 'difference':
        return this.difference(n.children, pos)
      case 'intersection':
        return this.intersection(n.children, pos)
      case 'hull':
        return this.hull(n.children, pos)
      case 'minkowski':
        return this.minkowski(n.children, pos)
      case 'linear_extrude': {
        const src = this.region2D(n.children, pos)
        if (!src || !(n.height > 0)) return { dim: 3, p: [] }
        const f = this.frag(n.frag, pos)
        const opts = { height: n.height, center: n.center, twist: n.twist, slices: n.slices, scale: n.scale, frag: f }
        const slices = linearSlices(src.r, opts)
        const pts = pointCount(src.r)
        const est = slices * pts * 2 + 2 * pts
        const what = `linear_extrude() with ${thousands(slices)} slices${n.slices === undefined && f.fn > 0 ? ` ($fn = ${num(f.fn)})` : ''}`
        this.charge(est, what, pos)
        const polys = linearExtrude(src.r, opts, slices)
        this.settle(polys.length, est, what, pos)
        return { dim: 3, p: polys.length ? [{ g: solid(polys), color: src.color }] : [] }
      }
      case 'rotate_extrude': {
        const src = this.region2D(n.children, pos)
        if (!src) return { dim: 3, p: [] }
        const f = this.frag(n.frag, pos)
        const s = rotateSetup(src.r, n.angle, f)
        if (s.error) { this.warn(s.error, pos); return { dim: 3, p: [] } }
        const pts = pointCount(src.r)
        const est = s.n * pts + 2 * pts
        const what = fragWhat('rotate_extrude', f, s.n)
        this.charge(est, what, pos)
        const polys = rotateExtrude(src.r, s.angle, s.n)
        this.settle(polys.length, est, what, pos)
        return { dim: 3, p: polys.length ? [{ g: solid(polys), color: src.color }] : [] }
      }
      case 'projection': {
        const shapes = n.children.map((k) => this.walk(k))
        const pieces = shapes.flatMap((s) => (s.dim === 3 ? s.p : []))
        if (pieces.length === 0) return { dim: 2, p: [] }
        const input = pieces.map((p) => ({ polys: polysOf(p.g), convex: p.convex === true }))
        const r = n.cut ? projectCut(input) : projectShadow(input)
        this.charge(pointCount(r), 'projection()', pos)
        return { dim: 2, p: r.length ? [{ r, color: commonColor(pieces.map((p) => p.color)) }] : [] }
      }
      case 'part': {
        const geoms = this.ctx.resolvePart(n.name, n.overrides, pos)
        return { dim: 3, p: geoms.map((g) => ({ g, color: toRgba(g.color) })) }
      }
      default:
        throw new ScadError('runtime', `Unknown geometry node "${String((n as { kind?: unknown }).kind)}"`, pos)
    }
  }

  private polyhedron(points: Vec3[], faces: number[][], pos?: SourcePos): Shape {
    points.forEach((p, i) => {
      if (!Array.isArray(p) || p.length < 3 || !p.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        throw new ScadError('runtime', `polyhedron(): point ${i} is not a vector of 3 finite numbers`, pos)
      }
    })
    const n = points.length
    faces.forEach((f, i) => {
      for (const idx of f) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
          throw new ScadError('runtime', `polyhedron(): face ${i} refers to point ${String(idx)}, but there ${n === 1 ? 'is only 1 point' : `are only ${n} points`} (0 to ${n - 1})`, pos)
        }
      }
    })
    this.charge(faces.length, `polyhedron() with ${thousands(faces.length)} faces`, pos)
    const polys: Vec3[][] = []
    for (const f of faces) {
      if (f.length < 3) continue
      const idx: number[] = []
      for (const i of f) if (idx[idx.length - 1] !== i) idx.push(i)
      while (idx.length > 1 && idx[0] === idx[idx.length - 1]) idx.pop()
      if (idx.length < 3) continue
      // OpenSCAD faces are clockwise seen from outside; JSCAD wants counter-clockwise
      const pts = idx.reverse().map((i) => [points[i][0], points[i][1], points[i][2]] as Vec3)
      for (const q of convexPieces(pts, triangulateLoop)) polys.push(q)
    }
    this.settle(polys.length, faces.length, `polyhedron() with ${thousands(faces.length)} faces`, pos)
    // An inside-out polyhedron (faces counter-clockwise seen from outside) is turned right side out: OpenSCAD's render
    // (CGAL) does the same as soon as it is combined with anything, and JSCAD's booleans would mangle it otherwise.
    if (signedVolume(polys) < 0) {
      this.warn(WARN_INSIDE_OUT, pos)
      for (const p of polys) p.reverse()
    }
    return { dim: 3, p: polys.length ? [{ g: solid(polys) }] : [] }
  }

  private polygon(points: Vec2[], paths: number[][] | undefined, pos?: SourcePos): Shape {
    points.forEach((p, i) => {
      if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        throw new ScadError('runtime', `polygon(): point ${i} is not a vector of 2 finite numbers`, pos)
      }
    })
    const n = points.length
    const ps = paths ?? [points.map((_, i) => i)]
    ps.forEach((path, i) => {
      for (const idx of path) {
        if (!Number.isInteger(idx) || idx < 0 || idx >= n) {
          throw new ScadError('runtime', `polygon(): path ${i} refers to point ${String(idx)}, but there ${n === 1 ? 'is only 1 point' : `are only ${n} points`} (0 to ${n - 1})`, pos)
        }
      }
    })
    const total = ps.reduce((s, p) => s + p.length, 0)
    this.charge(total, `polygon() with ${thousands(total)} points`, pos)
    const r = evenOdd(ps.filter((p) => p.length >= 3).map((path) => path.map((i): Vec2 => [points[i][0], points[i][1]])))
    return { dim: 2, p: r.length ? [{ r }] : [] }
  }

  private resize(s: Shape, size: Vec3, auto: [boolean, boolean, boolean], pos?: SourcePos): Shape {
    if (s.dim === 0 || s.p.length === 0) return s
    const dims = s.dim
    let lo: number[], hi: number[]
    if (s.dim === 3) {
      lo = [Infinity, Infinity, Infinity]; hi = [-Infinity, -Infinity, -Infinity]
      for (const p of s.p) {
        if (isEmpty3(p.g)) continue
        const b = boxOf(p.g)
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b[0][k]); hi[k] = Math.max(hi[k], b[1][k]) }
      }
      if (!(lo[0] <= hi[0])) return s
    } else {
      const b = bbox2(s.p.flatMap((p) => p.r))
      if (!b) return s
      lo = [b[0], b[1], 0]; hi = [b[2], b[3], 0]
    }
    // OpenSCAD: a size ≤ 0 keeps that dimension; auto dimensions follow the scale of the largest new size
    let md = 0
    for (let k = 1; k < dims; k++) if (size[k] > size[md]) md = k
    const scale = [1, 1, 1]
    for (let k = 0; k < dims; k++) {
      const old = hi[k] - lo[k]
      if (size[k] > 0 && old > 0) scale[k] = size[k] / old
    }
    const autoscale = scale[md]
    for (let k = 0; k < dims; k++) if (auto[k] && !(size[k] > 0)) scale[k] = autoscale
    const m = [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, dims === 3 ? scale[2] : 1, 0, 0, 0, 0, 1]
    return this.transform(s, m, pos)
  }

  private difference(kids: GeomNode[], pos?: SourcePos): Shape {
    const shapes = kids.map((k) => this.walk(k))
    // an empty first child (an empty module or children(), union() {}, cube(0), a sub-result that came out empty)
    // empties the whole difference, as in OpenSCAD 2021.01: the next child is not promoted to the base
    if (shapes.length && isEmptyShape(shapes[0])) return NOTHING
    const dim = this.firstDim(shapes)
    if (dim === 0) return NOTHING
    if (dim === 3) {
      const [base, ...rest] = this.keepDim<Extract<Shape, { dim: 3 }>>(shapes, 3, pos)
      const cutters = rest.flatMap((s) => s.p.map((p) => ({ g: p.g, convex: p.convex, box: boxOf(p.g) })))
      const out: P3[] = []
      for (const piece of base.p) {
        const box = boxOf(piece.g)
        const rel = cutters.filter((c) => overlap3(box, c.box))
        if (rel.length === 0) { out.push(piece); continue }
        // the cutters' surfaces are clipped locally instead of one cutter at a time (see build-csg.ts)
        const g = subtractMany(piece, rel, (n) => { if (n > 0) this.charge(n, 'difference()', pos) })
        if (!isEmpty3(g)) out.push({ g, color: piece.color })
      }
      return { dim: 3, p: out }
    }
    const [base, ...rest] = this.keepDim<Extract<Shape, { dim: 2 }>>(shapes, 2, pos)
    const cutters = rest.flatMap((s) => s.p.map((p) => p.r))
    const out: P2[] = []
    for (const piece of base.p) {
      const r = difference2(piece.r, cutters)
      if (r.length) out.push({ r, color: piece.color })
    }
    return { dim: 2, p: out }
  }

  private intersection(kids: GeomNode[], pos?: SourcePos): Shape {
    const shapes = kids.map((k) => this.walk(k))
    // any empty child empties the intersection (OpenSCAD 2021.01), whatever made it empty
    if (shapes.some(isEmptyShape)) return NOTHING
    const dim = this.firstDim(shapes)
    if (dim === 0) return NOTHING
    if (dim === 3) {
      const [base, ...rest] = this.keepDim<Extract<Shape, { dim: 3 }>>(shapes, 3, pos)
      if (rest.some((s) => s.p.length === 0)) return { dim: 3, p: [] }
      // each other operand as its closed parts (usually one)
      const others = rest.map((s) => this.merge3(s.p, pos).map((m) => ({ ...m, box: boxOf(m.g) })))
      const charge = (n: number) => { if (n > 0) this.charge(n, 'intersection()', pos) }
      const out: P3[] = []
      for (const piece of base.p) {
        const box = boxOf(piece.g)
        if (!others.every((o) => o.some((x) => overlap3(box, x.box)))) continue
        if (!others.length) { out.push(piece); continue }
        if (others.every((o) => o.length === 1)) {
          const g = intersectMany(piece, others.map((o) => o[0]), charge)
          // the intersection of convex solids is convex
          if (!isEmpty3(g)) out.push({ g, color: piece.color, convex: piece.convex === true && others.every((o) => o[0].convex) })
          continue
        }
        // an operand in parts that meet only along edges: piece ∩ (B1 ∪ B2) = (piece ∩ B1) ∪ (piece ∩ B2)
        let cur: { g: Geom3; convex: boolean }[] = [{ g: piece.g, convex: piece.convex === true }]
        for (const o of others) {
          const next: { g: Geom3; convex: boolean }[] = []
          for (const c of cur) {
            const cb = boxOf(c.g)
            for (const x of o) {
              if (!overlap3(cb, x.box)) continue
              const g = intersectMany(c, [x], charge)
              if (!isEmpty3(g)) next.push({ g, convex: c.convex && x.convex })
            }
          }
          cur = next
          if (!cur.length) break
        }
        for (const c of cur) out.push({ g: c.g, color: piece.color, convex: c.convex })
      }
      return { dim: 3, p: out }
    }
    const [base, ...rest] = this.keepDim<Extract<Shape, { dim: 2 }>>(shapes, 2, pos)
    if (rest.some((s) => s.p.length === 0)) return { dim: 2, p: [] }
    const others = rest.map((s) => union2(s.p.map((p) => p.r)))
    const out: P2[] = []
    for (const piece of base.p) {
      const r = intersection2([piece.r, ...others])
      if (r.length) out.push({ r, color: piece.color })
    }
    return { dim: 2, p: out }
  }

  private hull(kids: GeomNode[], pos?: SourcePos): Shape {
    const shapes = kids.map((k) => this.walk(k))
    const dim = this.firstDim(shapes)
    if (dim === 0) return NOTHING
    if (dim === 3) {
      const kept = this.keepDim<Extract<Shape, { dim: 3 }>>(shapes, 3, pos)
      const pieces = kept.flatMap((s) => s.p)
      let n = 0
      for (const x of pieces) n += geom3.toPolygons(x.g).length
      this.charge(n, `hull() of ${thousands(n)} faces`, pos)
      // interior points are dropped before the duplicates (most of a fine model's vertices are both)
      const pts = uniquePoints(hullCandidates([...verticesOf(pieces)]))
      if (pts.length < 4) return { dim: 3, p: [] }
      const g = hull3(pts, true)
      return { dim: 3, p: g ? [{ g, color: commonColor(pieces.map((p) => p.color)), convex: true }] : [] }
    }
    const kept = this.keepDim<Extract<Shape, { dim: 2 }>>(shapes, 2, pos)
    const pieces = kept.flatMap((s) => s.p)
    const h = hull2(pieces.flatMap((p) => p.r.flat()))
    return { dim: 2, p: h.length ? [{ r: [h], color: commonColor(pieces.map((p) => p.color)) }] : [] }
  }

  private minkowski(kids: GeomNode[], pos?: SourcePos): Shape {
    const shapes = kids.map((k) => this.walk(k))
    const dim = this.firstDim(shapes)
    if (dim === 0) return NOTHING
    if (dim === 2) {
      const kept = this.keepDim<Extract<Shape, { dim: 2 }>>(shapes, 2, pos).filter((s) => s.p.length > 0)
      if (kept.length === 0) return { dim: 2, p: [] }
      const color = commonColor(kept.flatMap((s) => s.p.map((p) => p.color)))
      let acc = union2(kept[0].p.map((p) => p.r))
      for (const s of kept.slice(1)) {
        const b = union2(s.p.map((p) => p.r))
        const cost = minkowski2Cost(acc, b)
        if (cost.hulls > MINKOWSKI_MAX_HULLS * 10) {
          throw new ScadError('limit', `minkowski() is too heavy: these 2D shapes split into ${thousands(cost.hulls)} convex pairs — simplify the shapes or lower $fn`, pos)
        }
        this.charge(cost.points, 'minkowski()', pos)
        acc = minkowski2(acc, b)
      }
      return { dim: 2, p: acc.length ? [{ r: acc, color }] : [] }
    }
    const kept = this.keepDim<Extract<Shape, { dim: 3 }>>(shapes, 3, pos).filter((s) => s.p.length > 0)
    if (kept.length === 0) return { dim: 3, p: [] }
    const color = commonColor(kept.flatMap((s) => s.p.map((p) => p.color)))
    if (kept.length === 1) return kept[0] // the minkowski sum of one shape is the shape
    // convex cells of every operand (pieces of one operand just add their cells: minkowski distributes over union)
    const cellsOf = (s: Extract<Shape, { dim: 3 }>): Vec3[][] => {
      const cells: Vec3[][] = []
      for (const p of s.p) {
        const polys = polysOf(p.g)
        if (polys.length === 0) continue
        const c = p.convex ? [uniquePoints(verticesOf([p]))] : convexCells(polys, MINKOWSKI_MAX_HULLS)
        if (!c) throw new ScadError('limit', `minkowski() is too heavy: a non-convex child splits into more than ${thousands(MINKOWSKI_MAX_HULLS)} convex pieces — simplify it or lower $fn`, pos)
        for (const q of c) cells.push(q)
      }
      return cells
    }
    let acc = cellsOf(kept[0])
    for (const s of kept.slice(1)) {
      const b = cellsOf(s)
      if (acc.length * b.length > MINKOWSKI_MAX_HULLS) {
        throw new ScadError('limit', `minkowski() is too heavy: ${thousands(acc.length)} × ${thousands(b.length)} convex pieces (the limit is ${thousands(MINKOWSKI_MAX_HULLS)} pairs) — simplify the non-convex children or lower $fn`, pos)
      }
      let points = 0
      for (const x of acc) for (const y of b) points += x.length * y.length
      this.charge(points, 'minkowski()', pos)
      // reduce each summed cell to its hull vertices before the next operand
      acc = minkowskiSums(acc, b).map((pts) => hullVertices(pts)).filter((pts) => pts.length >= 4)
    }
    const hulls = acc.map((pts) => hull3(pts)).filter((g): g is Geom3 => g !== null)
    if (hulls.length === 0) return { dim: 3, p: [] }
    const g = hulls.length === 1 ? hulls[0] : unionMany(hulls.map((h) => ({ g: h, convex: true })), (n) => { if (n > 0) this.charge(n, 'minkowski()', pos) })
    return { dim: 3, p: [{ g, color, convex: hulls.length === 1 }] }
  }

  // ───────────────────────────── top level ─────────────────────────────

  top(nodes: GeomNode[]): Geom3[] {
    const shapes = nodes.map((n) => this.walk(n))
    const has3 = shapes.some((s) => s.dim === 3)
    const has2 = shapes.some((s) => s.dim === 2)
    if (has3) {
      if (has2) {
        this.warn(WARN_MIXING, nodes.find((_, i) => shapes[i].dim === 2)?.pos)
        nodes.forEach((n, i) => { if (shapes[i].dim === 2) this.warn('Ignoring 2D child object for 3D operation', n.pos) })
      }
      const out: Geom3[] = []
      for (const s of shapes) if (s.dim === 3) for (const p of s.p) out.push(p.color ? jscad.colors.colorize(p.color, p.g) : p.g)
      return out
    }
    if (!has2) return []
    const flat: Shape = { dim: 2, p: shapes.flatMap((s) => (s.dim === 2 ? s.p : [])) }
    const merged = this.unionByColor(flat) as Extract<Shape, { dim: 2 }>
    if (merged.p.length === 0) return []
    this.warn(WARN_2D_TOP)
    const frag: Fragments = { fn: 0, fa: 12, fs: 2 }
    const out: Geom3[] = []
    for (const p of merged.p) {
      const polys = linearExtrude(p.r, { height: 1, center: true, twist: 0, scale: [1, 1], frag }, 1)
      this.charge(polys.length, '2D preview', undefined)
      const g = solid(polys)
      out.push(p.color ? jscad.colors.colorize(p.color, g) : g)
    }
    return out
  }
}

const f64 = new Float64Array(1)
const u32 = new Uint32Array(f64.buffer)
const hashNum = (x: number): number => { f64[0] = x === 0 ? 0 : x; return (u32[0] ^ Math.imul(u32[1], 0x9e3779b1)) | 0 }

/** The distinct points (exact coordinates; 0 and -0 are the same), first occurrence first. A numeric hash: string
 *  keys took seconds for the half a million vertices of a hull of many spheres. */
function uniquePoints(pts: Iterable<Vec3>): Vec3[] {
  const seen = new Map<number, Vec3 | Vec3[]>()
  const out: Vec3[] = []
  const same = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
  for (const p of pts) {
    const k = (Math.imul(Math.imul(hashNum(p[0]), 31) + hashNum(p[1]), 31) + hashNum(p[2])) & 0x3fffffff // a small integer key
    const e = seen.get(k)
    if (e === undefined) { seen.set(k, p); out.push(p); continue }
    if (Array.isArray(e[0])) {
      const l = e as Vec3[]
      if (l.some((q) => same(q, p))) continue
      l.push(p)
    } else {
      if (same(e as Vec3, p)) continue
      seen.set(k, [e as Vec3, p])
    }
    out.push(p)
  }
  return out
}

function* verticesOf(pieces: { g: Geom3 }[]): Generator<Vec3> {
  for (const x of pieces) for (const p of geom3.toPolygons(x.g)) yield* p.vertices as unknown as Vec3[]
}

/** Drops points that are surely inside the hull (inside the hull of the extreme points along 26 directions, by a
 *  margin), so quickhull gets only the candidates. The hull itself is unchanged. */
function hullCandidates(pts: Vec3[]): Vec3[] {
  if (pts.length < 2000) return pts
  const dirs: Vec3[] = []
  for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) dirs.push([x, y, z])
  const ext: Vec3[] = dirs.map(() => pts[0])
  const best = dirs.map((d) => d[0] * pts[0][0] + d[1] * pts[0][1] + d[2] * pts[0][2])
  let size = 0
  for (const p of pts) {
    size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]))
    for (let i = 0; i < dirs.length; i++) {
      const d = dirs[i], v = d[0] * p[0] + d[1] * p[1] + d[2] * p[2]
      if (v > best[i]) { best[i] = v; ext[i] = p }
    }
  }
  const core = hull3(ext)
  if (!core) return pts
  const planes = geom3.toPolygons(core).map((p) => poly3.plane(p))
  const margin = 1e-9 * Math.max(size, 1)
  return pts.filter((p) => planes.some((pl) => pl[0] * p[0] + pl[1] * p[1] + pl[2] * p[2] - pl[3] > -margin))
}

function hull3(pts: Vec3[], unique = false): Geom3 | null {
  const u = unique ? pts : uniquePoints(pts)
  if (u.length < 4) return null
  try {
    const polys = jscad.hulls.hullPoints3(u as unknown as Parameters<typeof jscad.hulls.hullPoints3>[0])
    return polys.length ? geom3.create(polys) : null
  } catch {
    return null // flat or degenerate point set
  }
}

function hullVertices(pts: Vec3[]): Vec3[] {
  const g = hull3(pts)
  return g ? uniquePoints(verticesOf([{ g }])) : []
}

/** Build with source positions on the warnings (runScad uses this). */
export function buildScad(nodes: GeomNode[], ctx: BuildContext): BuildOutput {
  const b = new Builder(ctx)
  try {
    return { geoms: b.top(nodes), messages: b.messages }
  } catch (e) {
    // the JS engine's own limits (stack, array size, memory for one array) are reported as too much geometry
    const err = e instanceof RangeError ? new ScadError('limit', `Too much geometry for this page to build (${e.message})`) : e
    // keep the warnings printed so far with the error, like the console would show them
    if (err instanceof ScadError) err.messages = [...(err.messages ?? []), ...b.messages]
    throw err
  }
}

export const build: Build = (nodes, ctx) => {
  const r = buildScad(nodes, ctx)
  return { geoms: r.geoms, warnings: r.messages.map((m) => m.text) }
}
