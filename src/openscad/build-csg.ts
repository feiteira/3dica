// 3D booleans (difference, union, intersection), fast. JSCAD's subtract(a, b, c, …) subtracts one cutter at a time and
// rebuilds the BSP tree of the whole growing result for each one, which is quadratic (a plate with 150 holes took
// seconds), and its union of many overlapping solids is as slow. Here the result's surface is assembled piece by
// piece instead, with the same rules (and so the same surface) as JSCAD's booleans:
//   difference  the base's faces, each clipped only by the cutters whose boxes it touches, plus each cutter's faces
//               that lie inside the base (classified once against one BSP tree of the base) and outside the other
//               cutters, turned inwards
//   union       each solid's faces outside the solids it touches
//   intersection  the faces of each operand inside the other, pairwise
// Convex solids (primitives, hulls) get their BSP tree directly: it is a chain of their planes.
// The BSP rules follow JSCAD's: planes from the polygon in the middle of each list, EPS = 1e-5 for "on the plane",
// coplanar faces facing the same way count as in front (outside) unless asked otherwise, and a polygon that was split
// but kept whole comes back unsplit. The result is retessellated once at the end, as JSCAD does.
import jscad from '@jscad/modeling'
import type { Geom3 } from '@jscad/modeling/src/geometries/types'
import type { Vec3 } from './types'

const { geom3, poly3 } = jscad.geometries
const EPS = 1e-5
const EPS2 = EPS * EPS

type Plane = [number, number, number, number]
interface Poly { v: Vec3[]; pl: Plane; box?: Box }
type Box = [number, number, number, number, number, number]

/** JSCAD's plane of a polygon: the normalised sum of the normals at every vertex */
function planeOf(v: Vec3[]): Plane {
  const n = v.length
  let x = 0, y = 0, z = 0
  const add = (i: number) => {
    const a = v[i], b = v[(i + 1) % n], c = v[(i + 2) % n]
    const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2]
    const cx = c[0] - a[0], cy = c[1] - a[1], cz = c[2] - a[2]
    let nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx
    const l = Math.hypot(nx, ny, nz)
    if (l > 0) { nx /= l; ny /= l; nz /= l }
    x += nx; y += ny; z += nz
  }
  if (n === 3) add(0)
  else for (let i = 0; i < n; i++) add(i)
  const l = Math.hypot(x, y, z)
  if (l > 0) { x /= l; y /= l; z /= l }
  return [x, y, z, x * v[0][0] + y * v[0][1] + z * v[0][2]]
}

function boxOfPoly(p: Poly): Box {
  if (p.box) return p.box
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (const q of p.v) {
    if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]
    if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]
    if (q[2] < z0) z0 = q[2]; if (q[2] > z1) z1 = q[2]
  }
  return (p.box = [x0, y0, z0, x1, y1, z1])
}

function boxOfPolys(ps: Poly[]): Box {
  const b: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const p of ps) {
    const q = boxOfPoly(p)
    for (let k = 0; k < 3; k++) { if (q[k] < b[k]) b[k] = q[k]; if (q[k + 3] > b[k + 3]) b[k + 3] = q[k + 3] }
  }
  return b
}

const touch = (a: Box, b: Box): boolean =>
  a[0] <= b[3] + EPS && b[0] <= a[3] + EPS && a[1] <= b[4] + EPS && b[1] <= a[4] + EPS && a[2] <= b[5] + EPS && b[2] <= a[5] + EPS

const flip = (p: Poly): Poly => ({ v: [...p.v].reverse(), pl: [-p.pl[0], -p.pl[1], -p.pl[2], -p.pl[3]], box: p.box })

// where a polygon is relative to a plane
const CO_FRONT = 0, CO_BACK = 1, FRONT = 2, BACK = 3, SPLIT = 4
type Side = 0 | 1 | 2 | 3 | 4

