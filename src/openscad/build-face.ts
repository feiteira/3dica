// Splitting a non-planar polyhedron face into triangles the way OpenSCAD 2021.01 does, so a polyhedron made from
// list comprehensions (lofts, sweeps, twisted rings, height fields) has the same surface and volume as there.
//
// A non-planar face has no single right answer: each way of splitting it is a different surface. OpenSCAD hands every
// face to libtess2 (constrained Delaunay mode); measured against the binary (black box, hundreds of random faces),
// the result is reproduced by:
//   1. a projection onto a coordinate plane: drop the axis where the face's normal is longest. The normal is that of
//      the largest triangle spanned by the two points farthest apart along the face's longest extent and any third
//      point; the second coordinate is negated when needed so the face runs counter-clockwise
//   2. a sweep from left to right (by first, then second coordinate) that cuts triangles off the upper and lower
//      chains, as in the classic monotone-polygon triangulation
//   3. Delaunay edge flips in that plane: an inner edge is flipped when the two angles facing it add up to more than
//      π + 0.01 (so nearly co-circular points keep the split of step 2)
// Coordinates are rounded to 32-bit floats first, as OpenSCAD does before splitting. Faces that are not convex in the
// projection are split by ear clipping before step 3 (OpenSCAD's sweep differs only for nearly co-circular points).
import type { Vec2, Vec3 } from './types'

const PI_TOL = Math.PI + 0.01

/**
 * Triangles (index triples into `pts`, same winding as `pts`) of one face, `pts` in OpenSCAD's internal order (the
 * order of the polyhedron() face reversed). `earClip` triangulates a simple 2D loop (counter-clockwise output).
 */
export function splitFace(pts: Vec3[], earClip: (loop: Vec2[]) => number[][]): number[][] {
  const n = pts.length
  if (n < 3) return []
  if (n === 3) return [[0, 1, 2]]
  const P = pts.map((p) => [f(p[0]), f(p[1]), f(p[2])])
  // 1. the projection (libtess2 works in 32-bit floats: a near tie between two normal components goes its way).
  // libtess2 keeps the points in the order 1, 2, …, n − 1, 0 (each new point goes before the first), and ties
  // between equal coordinates go to the first in that order
  const order: number[] = []
  for (let k = 1; k < n; k++) order.push(k)
  order.push(0)
  const minI = [1, 1, 1], maxI = [1, 1, 1]
  for (const k of order) {
    for (let a = 0; a < 3; a++) {
      if (P[k][a] < P[minI[a]][a]) minI[a] = k
      if (P[k][a] > P[maxI[a]][a]) maxI[a] = k
    }
  }
  const ext = (a: number) => f(P[maxI[a]][a] - P[minI[a]][a])
  let long = 0
  if (ext(1) > ext(0)) long = 1
  if (ext(2) > ext(long)) long = 2
  let nx = 0, ny = 0, nz = 1
  if (ext(long) > 0) {
    const v1 = P[minI[long]], v2 = P[maxI[long]]
    const d1x = f(v1[0] - v2[0]), d1y = f(v1[1] - v2[1]), d1z = f(v1[2] - v2[2])
    let best = 0
    for (const k of order) {
      const v = P[k]
      const d2x = f(v[0] - v2[0]), d2y = f(v[1] - v2[1]), d2z = f(v[2] - v2[2])
      const tx = f(f(d1y * d2z) - f(d1z * d2y)), ty = f(f(d1z * d2x) - f(d1x * d2z)), tz = f(f(d1x * d2y) - f(d1y * d2x))
      const l2 = f(f(f(tx * tx) + f(ty * ty)) + f(tz * tz))
      if (l2 > best) { best = l2; nx = tx; ny = ty; nz = tz }
    }
  }
  const nv = [nx, ny, nz]
  let ax = 0
  if (Math.abs(nv[1]) > Math.abs(nv[ax])) ax = 1
  if (Math.abs(nv[2]) > Math.abs(nv[ax])) ax = 2
  const sign = nv[ax] > 0 ? 1 : -1
  const S = P.map((p) => p[(ax + 1) % 3])
  const T = P.map((p) => sign * p[(ax + 2) % 3])
  let area = 0
  for (let k = 0; k < n; k++) { const j = (k + 1) % n; area = f(area + f(f(S[k] - S[j]) * f(T[k] + T[j]))) }
  if (area < 0) for (let k = 0; k < n; k++) T[k] = -T[k]
  if (area === 0) return earClip(pts.map((_, k) => [S[k], T[k]]))
  // 2. the sweep (convex faces) or ear clipping
  let convex = true
  for (let k = 0; k < n && convex; k++) {
    const a = k, b = (k + 1) % n, c = (k + 2) % n
    if ((S[b] - S[a]) * (T[c] - T[a]) - (T[b] - T[a]) * (S[c] - S[a]) < 0) convex = false
  }
  const tris = convex ? sweep(S, T) : earClip(pts.map((_, k) => [S[k], T[k]]))
  // 3. Delaunay flips
  return flipToDelaunay(tris, S, T)
}

/** rounding to a 32-bit float, for libtess2's arithmetic */
const f = Math.fround

/**
 * Monotone triangulation of a convex counter-clockwise polygon: walk the upper and lower chains from the rightmost
 * point, cutting off triangles. Each triangle starts with its new edge (this order steers step 3, as in OpenSCAD).
 */
