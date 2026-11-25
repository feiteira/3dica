// minkowski(): exact for convex operands (the hull of all pairwise vertex sums). Non-convex operands are split into
// convex pieces first — 2D regions into triangles, solids into the solid cells of a BSP tree built from their faces
// (each solid cell is the intersection of half-spaces, so convex) — and the result is the union of the hulls of
// every pair of pieces, as OpenSCAD does with CGAL's convex decomposition.
import type { Vec2, Vec3 } from './types'
import { hull2, union2, type Loop, type Region } from './build-2d'
import { triangulateRegion } from './build-tri'

// ───────────────────────────── 2D ─────────────────────────────

function isConvexLoop(l: Loop): boolean {
  const n = l.length
  for (let i = 0; i < n; i++) {
    const a = l[i], b = l[(i + 1) % n], c = l[(i + 2) % n]
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) < 0) return false
  }
  return true
}

/** Convex pieces of a region (point lists). */
export function convexPieces2(r: Region): Vec2[][] {
  if (r.length === 1 && isConvexLoop(r[0])) return [r[0]]
  const { points, tris } = triangulateRegion(r)
  return tris.map((t) => t.map((i) => points[i]))
}

/** Pieces count product, for the budget check before the work starts. */
export function minkowski2Cost(a: Region, b: Region): { hulls: number; points: number } {
  const pa = convexPieces2(a), pb = convexPieces2(b)
  let points = 0
  for (const x of pa) for (const y of pb) points += x.length * y.length
  return { hulls: pa.length * pb.length, points }
}

export function minkowski2(a: Region, b: Region): Region {
  if (a.length === 0 || b.length === 0) return []
  const pa = convexPieces2(a), pb = convexPieces2(b)
  const hulls: Region[] = []
  for (const x of pa) for (const y of pb) {
    const sums: Vec2[] = []
    for (const p of x) for (const q of y) sums.push([p[0] + q[0], p[1] + q[1]])
    const h = hull2(sums)
    if (h.length) hulls.push([h])
  }
  return union2(hulls)
}

// ───────────────────────────── 3D: convex decomposition ─────────────────────────────

interface Plane { n: Vec3; w: number }

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

function planeOf(p: Vec3[]): Plane | null {
  // Newell normal, robust for any planar polygon
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length]
    nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1])
    cx += a[0]; cy += a[1]; cz += a[2]
  }
  const l = Math.hypot(nx, ny, nz)
  if (!(l > 0)) return null
  const n: Vec3 = [nx / l, ny / l, nz / l]
  return { n, w: (n[0] * cx + n[1] * cy + n[2] * cz) / p.length }
}

/** Splits a convex polygon by a plane; parts with fewer than 3 points are dropped. */
function splitPoly(p: Vec3[], pl: Plane, eps: number): { front: Vec3[] | null; back: Vec3[] | null; on: Vec3[] } {
  const d = p.map((v) => dot(pl.n, v) - pl.w)
  const front: Vec3[] = [], back: Vec3[] = [], on: Vec3[] = []
  for (let i = 0; i < p.length; i++) {
    const j = (i + 1) % p.length
    const a = p[i], da = d[i], db = d[j]
    if (da > eps) front.push(a)
    else if (da < -eps) back.push(a)
    else { front.push(a); back.push(a); on.push(a) }
    if ((da > eps && db < -eps) || (da < -eps && db > eps)) {
      const t = da / (da - db), b = p[j]
      const x: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
      front.push(x); back.push(x); on.push(x)
    }
  }
  return { front: front.length >= 3 ? front : null, back: back.length >= 3 ? back : null, on }
}

/** Orders points lying in a plane counter-clockwise around normal n (a convex polygon). */
function capPolygon(pts: Vec3[], n: Vec3, eps: number): Vec3[] | null {
  const uniq: Vec3[] = []
  for (const p of pts) if (!uniq.some((q) => Math.abs(q[0] - p[0]) <= eps && Math.abs(q[1] - p[1]) <= eps && Math.abs(q[2] - p[2]) <= eps)) uniq.push(p)
  if (uniq.length < 3) return null
  const c: Vec3 = [0, 0, 0]
  for (const p of uniq) { c[0] += p[0] / uniq.length; c[1] += p[1] / uniq.length; c[2] += p[2] / uniq.length }
  // basis in the plane
  const ref: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u: Vec3 = [n[1] * ref[2] - n[2] * ref[1], n[2] * ref[0] - n[0] * ref[2], n[0] * ref[1] - n[1] * ref[0]]
  const ul = Math.hypot(u[0], u[1], u[2]); u[0] /= ul; u[1] /= ul; u[2] /= ul
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]
  const ang = (p: Vec3) => { const d: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]; return Math.atan2(dot(d, v), dot(d, u)) }
  return uniq.sort((a, b) => ang(a) - ang(b))
}

/** Clips a convex cell (closed convex polygons) by a plane into its front and back halves. */
function clipCell(cell: Vec3[][], pl: Plane, eps: number): { front: Vec3[][]; back: Vec3[][] } {
  const front: Vec3[][] = [], back: Vec3[][] = [], cut: Vec3[] = []
  for (const f of cell) {
    const s = splitPoly(f, pl, eps)
    if (s.front) front.push(s.front)
    if (s.back) back.push(s.back)
    for (const q of s.on) cut.push(q)
  }
  const cap = capPolygon(cut, pl.n, eps)
  if (cap && front.length && back.length) {
    back.push(cap)
    front.push([...cap].reverse())
  }
  return { front, back }
}