/** Where `p` is relative to plane `s`; for Split also the two parts (either may vanish when tiny). */
function split(s: Plane, p: Poly): { side: Side; front?: Poly; back?: Poly } {
  const pl = p.pl
  if (pl[0] === s[0] && pl[1] === s[1] && pl[2] === s[2] && pl[3] === s[3]) return { side: CO_FRONT }
  const v = p.v, n = v.length
  let hasF = false, hasB = false
  const isBack: boolean[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const t = s[0] * v[i][0] + s[1] * v[i][1] + s[2] * v[i][2] - s[3]
    isBack[i] = t < -EPS
    if (t > EPS) hasF = true
    if (t < -EPS) hasB = true
  }
  if (!hasF && !hasB) return { side: s[0] * pl[0] + s[1] * pl[1] + s[2] * pl[2] >= 0 ? CO_FRONT : CO_BACK }
  if (!hasB) return { side: FRONT }
  if (!hasF) return { side: BACK }
  const fv: Vec3[] = [], bv: Vec3[] = []
  for (let i = 0; i < n; i++) {
    const a = v[i], j = (i + 1) % n, b = v[j]
    if (isBack[i] === isBack[j]) { (isBack[i] ? bv : fv).push(a); continue }
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    let lambda = (s[3] - (s[0] * a[0] + s[1] * a[1] + s[2] * a[2])) / (s[0] * dx + s[1] * dy + s[2] * dz)
    if (Number.isNaN(lambda)) lambda = 0
    if (lambda > 1) lambda = 1
    if (lambda < 0) lambda = 0
    const x: Vec3 = [a[0] + dx * lambda, a[1] + dy * lambda, a[2] + dz * lambda]
    if (isBack[i]) bv.push(a, x); else fv.push(a, x)
    if (isBack[i]) fv.push(x); else bv.push(x)
  }
  const out: { side: Side; front?: Poly; back?: Poly } = { side: SPLIT }
  const f = dedupe(fv), b = dedupe(bv)
  if (f.length >= 3) out.front = { v: f, pl }
  if (b.length >= 3) out.back = { v: b, pl }
  return out
}

function dedupe(vs: Vec3[]): Vec3[] {
  if (vs.length < 3) return vs
  const out: Vec3[] = []
  let prev = vs[vs.length - 1]
  for (const v of vs) {
    const dx = v[0] - prev[0], dy = v[1] - prev[1], dz = v[2] - prev[2]
    if (dx * dx + dy * dy + dz * dz >= EPS2) out.push(v)
    prev = v
  }
  return out
}

// ───────────────────────────── BSP tree (classification only) ─────────────────────────────

interface Node { plane: Plane; front: Node | null; back: Node | null }

/** A BSP tree of a closed solid's polygons (built iteratively: trees of convex solids are chains). */
function buildTree(polys: Poly[]): Node | null {
  if (polys.length === 0) return null
  const root: Node = { plane: polys[polys.length >> 1].pl, front: null, back: null }
  const stack: { node: Node; ps: Poly[] }[] = [{ node: root, ps: polys }]
  while (stack.length) {
    const { node, ps } = stack.pop()!
    const front: Poly[] = [], back: Poly[] = []
    for (const p of ps) {
      const r = split(node.plane, p)
      switch (r.side) {
        case CO_FRONT: break
        case CO_BACK: case BACK: back.push(p); break
        case FRONT: front.push(p); break
        default: if (r.front) front.push(r.front); if (r.back) back.push(r.back)
      }
    }
    if (front.length) { node.front = { plane: front[front.length >> 1].pl, front: null, back: null }; stack.push({ node: node.front, ps: front }) }
    if (back.length) { node.back = { plane: back[back.length >> 1].pl, front: null, back: null }; stack.push({ node: node.back, ps: back }) }
  }
  return root
}

/** The tree of a convex solid is a chain of its planes (every face is behind every other face's plane): built
 *  directly, which saves the quadratic sorting of a fine sphere's faces. The planes are taken in the order buildTree
 *  takes them (the middle of what is left), so the faces are split in the same order. */