function sweep(S: number[], T: number[]): number[][] {
  const n = S.length
  const leq = (u: number, v: number) => S[u] < S[v] || (S[u] === S[v] && T[u] <= T[v])
  // > 0 when v is above the segment u → w (u ≤ v ≤ w in sweep order); in floats, as libtess2
  const sideOf = (u: number, v: number, w: number) => {
    const gl = f(S[v] - S[u]), gr = f(S[w] - S[v])
    return f(gl + gr) > 0 ? f(f(f(T[v] - T[w]) * gl) + f(f(T[v] - T[u]) * gr)) : 0
  }
  const next: number[] = [], prev: number[] = []
  for (let k = 0; k < n; k++) { next[k] = (k + 1) % n; prev[k] = (k + n - 1) % n }
  const tris: number[][] = []
  // `up` and `lo` name edges by their first point: up runs left from the rightmost point, lo runs into it
  let up = 0
  for (let g = 0; g < n && leq(next[up], up); g++) up = prev[up]
  for (let g = 0; g < n && leq(up, next[up]); g++) up = next[up]
  let lo = prev[up]
  let last = -1 // first point of the remaining region's edge (where its last cut was made)
  for (let guard = 0; next[up] !== lo && guard < 4 * n; guard++) {
    if (leq(next[up], lo)) {
      while (next[lo] !== up && (leq(next[next[lo]], next[lo]) || sideOf(lo, next[lo], next[next[lo]]) <= 0)) {
        const q = next[lo], r = next[q]
        tris.push([r, lo, q]); next[lo] = r; prev[r] = lo; last = lo
      }
      lo = prev[lo]
    } else {
      while (next[lo] !== up && (leq(prev[up], up) || sideOf(next[up], up, prev[up]) >= 0)) {
        const z = prev[up], b = next[up]
        tris.push([b, z, up]); next[z] = b; prev[b] = z; up = z; last = z
      }
      up = next[up]
    }
  }
  // what is left is a fan around the leftmost point
  for (let guard = 0; next[next[lo]] !== up && guard < n; guard++) {
    const q = next[lo], r = next[q]
    tris.push([r, lo, q]); next[lo] = r; prev[r] = lo; last = lo
  }
  const l0 = last >= 0 ? last : lo
  tris.push([l0, next[l0], next[next[l0]]])
  return tris
}

interface HalfEdge { org: number; next: HalfEdge; twin: HalfEdge | null; tri: number; queued: boolean }

/** Edge flips until every inner edge is Delaunay (within the tolerance), in OpenSCAD's order: a stack of the inner
 *  edges, seeded triangle by triangle, and refilled with the four outer edges of each flipped pair. */
function flipToDelaunay(tris: number[][], S: number[], T: number[]): number[][] {
  if (tris.length < 2) return tris
  // the angle at o, computed in floats as libtess2 does (it decides near ties)
  const angle = (a: number, o: number, b: number) => {
    const ux = f(S[a] - S[o]), uy = f(T[a] - T[o]), vx = f(S[b] - S[o]), vy = f(T[b] - T[o])
    let c = f(f(ux * vx) + f(uy * vy))
    const d = f(Math.sqrt(f(f(ux * ux) + f(uy * uy))) * Math.sqrt(f(f(vx * vx) + f(vy * vy))))
    if (d > 0) c = f(c / d)
    return f(Math.acos(Math.max(-1, Math.min(1, c))))
  }
  const first: HalfEdge[] = []
  const byPair = new Map<string, HalfEdge>()
  tris.forEach((t, ti) => {
    const es = t.map((v) => ({ org: v, tri: ti, twin: null, queued: false }) as unknown as HalfEdge)
    for (let k = 0; k < 3; k++) { es[k].next = es[(k + 1) % 3]; byPair.set(t[k] + ',' + t[(k + 1) % 3], es[k]) }
    first.push(es[0])
  })
  for (const e0 of first) {
    let e = e0
    do { e.twin = byPair.get(e.next.org + ',' + e.org) ?? null; e = e.next } while (e !== e0)
  }
  const stack: HalfEdge[] = []
  for (const e0 of first) {
    let e = e0
    do {
      e.queued = e.twin !== null
      if (e.twin && !e.twin.queued) stack.push(e)
      e = e.next
    } while (e !== e0)
  }
  const maxIter = tris.length * tris.length
  for (let iter = 0; stack.length && iter < maxIter; iter++) {
    const e = stack.pop()!
    const t = e.twin!
    e.queued = t.queued = false
    if (Math.fround(angle(e.next.org, e.next.next.org, e.org) + angle(t.next.org, t.next.next.org, t.org)) < PI_TOL) continue
    // flip: e and f become the other diagonal of their quadrilateral
    const a1 = e.next, a2 = a1.next, b1 = t.next, b2 = b1.next
    e.org = b2.org; t.org = a2.org
    e.next = a2; a2.next = b1; b1.next = e
    t.next = b2; b2.next = a1; a1.next = t
    a1.tri = t.tri; b1.tri = e.tri
    first[e.tri] = e; first[t.tri] = t
    for (const x of [a2, b1, b2, a1]) {
      if (!x.queued && x.twin) { x.queued = x.twin.queued = true; stack.push(x) }
    }
  }
  return first.map((e) => [e.org, e.next.org, e.next.next.org])
}
