// 2D regions and their booleans, for the OpenSCAD builder. OpenSCAD does all 2D work with Clipper (polygon fill
// rules, union / difference / intersection, offset); JSCAD's geom2 booleans go through 3D BSP trees and are slow, so
// this is a small exact-enough engine of its own:
//
//   1. every outline edge of every operand goes into one edge soup (points snapped to a fine grid, ~2^-40 of the size)
//   2. edges are split where they cross or touch, identical pieces are merged (their windings add up)
//   3. for each piece the winding number of every operand is computed just left and just right of it (ray casting
//      from its midpoint, bucketed); the piece is a boundary of the result when a fill rule (even-odd, positive,
//      union, difference, intersection) says "inside" on one side only, and it is oriented with the inside on its left
//   4. the kept pieces are linked into loops, turning as far left as possible at shared vertices
//
// Results are Regions: solids counter-clockwise, holes clockwise, no crossings (loops may touch at a vertex), no
// collinear vertices (as Clipper's output). Coordinates are not quantized like OpenSCAD 2021.01's 1/65536 grid.
import type { Vec2 } from './types'

export type Loop = Vec2[]
/** Solids counter-clockwise, holes clockwise, no crossings. */
export type Region = Loop[]
export type Box2 = [number, number, number, number] // minX, minY, maxX, maxY