function convexTree(polys: Poly[]): Node | null {
  const n = polys.length
  // a Fenwick tree over the faces still left, to find "the middle one" in O(log n)
  const fw = new Int32Array(n + 1)
  const addAt = (i: number, d: number) => { for (let k = i + 1; k <= n; k += k & -k) fw[k] += d }
  for (let i = 0; i < n; i++) addAt(i, 1)
  let top = 1
  while (top * 2 <= n) top *= 2
  const kth = (k: number) => { // index of the k-th (0-based) face left
    let pos = 0
    for (let step = top; step > 0; step >>= 1) if (pos + step <= n && fw[pos + step] <= k) { pos += step; k -= fw[pos] }
    return pos
  }
  const samePlane = new Map<string, number[]>()
  polys.forEach((p, i) => {
    const key = p.pl.join(',')
    const l = samePlane.get(key)
    if (l) l.push(i); else samePlane.set(key, [i])
  })
  const gone = new Uint8Array(n)
  const root: Node = { plane: [0, 0, 0, 0], front: null, back: null }
  let tail = root
  for (let left = n; left > 0;) {
    const i = kth(left >> 1)
    const node: Node = { plane: polys[i].pl, front: null, back: null }
    tail.back = node
    tail = node
    // faces in the same plane are filed with this one
    for (const j of samePlane.get(polys[i].pl.join(',')) ?? [i]) if (!gone[j]) { gone[j] = 1; addAt(j, -1); left-- }
  }
  return root.back
}

function invertTree(root: Node | null): Node | null {
  if (!root) return null
  const stack = [root]
  while (stack.length) {
    const n = stack.pop()!
    n.plane = [-n.plane[0], -n.plane[1], -n.plane[2], -n.plane[3]]
    const t = n.front; n.front = n.back; n.back = t
    if (n.front) stack.push(n.front)
    if (n.back) stack.push(n.back)
  }
  return root
}

/** A fragment of an input polygon; split fragments keep their parts, so an intact polygon comes back whole. */
interface Frag { p: Poly; parent: Frag | null; kids: Frag[] | null; removed: boolean; broken: boolean }

function remove(f: Frag): void {
  f.removed = true
  for (let q = f.parent; q && !q.broken; q = q.parent) q.broken = true
}

function collect(f: Frag, out: Poly[]): void {
  const stack = [f]
  while (stack.length) {
    const g = stack.pop()!
    if (g.removed) continue
    if (!g.broken) { out.push(g.p); continue }
    if (g.kids) for (let i = g.kids.length - 1; i >= 0; i--) stack.push(g.kids[i])
  }
}

/** The parts of `polys` outside the solid of `tree` (coplanar faces facing the same way count as outside unless
 *  `removeCoplanarFront`; facing the other way they count as inside). */
function clip(polys: Poly[], tree: Node | null, removeCoplanarFront: boolean): Poly[] {
  if (!tree || polys.length === 0) return polys
  const roots: Frag[] = polys.map((p) => ({ p, parent: null, kids: null, removed: false, broken: false }))
  const stack: { node: Node; fs: Frag[] }[] = [{ node: tree, fs: roots }]
  while (stack.length) {
    const { node, fs } = stack.pop()!
    const front: Frag[] = [], back: Frag[] = []
    for (const f of fs) {
      const r = split(node.plane, f.p)
      switch (r.side) {
        case CO_FRONT: (removeCoplanarFront ? back : front).push(f); break
        case CO_BACK: case BACK: back.push(f); break
        case FRONT: front.push(f); break
        default: {
          f.kids = []
          if (r.front) { const k = { p: r.front, parent: f, kids: null, removed: false, broken: false }; f.kids.push(k); front.push(k) }
          if (r.back) { const k = { p: r.back, parent: f, kids: null, removed: false, broken: false }; f.kids.push(k); back.push(k) }
        }
      }
    }
    if (node.front && front.length) stack.push({ node: node.front, fs: front })
    if (node.back && back.length) stack.push({ node: node.back, fs: back })
    else for (const f of back) remove(f)
  }
  const out: Poly[] = []
  for (const r of roots) collect(r, out)
  return out
}

/** Splits `p` along the faces of `box` (grown a little): the part inside goes to `inside`, the rest to `outside`. */
function cutToBox(p: Poly, box: Box, inside: Poly[], outside: Poly[]): void {
  const m = 1e3 * EPS
  const planes: Plane[] = [[1, 0, 0, box[3] + m], [-1, 0, 0, -box[0] + m], [0, 1, 0, box[4] + m], [0, -1, 0, -box[1] + m], [0, 0, 1, box[5] + m], [0, 0, -1, -box[2] + m]]
  let cur: Poly | undefined = p
  for (const pl of planes) {
    if (!cur) return
    const b = boxOfPoly(cur)
    // already on the inner side of this plane: nothing to cut
    if (pl[0] * (pl[0] > 0 ? b[3] : b[0]) + pl[1] * (pl[1] > 0 ? b[4] : b[1]) + pl[2] * (pl[2] > 0 ? b[5] : b[2]) <= pl[3]) continue
    const r = split(pl, cur)
    if (r.side === FRONT) { outside.push(cur); return }
    if (r.side !== SPLIT) continue
    if (r.front) outside.push(r.front)
    cur = r.back
  }
  if (cur) inside.push(cur)
}