function cellVolumeSign(cell: Vec3[][]): number {
  let v = 0
  for (const p of cell) for (let i = 1; i + 1 < p.length; i++) {
    const a = p[0], b = p[i], c = p[i + 1]
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
  }
  return v / 6
}

/** Is a closed polygon set convex (every vertex behind every face plane)? */
export function isConvexSolid(polys: Vec3[][]): boolean {
  let size = 0
  const verts: Vec3[] = []
  const seen = new Set<string>()
  for (const p of polys) for (const v of p) {
    size = Math.max(size, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]))
    const k = v[0] + ',' + v[1] + ',' + v[2]
    if (!seen.has(k)) { seen.add(k); verts.push(v) }
  }
  const eps = 1e-9 * Math.max(size, 1e-300)
  for (const p of polys) {
    const pl = planeOf(p)
    if (!pl) continue
    for (const v of verts) if (dot(pl.n, v) - pl.w > eps) return false
  }
  return true
}

/**
 * Convex cells (vertex lists) whose union is the closed solid `polys` (outward-facing convex polygons).
 * `maxCells` stops a decomposition that would explode.
 */
export function convexCells(polys: Vec3[][], maxCells: number): Vec3[][] | null {
  if (isConvexSolid(polys)) {
    const seen = new Set<string>(), out: Vec3[] = []
    for (const p of polys) for (const v of p) { const k = v.join(','); if (!seen.has(k)) { seen.add(k); out.push(v) } }
    return [out]
  }
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (const p of polys) for (const v of p) {
    x0 = Math.min(x0, v[0]); y0 = Math.min(y0, v[1]); z0 = Math.min(z0, v[2])
    x1 = Math.max(x1, v[0]); y1 = Math.max(y1, v[1]); z1 = Math.max(z1, v[2])
  }
  const size = Math.max(Math.abs(x0), Math.abs(y0), Math.abs(z0), Math.abs(x1), Math.abs(y1), Math.abs(z1), x1 - x0, y1 - y0, z1 - z0)
  const eps = 1e-9 * size
  const m = (x1 - x0 + y1 - y0 + z1 - z0) * 0.01 + eps
  x0 -= m; y0 -= m; z0 -= m; x1 += m; y1 += m; z1 += m
  const box: Vec3[][] = [
    [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]],
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
  ]
  const cells: Vec3[][] = []
  const items = polys.map((p) => ({ p, pl: planeOf(p) })).filter((x): x is { p: Vec3[]; pl: Plane } => x.pl !== null)
  const stack: { items: typeof items; cell: Vec3[][] }[] = [{ items, cell: box }]
  while (stack.length) {
    const { items: its, cell } = stack.pop()!
    // the splitter that cuts the fewest other faces (sampled)
    let best = its[0], bestCost = Infinity
    const step = Math.max(1, Math.floor(its.length / 16))
    for (let k = 0; k < its.length; k += step) {
      const pl = its[k].pl
      let splits = 0, f = 0, b = 0
      for (const it of its) {
        let pos = false, neg = false
        for (const v of it.p) { const d = dot(pl.n, v) - pl.w; if (d > eps) pos = true; else if (d < -eps) neg = true }
        if (pos && neg) splits++
        else if (pos) f++
        else if (neg) b++
      }
      const cost = splits * 8 + Math.abs(f - b)
      if (cost < bestCost) { bestCost = cost; best = its[k] }
    }
    const pl = best.pl
    const front: typeof items = [], back: typeof items = []
    for (const it of its) {
      let pos = false, neg = false
      for (const v of it.p) { const d = dot(pl.n, v) - pl.w; if (d > eps) pos = true; else if (d < -eps) neg = true }
      if (!pos && !neg) continue // coplanar: used up by this node
      if (pos && !neg) front.push(it)
      else if (neg && !pos) back.push(it)
      else {
        const s = splitPoly(it.p, pl, eps)
        if (s.front) front.push({ p: s.front, pl: it.pl })
        if (s.back) back.push({ p: s.back, pl: it.pl })
      }
    }
    const halves = clipCell(cell, pl, eps)
    if (front.length && halves.front.length) stack.push({ items: front, cell: halves.front })
    if (halves.back.length) {
      if (back.length) stack.push({ items: back, cell: halves.back })
      else if (cellVolumeSign(halves.back) > eps * eps * eps) {
        cells.push(halves.back.flat())
        if (cells.length > maxCells) return null
      }
    }
  }
  return cells
}

/** Hull point sets of a 3D minkowski sum: every pair of convex cells, summed. */
export function minkowskiSums(cellsA: Vec3[][], cellsB: Vec3[][]): Vec3[][] {
  const out: Vec3[][] = []
  for (const a of cellsA) for (const b of cellsB) {
    const pts: Vec3[] = []
    for (const p of a) for (const q of b) pts.push([p[0] + q[0], p[1] + q[1], p[2] + q[2]])
    out.push(pts)
  }
  return out
}