export function signedArea(loop: Loop): number {
  let a = 0
  for (let i = 0, n = loop.length; i < n; i++) {
    const p = loop[i], q = loop[(i + 1) % n]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

export function regionArea(r: Region): number {
  let a = 0
  for (const l of r) a += signedArea(l)
  return a
}

export function bbox2(loops: Loop[]): Box2 | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const l of loops) for (const p of l) {
    if (p[0] < x0) x0 = p[0]
    if (p[0] > x1) x1 = p[0]
    if (p[1] < y0) y0 = p[1]
    if (p[1] > y1) y1 = p[1]
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null
}

const boxesOverlap = (a: Box2, b: Box2): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

export function pointCount(loops: Loop[]): number {
  let n = 0
  for (const l of loops) n += l.length
  return n
}

// ───────────────────────────── the arrangement ─────────────────────────────

/** w[i] = winding number of operand i at a point */
export type FillRule = (w: Int32Array) => boolean
/** A directed edge of operand `op`: it adds +1 to the winding on its left. */
export interface Seg { a: Vec2; b: Vec2; op: number }

/**
 * The region where `inside` holds, for operands given as loops (any orientation, may self-intersect: a loop adds
 * +1 to the winding left of it).
 */
export function arrange(operands: Loop[][], inside: FillRule): Region {
  const segs: Seg[] = []
  operands.forEach((loops, op) => {
    for (const l of loops) for (let i = 0; i < l.length; i++) segs.push({ a: l[i], b: l[(i + 1) % l.length], op })
  })
  return arrangeSegments(segs, operands.length, inside)
}

/** As arrange(), for a soup of directed edges that together form closed cycles per operand. */
/** A hash of an integer grid cell: the low 15 bits of each coordinate, so it stays a small integer (fast as a Map
 *  key); cells that share it are told apart by their coordinates. */
const cellKey = (x: number, y: number): number => ((x & 0x7fff) << 15) | (y & 0x7fff)

export function arrangeSegments(input: Seg[], nOps: number, inside: FillRule): Region {
  // grid
  let size = 0
  for (const s of input) size = Math.max(size, Math.abs(s.a[0]), Math.abs(s.a[1]), Math.abs(s.b[0]), Math.abs(s.b[1]))
  if (!(size > 0) || !Number.isFinite(size)) return []
  const grid = 2 ** (Math.ceil(Math.log2(size)) - 40)
  const X: number[] = [], Y: number[] = []
  // vertices by a numeric hash of their grid position (string keys made big outlines slow); equal hashes are told
  // apart by comparing the coordinates
  const ids = new Map<number, number | number[]>()
  const vid = (x: number, y: number): number => {
    const xi = Math.round(x / grid), yi = Math.round(y / grid)
    const k = cellKey(xi, yi)
    const e = ids.get(k)
    if (e === undefined) { const id = X.length; ids.set(k, id); X.push(xi); Y.push(yi); return id }
    if (typeof e === 'number') {
      if (X[e] === xi && Y[e] === yi) return e
      const id = X.length; ids.set(k, [e, id]); X.push(xi); Y.push(yi); return id
    }
    for (const id of e) if (X[id] === xi && Y[id] === yi) return id
    const id = X.length; e.push(id); X.push(xi); Y.push(yi); return id
  }
  // segments
  const sa: number[] = [], sb: number[] = [], sop: number[] = []
  for (const s of input) {
    const a = vid(s.a[0], s.a[1]), b = vid(s.b[0], s.b[1])
    if (a !== b) { sa.push(a); sb.push(b); sop.push(s.op) }
  }
  const nSeg = sa.length
  if (nSeg === 0) return []
  const splits: (number[] | undefined)[] = new Array(nSeg)
  const addSplit = (s: number, v: number) => { if (v !== sa[s] && v !== sb[s]) (splits[s] ??= []).push(v) }

  // ── intersections: sweep over x ──
  const EPS = 2 // grid units
  const minX = new Float64Array(nSeg), maxX = new Float64Array(nSeg), minY = new Float64Array(nSeg), maxY = new Float64Array(nSeg)
  for (let s = 0; s < nSeg; s++) {
    const a = sa[s], b = sb[s]
    minX[s] = Math.min(X[a], X[b]); maxX[s] = Math.max(X[a], X[b])
    minY[s] = Math.min(Y[a], Y[b]); maxY[s] = Math.max(Y[a], Y[b])
  }
  const order = Array.from({ length: nSeg }, (_, i) => i).sort((p, q) => minX[p] - minX[q])
  /** p on segment s (strictly between its ends, within EPS of the line) */
  const touch = (s: number, p: number) => {
    if (p === sa[s] || p === sb[s]) return
    const ax = X[sa[s]], ay = Y[sa[s]], dx = X[sb[s]] - ax, dy = Y[sb[s]] - ay
    const px = X[p] - ax, py = Y[p] - ay
    const len2 = dx * dx + dy * dy
    const t = px * dx + py * dy
    if (t <= 0 || t >= len2) return
    const cr = dx * py - dy * px
    if (cr * cr > EPS * EPS * len2) return
    addSplit(s, p)
  }
  const cross = (s: number, t: number) => {
    const a = sa[s], b = sb[s], c = sa[t], d = sb[t]
    touch(s, c); touch(s, d); touch(t, a); touch(t, b)
    if (a === c || a === d || b === c || b === d) return
    const abx = X[b] - X[a], aby = Y[b] - Y[a], cdx = X[d] - X[c], cdy = Y[d] - Y[c]
    const lab = Math.hypot(abx, aby), lcd = Math.hypot(cdx, cdy)
    const d1 = (abx * (Y[c] - Y[a]) - aby * (X[c] - X[a])) / lab
    const d2 = (abx * (Y[d] - Y[a]) - aby * (X[d] - X[a])) / lab
    if (!((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS))) return
    const d3 = (cdx * (Y[a] - Y[c]) - cdy * (X[a] - X[c])) / lcd
    const d4 = (cdx * (Y[b] - Y[c]) - cdy * (X[b] - X[c])) / lcd
    if (!((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return
    const t1 = d1 / (d1 - d2)
    const v = vid((X[c] + cdx * t1) * grid, (Y[c] + cdy * t1) * grid)
    addSplit(s, v); addSplit(t, v)
  }
  {
    let active: number[] = []
    for (const s of order) {
      const lo = minX[s] - EPS
      let dead = 0
      for (const t of active) {
        if (maxX[t] < lo) { dead++; continue }
        if (maxY[t] + EPS < minY[s] || minY[t] - EPS > maxY[s]) continue
        cross(s, t)
      }
      if (dead > 32 && dead * 2 > active.length) active = active.filter((t) => maxX[t] >= lo)
      active.push(s)
    }
  }
  // ── cluster vertices a few grid units apart: nearly concurrent lines give several snapped intersection points
  //    for one crossing, and the tiny edges between them would be classified inconsistently ──
  const CL = 4
  const parent = Array.from({ length: X.length }, (_, i) => i)
  const find = (v: number): number => {
    while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v] }
    return v
  }
  {
    // cells of CL grid units under a numeric hash (a shared hash only costs a few extra distance checks)
    const cells = new Map<number, number[]>()
    for (let v = 0; v < X.length; v++) {
      const cx = Math.floor(X[v] / CL), cy = Math.floor(Y[v] / CL)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const list = cells.get(cellKey(cx + dx, cy + dy))
        if (!list) continue
        for (const u of list) {
          if (Math.abs(X[u] - X[v]) > CL || Math.abs(Y[u] - Y[v]) > CL) continue
          const a = find(u), b = find(v)
          if (a !== b) parent[Math.max(a, b)] = Math.min(a, b)
        }
      }
      const k = cellKey(cx, cy)
      const l = cells.get(k)
      if (l) l.push(v)
      else cells.set(k, [v])
    }
  }
  // ── split and merge ──
  const N = 2 ** 26
  const edgeIdx = new Map<number, number>()
  const eu: number[] = [], ev: number[] = []
  const ew: Int32Array[] = []
  const addPiece = (p: number, q: number, o: number) => {
    if (p === q) return
    const u = Math.min(p, q), v = Math.max(p, q)
    const key = u * N + v
    let e = edgeIdx.get(key)
    if (e === undefined) { e = eu.length; edgeIdx.set(key, e); eu.push(u); ev.push(v); ew.push(new Int32Array(nOps)) }
    ew[e][o] += p === u ? 1 : -1
  }
  for (let s = 0; s < nSeg; s++) {
    const a = find(sa[s]), b = find(sb[s])
    const sp = splits[s]
    if (!sp) { addPiece(a, b, sop[s]); continue }
    const ax = X[sa[s]], ay = Y[sa[s]], dx = X[sb[s]] - ax, dy = Y[sb[s]] - ay
    const par = (v: number) => (X[v] - ax) * dx + (Y[v] - ay) * dy
    const pts = [...new Set(sp)].sort((p, q) => par(p) - par(q))
    let prev = a
    for (const v of pts) { const r = find(v); addPiece(prev, r, sop[s]); prev = r }
    addPiece(prev, b, sop[s])
  }
  const live: number[] = []
  for (let e = 0; e < eu.length; e++) if (ew[e].some((w) => w !== 0)) live.push(e)
  if (live.length === 0) return []

  // ── winding by ray casting (half-open rule), edges bucketed along the ray's perpendicular axis ──
  const nE = live.length
  // about four edges per bucket: a ray then meets only the edges near its line (√n buckets made fine circles quadratic)
  const B = Math.max(1, Math.min(65536, Math.ceil(nE / 4)))
  type Index = { lo: number; span: number; buckets: number[][] }
  const makeIndex = (C: number[]): Index => {
    let lo = Infinity, hi = -Infinity
    for (const e of live) { lo = Math.min(lo, C[eu[e]], C[ev[e]]); hi = Math.max(hi, C[eu[e]], C[ev[e]]) }
    const span = Math.max(hi - lo, 1)
    const buckets: number[][] = Array.from({ length: B }, () => [])
    const bi = (c: number) => Math.min(B - 1, Math.max(0, Math.floor(((c - lo) / span) * B)))
    for (const e of live) {
      const a = C[eu[e]], b = C[ev[e]]
      for (let k = bi(Math.min(a, b)), k1 = bi(Math.max(a, b)); k <= k1; k++) buckets[k].push(e)
    }
    return { lo, span, buckets }
  }
  let ix: Index | null = null, iy: Index | null = null
  const bucketOf = (idx: Index, c: number) => idx.buckets[Math.min(B - 1, Math.max(0, Math.floor(((c - idx.lo) / idx.span) * B)))]
  const wl = new Int32Array(nOps), wr = new Int32Array(nOps)
  const keptFrom: number[] = [], keptTo: number[] = []
  for (const e of live) {
    const u = eu[e], v = ev[e], w = ew[e]
    const dx = X[v] - X[u], dy = Y[v] - Y[u]
    const mx = (X[u] + X[v]) / 2, my = (Y[u] + Y[v]) / 2
    wl.fill(0)
    if (Math.abs(dy) >= Math.abs(dx)) {
      // ray towards +x: an upward edge to the right counts +1
      ix ??= makeIndex(Y)
      for (const f of bucketOf(ix, my)) {
        if (f === e) continue
        const p = eu[f], q = ev[f]
        const py = Y[p], qy = Y[q]
        if ((py > my) === (qy > my)) continue
        const xc = X[p] + ((my - py) * (X[q] - X[p])) / (qy - py)
        if (xc <= mx) continue
        const wf = ew[f], sgn = qy > py ? 1 : -1
        for (let o = 0; o < nOps; o++) wl[o] += sgn * wf[o]
      }
      wr.set(wl)
      if (dy > 0) for (let o = 0; o < nOps; o++) wl[o] += w[o]
      else for (let o = 0; o < nOps; o++) wr[o] -= w[o]
    } else {
      // ray towards +y: a leftward edge above counts +1
      iy ??= makeIndex(X)
      for (const f of bucketOf(iy, mx)) {
        if (f === e) continue
        const p = eu[f], q = ev[f]
        const px = X[p], qx = X[q]
        if ((px > mx) === (qx > mx)) continue
        const yc = Y[p] + ((mx - px) * (Y[q] - Y[p])) / (qx - px)
        if (yc <= my) continue
        const wf = ew[f], sgn = qx < px ? 1 : -1
        for (let o = 0; o < nOps; o++) wl[o] += sgn * wf[o]
      }
      wr.set(wl)
      if (dx < 0) for (let o = 0; o < nOps; o++) wl[o] += w[o]
      else for (let o = 0; o < nOps; o++) wr[o] -= w[o]
    }
    const inL = inside(wl), inR = inside(wr)
    if (inL === inR) continue
    if (inL) { keptFrom.push(u); keptTo.push(v) } else { keptFrom.push(v); keptTo.push(u) }
  }
  if (keptFrom.length === 0) return []

  // ── link into loops ──
  const out = new Map<number, number[]>()
  for (let k = 0; k < keptFrom.length; k++) {
    const l = out.get(keptFrom[k])
    if (l) l.push(k)
    else out.set(keptFrom[k], [k])
  }
  const used = new Uint8Array(keptFrom.length)
  const loops: Region = []
  for (let k0 = 0; k0 < keptFrom.length; k0++) {
    if (used[k0]) continue
    const vs: number[] = []
    let k = k0
    let ok = true
    for (let guard = 0; guard <= keptFrom.length; guard++) {
      used[k] = 1
      vs.push(keptFrom[k])
      const at = keptTo[k]
      const cands = out.get(at)
      if (!cands) { ok = false; break }
      let next = -1
      if (cands.length === 1) next = cands[0]
      else {
        // first edge clockwise from the reversed incoming edge = the sharpest left turn
        const back = Math.atan2(Y[keptFrom[k]] - Y[at], X[keptFrom[k]] - X[at])
        let best = Infinity
        for (const c of cands) {
          if (used[c] && c !== k0) continue
          let cw = back - Math.atan2(Y[keptTo[c]] - Y[at], X[keptTo[c]] - X[at])
          while (cw <= 0) cw += 2 * Math.PI
          while (cw > 2 * Math.PI) cw -= 2 * Math.PI
          if (cw < best) { best = cw; next = c }
        }
      }
      if (next === k0) break
      if (next < 0 || used[next]) { ok = false; break }
      k = next
    }
    if (!ok || vs.length < 3) continue
    const loop = simplify(vs.map((id): Vec2 => [X[id] * grid, Y[id] * grid]))
    if (loop.length >= 3 && signedArea(loop) !== 0) loops.push(loop)
  }
  return loops
}

/** Removes collinear vertices (and zero-length edges) from a closed loop, as Clipper does. */
export function simplify(loop: Loop): Loop {
  let pts = loop
  for (let pass = 0; pass < 4; pass++) {
    const n = pts.length
    if (n < 3) return pts
    const keep: Loop = []
    let removed = false
    for (let i = 0; i < n; i++) {
      const p = keep.length ? keep[keep.length - 1] : pts[(i + n - 1) % n], c = pts[i], q = pts[(i + 1) % n]
      const ax = c[0] - p[0], ay = c[1] - p[1], bx = q[0] - c[0], by = q[1] - c[1]
      const cr = ax * by - ay * bx
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
      if (la === 0 || (Math.abs(cr) <= 1e-12 * la * lb && ax * bx + ay * by > 0)) { removed = true; continue }
      keep.push(c)
    }
    pts = keep
    if (!removed) break
  }
  return pts
}

// ───────────────────────────── region operations ─────────────────────────────

const positive: FillRule = (w) => w[0] > 0

/** Even-odd fill of arbitrary paths (OpenSCAD's polygon() rule). */
export function evenOdd(paths: Loop[]): Region {
  return arrange([paths], (w) => (w[0] & 1) !== 0)
}

/** Positive-winding fill of raw paths (offset results). */
export function fillPositive(paths: Loop[]): Region {
  return arrange([paths], positive)
}

export function union2(regions: Region[]): Region {
  const rs = regions.filter((r) => r.length > 0)
  if (rs.length === 0) return []
  if (rs.length === 1) return rs[0]
  const boxes = rs.map((r) => bbox2(r)!)
  let disjoint = true
  for (let i = 0; i < boxes.length && disjoint; i++) for (let j = i + 1; j < boxes.length; j++) if (boxesOverlap(boxes[i], boxes[j])) { disjoint = false; break }
  if (disjoint) return rs.flat()
  return arrange([rs.flat()], positive)
}

export function difference2(a: Region, cutters: Region[]): Region {
  if (a.length === 0) return []
  const box = bbox2(a)!
  const cut = cutters.filter((c) => c.length > 0 && boxesOverlap(box, bbox2(c)!)).flat()
  if (cut.length === 0) return a
  return arrange([a, cut], (w) => w[0] > 0 && w[1] <= 0)
}

export function intersection2(regions: Region[]): Region {
  if (regions.length === 0) return []
  if (regions.some((r) => r.length === 0)) return []
  if (regions.length === 1) return regions[0]
  const boxes = regions.map((r) => bbox2(r)!)
  const box: Box2 = [Math.max(...boxes.map((b) => b[0])), Math.max(...boxes.map((b) => b[1])), Math.min(...boxes.map((b) => b[2])), Math.min(...boxes.map((b) => b[3]))]
  if (box[0] > box[2] || box[1] > box[3]) return []
  return arrange(regions, (w) => { for (let i = 0; i < w.length; i++) if (w[i] <= 0) return false; return true })
}

/** Convex hull (counter-clockwise, no collinear points) of a point set; [] when degenerate. */
export function hull2(points: Vec2[]): Loop {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1])
  if (pts.length < 3) return []
  const crossO = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Vec2[] = []
  for (const p of pts) {
    while (lower.length >= 2 && crossO(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Vec2[] = []
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]
    while (upper.length >= 2 && crossO(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  const h = [...lower.slice(0, -1), ...upper.slice(0, -1)]
  return h.length >= 3 && signedArea(h) > 0 ? h : []
}

/**
 * The region under a 4×4 matrix (column-major), using only its x/y part as OpenSCAD does for 2D objects.
 * null when the matrix squashes the region to zero area (OpenSCAD removes the object with a warning).
 */
export function transformRegion(r: Region, m: number[]): Region | null {
  const a = m[0], b = m[4], c = m[12], d = m[1], e = m[5], f = m[13], g = m[3], h = m[7], k = m[15]
  const det = a * e - b * d
  if (det === 0 || !Number.isFinite(det)) return null
  const affine = g === 0 && h === 0 && k === 1
  const map = (p: Vec2): Vec2 => {
    const x = a * p[0] + b * p[1] + c, y = d * p[0] + e * p[1] + f
    if (affine) return [x, y]
    const w = g * p[0] + h * p[1] + k
    return [x / w, y / w]
  }
  const out = r.map((l) => l.map(map))
  return det < 0 ? out.map((l) => l.reverse()) : out
}

/** Point in loop (ray casting, half-open rule); points on the boundary may go either way. */
export function pointInLoop(p: Vec2, loop: Loop): boolean {
  let inside = false
  for (let i = 0, n = loop.length, j = n - 1; i < n; j = i++) {
    const a = loop[i], b = loop[j]
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside
  }
  return inside
}

/** Solids with their holes (each hole goes to the smallest solid that contains it). */
export function groupHoles(r: Region): { outer: Loop; holes: Loop[] }[] {
  const solids: { outer: Loop; holes: Loop[]; area: number; box: Box2 }[] = []
  const holes: Loop[] = []
  for (const l of r) {
    const a = signedArea(l)
    if (a > 0) solids.push({ outer: l, holes: [], area: a, box: bbox2([l])! })
    else if (a < 0) holes.push(l)
  }
  for (const h of holes) {
    // a test point just left of the hole's longest edge: in the material around the hole
    let best = 0, bl = -1
    for (let i = 0; i < h.length; i++) {
      const p = h[i], q = h[(i + 1) % h.length]
      const l = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (l > bl) { bl = l; best = i }
    }
    const p = h[best], q = h[(best + 1) % h.length]
    const off = bl * 1e-7
    const t: Vec2 = [(p[0] + q[0]) / 2 - ((q[1] - p[1]) / bl) * off, (p[1] + q[1]) / 2 + ((q[0] - p[0]) / bl) * off]
    let owner: (typeof solids)[number] | null = null
    for (const s of solids) {
      if (t[0] < s.box[0] || t[0] > s.box[2] || t[1] < s.box[1] || t[1] > s.box[3]) continue
      if ((!owner || s.area < owner.area) && pointInLoop(t, s.outer)) owner = s
    }
    owner?.holes.push(h)
  }
  return solids.map(({ outer, holes }) => ({ outer, holes }))
}