const fromGeom = (g: Geom3): Poly[] =>
  geom3.toPolygons(g).map((p) => ({ v: p.vertices as unknown as Vec3[], pl: (p.plane as unknown as Plane | undefined) ?? planeOf(p.vertices as unknown as Vec3[]) }))

function toGeom(polys: Poly[]): Geom3 {
  return geom3.create(polys.map((p) => {
    const q = poly3.create(p.v as unknown as Parameters<typeof poly3.create>[0])
    ;(q as unknown as { plane: Plane }).plane = p.pl
    return q
  }))
}

export interface Solid { g: Geom3; /** known convex (primitives, hulls): its BSP tree is built directly */ convex?: boolean }

/** An operand: its polygons, box and (built when first needed) its BSP tree and the tree of its complement. */
interface Operand { ps: Poly[]; box: Box; convex: boolean; tree?: Node | null; inv?: Node | null }

const operand = (s: Solid): Operand => { const ps = fromGeom(s.g); return { ps, box: boxOfPolys(ps), convex: s.convex === true } }
const make = (o: Operand) => (o.convex ? convexTree(o.ps) : buildTree(o.ps))
const treeOf = (o: Operand) => (o.tree === undefined ? (o.tree = make(o)) : o.tree)
const notTreeOf = (o: Operand) => (o.inv === undefined ? (o.inv = invertTree(make(o))) : o.inv)

/** How the polygons near one operand are clipped by it: parts inside it go, and its coplanar faces decide the rest. */
type Rule = (near: Poly[], o: Operand) => Poly[]
/** outside it; a coplanar face facing the same way stays (JSCAD's a.clipTo(b)) */
const OUTSIDE: Rule = (near, o) => clip(near, treeOf(o), false)
/** outside it; a coplanar face facing the same way goes too (b.clipTo(a, true): the other copy stays) */
const OUTSIDE_NOT_SHARED: Rule = (near, o) => clip(near, treeOf(o), true)
/** the second operand of JSCAD's union: outside it, then flipped and clipped again, which drops shared faces */
const OUTSIDE_UNION: Rule = (near, o) => clip(clip(near, treeOf(o), false).map(flip), treeOf(o), false).map(flip)

/**
 * `ps` clipped by each operand in turn (only the polygons near it). A polygon larger than an operand's box is first
 * cut along the box, so only the part inside meets that operand's planes: otherwise every cut would run across the
 * whole face and a plate with thousands of holes would end up in millions of slivers.
 */
function clipByEach(ps: Poly[], grid: Grid, by: { o: Operand; rule: Rule }[], charge: (n: number) => void): Poly[] {
  if (by.length === 0 || ps.length === 0) return ps
  const index = new PolyIndex(grid)
  for (const p of ps) index.add(p)
  for (const { o, rule } of by) {
    const near = index.take(o.box)
    if (!near.length) continue
    const inside: Poly[] = [], rest: Poly[] = []
    for (const p of near) cutToBox(p, o.box, inside, rest)
    for (const p of rest) index.add(p)
    const kept = rule(inside, o)
    for (const p of kept) index.add(p)
    charge(rest.length + kept.length - near.length)
  }
  return index.all()
}

/** For each operand, the others whose boxes touch it, in order (found through the grid). */
function neighbours(ops: { box: Box }[], grid: Grid): number[][] {
  const byCell = new Map<number, number[]>()
  ops.forEach((o, i) => grid.each(o.box, (k) => { const l = byCell.get(k); if (l) l.push(i); else byCell.set(k, [i]) }))
  return ops.map((o, i) => {
    const near = new Set<number>()
    grid.each(o.box, (k) => { for (const j of byCell.get(k) ?? []) if (j !== i && touch(o.box, ops[j].box)) near.add(j) })
    return [...near].sort((a, b) => a - b)
  })
}

const result = (all: Poly[]): Geom3 => jscad.modifiers.retessellate(toGeom(all)) as Geom3

/**
 * base minus all cutters, with the surface JSCAD's one-at-a-time subtract would give. `charge` is told how many
 * polygons the clipping adds (a heavy difference makes many fragments: that is the memory).
 */
export function subtractMany(base: Solid, cutters: Solid[], charge: (polygons: number) => void = () => {}): Geom3 {
  const A = operand(base)
  if (A.ps.length === 0) return base.g
  const cs = cutters.map(operand).filter((c) => c.ps.length > 0 && touch(c.box, A.box))
  if (cs.length === 0) return base.g
  const grid = new Grid(A.box, cs.length)
  // the base's faces, inverted as in JSCAD's subtract, clipped by each cutter they touch
  const all = clipByEach(A.ps.map(flip), grid, cs.map((o) => ({ o, rule: OUTSIDE })), charge).map(flip)
  // each cutter's faces inside the base and outside the cutters before it (shared faces dropped) and after it,
  // turned inwards
  const near = neighbours(cs, grid)
  cs.forEach((c, i) => {
    const ps = clipByEach(clip(c.ps, notTreeOf(A), true), grid, near[i].map((j) => ({ o: cs[j], rule: j < i ? OUTSIDE_NOT_SHARED : OUTSIDE })), charge)
    for (const p of ps) all.push(flip(p))
    charge(ps.length)
  })
  return result(all)
}

/**
 * The union of solids, with the surface JSCAD's union would give: each solid's faces outside all the others it
 * touches (where two faces coincide, the earlier solid's copy stays). Solids that touch nothing are just added.
 */
export function unionMany(solids: Solid[], charge: (polygons: number) => void = () => {}): Geom3 {
  const ops = solids.map(operand).filter((o) => o.ps.length > 0)
  if (ops.length === 0) return geom3.create()
  if (ops.length === 1) return toGeom(ops[0].ps)
  const box: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const o of ops) for (let k = 0; k < 3; k++) { box[k] = Math.min(box[k], o.box[k]); box[k + 3] = Math.max(box[k + 3], o.box[k + 3]) }
  const grid = new Grid(box, ops.length)
  const near = neighbours(ops, grid)
  const all: Poly[] = []
  ops.forEach((o, i) => {
    const ps = clipByEach(o.ps, grid, near[i].map((j) => ({ o: ops[j], rule: j < i ? OUTSIDE_UNION : OUTSIDE })), charge)
    for (const p of ps) all.push(p)
  })
  return result(all)
}

/** Do two touching boxes share volume or a face (at most one axis where they only meet)? */
function shareFace(a: Box, b: Box): boolean {
  let thin = 0
  for (let k = 0; k < 3; k++) if (Math.min(a[k + 3], b[k + 3]) - Math.max(a[k], b[k]) <= EPS) thin++
  return thin <= 1
}

/**
 * The union of solids as one or more solids: those that share volume or a face are merged (unionMany); groups that
 * only meet along an edge or at a corner stay apart. Such a union is not a closed manifold (an edge with four faces),
 * and BSP clipping of it leaves stray faces: a later difference or intersection would come out open, with faces
 * outside the shape (checkerboards, stairs, lattices). Kept apart they are the same set, and (A ∪ B) − C =
 * (A − C) ∪ (B − C) is clipped piece by piece. A solid left on its own is returned as it was given.
 */
export function unionParts(solids: Solid[], charge: (polygons: number) => void = () => {}): Solid[] {
  const items = solids.filter((s) => geom3.toPolygons(s.g).length > 0)
  if (items.length <= 1) return items
  const boxes = items.map((s) => boxOfPolys(fromGeom(s.g)))
  const all: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const b of boxes) for (let k = 0; k < 3; k++) { all[k] = Math.min(all[k], b[k]); all[k + 3] = Math.max(all[k + 3], b[k + 3]) }
  const near = neighbours(boxes.map((box) => ({ box })), new Grid(all, items.length))
  const up = items.map((_, i) => i)
  const root = (i: number): number => { while (up[i] !== i) { up[i] = up[up[i]]; i = up[i] } return i }
  near.forEach((js, i) => { for (const j of js) if (j > i && shareFace(boxes[i], boxes[j])) up[root(j)] = root(i) })
  const groups = new Map<number, Solid[]>()
  items.forEach((s, i) => { const r = root(i); const g = groups.get(r); if (g) g.push(s); else groups.set(r, [s]) })
  const out: Solid[] = []
  for (const g of groups.values()) out.push(g.length === 1 ? g[0] : { g: unionMany(g, charge), convex: false })
  return out
}

/**
 * first ∩ each of the others in turn, with the surface JSCAD's intersect would give. Faces away from the other
 * operand's box are dropped before any clipping (they are outside it).
 */
export function intersectMany(first: Solid, others: Solid[], charge: (polygons: number) => void = () => {}): Geom3 {
  let cur = operand(first)
  for (const s of others) {
    const o = operand(s)
    if (cur.ps.length === 0 || o.ps.length === 0 || !touch(cur.box, o.box)) return geom3.create()
    const within = (ps: Poly[], box: Box): Poly[] => {
      const inside: Poly[] = [], away: Poly[] = []
      for (const p of ps) if (touch(boxOfPoly(p), box)) cutToBox(p, box, inside, away)
      return inside
    }
    // JSCAD: a = ¬A; b.clipTo(a); b = ¬b; a.clipTo(b); b.clipTo(a); result = ¬(a ∪ b)
    const notA = notTreeOf(cur), notB = notTreeOf(o)
    const aPart = clip(within(cur.ps, o.box).map(flip), notB, false)
    const bPart = clip(clip(within(o.ps, cur.box), notA, false).map(flip), notA, false)
    const ps = aPart.map(flip).concat(bPart.map(flip))
    charge(ps.length)
    cur = { ps, box: ps.length ? boxOfPolys(ps) : cur.box, convex: cur.convex && o.convex }
  }
  return result(cur.ps)
}

/** A uniform grid over a box with about `n` cells per object (at most 64 per axis), for finding what is near. */
class Grid {
  private readonly lo: number[]
  private readonly size: number[]
  private readonly dims: number[]
  constructor(box: Box, objects: number) {
    const ext = [box[3] - box[0], box[4] - box[1], box[5] - box[2]].map((e) => Math.max(e, 1e-9))
    // cells about as many as objects, shaped like the box (a plate gets a flat grid)
    const cell = Math.cbrt((ext[0] * ext[1] * ext[2]) / Math.max(1, objects)) || 1
    this.dims = ext.map((e) => Math.max(1, Math.min(64, Math.ceil(e / cell))))
    this.lo = [box[0], box[1], box[2]]
    this.size = ext.map((e, k) => e / this.dims[k])
  }
  /** calls fn with the key of every cell `b` overlaps */
  each(b: Box, fn: (key: number) => void): void {
    const r: number[] = []
    for (let k = 0; k < 3; k++) {
      const a = Math.floor((b[k] - EPS - this.lo[k]) / this.size[k]), z = Math.floor((b[k + 3] + EPS - this.lo[k]) / this.size[k])
      r.push(Math.max(0, Math.min(this.dims[k] - 1, a)), Math.max(0, Math.min(this.dims[k] - 1, z)))
    }
    for (let x = r[0]; x <= r[1]; x++) for (let y = r[2]; y <= r[3]; y++) for (let z = r[4]; z <= r[5]; z++) fn((x * this.dims[1] + y) * this.dims[2] + z)
  }
}

/** Polygons filed by grid cell; take(box) removes and returns the ones whose boxes touch `box`. */
class PolyIndex {
  private readonly grid: Grid
  private readonly cells = new Map<number, { p: Poly; alive: boolean }[]>()
  private readonly live = new Set<{ p: Poly; alive: boolean }>()
  constructor(grid: Grid) { this.grid = grid }
  add(p: Poly): void {
    const e = { p, alive: true }
    this.live.add(e)
    this.grid.each(boxOfPoly(p), (k) => { const l = this.cells.get(k); if (l) l.push(e); else this.cells.set(k, [e]) })
  }
  take(b: Box): Poly[] {
    const out: Poly[] = []
    this.grid.each(b, (k) => {
      const l = this.cells.get(k)
      if (!l) return
      let w = 0
      for (const e of l) {
        if (!e.alive) continue // dropped from every cell lazily
        if (touch(boxOfPoly(e.p), b)) { e.alive = false; this.live.delete(e); out.push(e.p) } else l[w++] = e
      }
      l.length = w
    })
    return out
  }
  all(): Poly[] { return [...this.live].map((e) => e.p) }
}
