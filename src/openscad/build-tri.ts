// Triangulation of 2D regions (extrusion caps, the 2D top level, minkowski pieces) and of non-convex polyhedron
// faces: ear clipping, holes joined to their outline by bridges (the classic method: the hole's rightmost vertex is
// connected to a visible outline vertex found by casting a ray towards +x).
import type { Vec2 } from './types'
import { groupHoles, signedArea, type Loop, type Region } from './build-2d'

interface Node {
  i: number // index into the point list
  x: number
  y: number
  prev: Node
  next: Node
  removed: boolean
}

const area3 = (a: Node, b: Node, c: Node): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
const same = (a: Node, b: Node): boolean => a.x === b.x && a.y === b.y

function makeList(loop: Loop, base: number, ccw: boolean): Node | null {
  const ordered = (signedArea(loop) > 0) === ccw ? loop.map((p, k) => [p, k] as const) : loop.map((p, k) => [p, k] as const).reverse()
  let first: Node | null = null, last: Node | null = null
  for (const [p, k] of ordered) {
    if (last && last.x === p[0] && last.y === p[1]) continue
    const n = { i: base + k, x: p[0], y: p[1], removed: false } as Node
    if (!first) { first = n; n.prev = n; n.next = n } else {
      n.prev = last!; n.next = first; last!.next = n; first.prev = n
    }
    last = n
  }
  if (first && last && last !== first && same(first, last)) { last.prev.next = first; first.prev = last.prev }
  return first
}

function remove(n: Node): void {
  n.prev.next = n.next
  n.next.prev = n.prev
  n.removed = true
}

/** Bridge from a to b: a → b … b' → a' → (a's old next); returns b'. */
function split(a: Node, b: Node): void {
  const a2 = { ...a } as Node, b2 = { ...b } as Node
  const an = a.next, bp = b.prev
  a.next = b; b.prev = a
  a2.next = an; an.prev = a2
  b2.next = a2; a2.prev = b2
  bp.next = b2; b2.prev = bp
}

type XY = { x: number; y: number }
const cr = (u: XY, v: XY, w: XY): number => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x)

/** b's interior angle (counter-clockwise list) contains the direction towards p */
function locallyInside(b: Node, p: XY): boolean {
  const l1 = cr(b.prev, b, p) >= 0, l2 = cr(b, b.next, p) >= 0
  return cr(b.prev, b, b.next) >= 0 ? l1 && l2 : l1 || l2
}

function inTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  return (cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0 &&
    (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0 &&
    (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0
}

function eliminateHole(hole: Node, outer: Node): void {
  // rightmost vertex of the hole
  let m = hole, p = hole.next
  while (p !== hole) { if (p.x > m.x || (p.x === m.x && p.y < m.y)) m = p; p = p.next }
  // nearest edge hit by the ray m → +x
  let hitX = Infinity
  let cand: Node | null = null
  p = outer
  do {
    const q = p.next
    if ((p.y <= m.y && q.y >= m.y) || (q.y <= m.y && p.y >= m.y)) {
      if (p.y !== q.y) {
        const x = p.x + ((m.y - p.y) * (q.x - p.x)) / (q.y - p.y)
        if (x >= m.x && x < hitX) {
          hitX = x
          cand = x === p.x && m.y === p.y ? p : x === q.x && m.y === q.y ? q : p.x > q.x ? p : q
        }
      } else if (m.y === p.y && Math.max(p.x, q.x) >= m.x) {
        const x = Math.max(m.x, Math.min(p.x, q.x))
        if (x < hitX) { hitX = x; cand = p.x < q.x ? p : q }
      }
    }
    p = q
  } while (p !== outer)
  if (!cand) return
  // a reflex vertex inside the triangle (m, hit, cand) may block the view: take the one closest in angle
  let best = cand
  if (hitX !== cand.x || m.y !== cand.y) {
    const hx = hitX, hy = m.y
    let bestTan = Infinity
    const ax = m.x, ay = m.y, bx = m.y < cand.y ? hx : cand.x, by = m.y < cand.y ? hy : cand.y
    const cx = m.y < cand.y ? cand.x : hx, cy = m.y < cand.y ? cand.y : hy
    p = outer
    do {
      if (p.x >= m.x && p !== cand && inTriangle(ax, ay, bx, by, cx, cy, p.x, p.y)) {
        const tan = Math.abs(m.y - p.y) / Math.max(p.x - m.x, 1e-300)
        if (locallyInside(p, m) && (tan < bestTan || (tan === bestTan && p.x < best.x))) { best = p; bestTan = tan }
      }
      p = p.next
    } while (p !== outer)
  }
  // among coincident copies (earlier bridges) take the one whose wedge contains the bridge
  p = best
  do {
    if (same(p, best) && locallyInside(p, m)) { best = p; break }
    p = p.next
  } while (p !== best)
  split(best, m)
}

/** Ear clipping of a counter-clockwise list; appends triangles (point indices, counter-clockwise). */
function clip(start: Node, tris: number[][]): void {
  // reflex candidates: only they can block an ear
  let reflex: Node[] = []
  {
    let p = start
    do { if (area3(p.prev, p, p.next) <= 0) reflex.push(p); p = p.next } while (p !== start)
  }
  const isEar = (b: Node): boolean => {
    const a = b.prev, c = b.next
    if (area3(a, b, c) <= 0) return false
    const x0 = Math.min(a.x, b.x, c.x), x1 = Math.max(a.x, b.x, c.x), y0 = Math.min(a.y, b.y, c.y), y1 = Math.max(a.y, b.y, c.y)
    for (const p of reflex) {
      if (p.removed || p === a || p === b || p === c) continue
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue
      if (same(p, a) || same(p, b) || same(p, c)) continue
      if (area3(p.prev, p, p.next) > 0) continue // became convex
      if (inTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y)) return false
    }
    return true
  }
  let ear = start, stop = start, pass = 0, count = 0
  while (ear.prev !== ear.next) {
    if (isEar(ear)) {
      tris.push([ear.prev.i, ear.i, ear.next.i])
      const next = ear.next
      remove(ear)
      ear = next; stop = next; pass = 0
      if (++count % 256 === 0) reflex = reflex.filter((p) => !p.removed && area3(p.prev, p, p.next) <= 0)
      continue
    }
    ear = ear.next
    if (ear === stop) {
      if (pass === 0) {
        // drop degenerate vertices (collinear or repeated) and retry
        let p = ear, changed = false
        do {
          const n = p.next
          if (p.prev !== p.next && (same(p, n) || area3(p.prev, p, n) === 0)) { remove(p); changed = true; if (p === ear) ear = n }
          p = n
        } while (p !== ear && p.prev !== p.next)
        stop = ear
        pass = changed ? 0 : 1
        if (ear.prev === ear.next) break
      } else {
        // give up on a perfect triangulation (self-touching input): cut the most convex vertex
        let p = ear, best = ear, ba = -Infinity
        do { const a = area3(p.prev, p, p.next); if (a > ba) { ba = a; best = p } p = p.next } while (p !== ear)
        if (ba > 0) tris.push([best.prev.i, best.i, best.next.i])
        const next = best.next
        remove(best)
        ear = next; stop = next; pass = 0
      }
    }
  }
}

/** Triangles of a simple polygon given counter-clockwise or clockwise; indices into `loop`, counter-clockwise. */
export function triangulateLoop(loop: Loop): number[][] {
  const tris: number[][] = []
  if (loop.length < 3) return tris
  const ccw = signedArea(loop) >= 0
  const start = makeList(loop, 0, true)
  if (!start) return tris
  clip(start, tris)
  return ccw ? tris : tris.map((t) => [t[0], t[2], t[1]])
}

/** Triangles of one outline with holes; `base` offsets the indices. */
function triangulateWithHoles(outer: Loop, holes: Loop[], base: number, tris: number[][]): void {
  const start = makeList(outer, base, true)
  if (!start) return
  // convex outline without holes: a fan is enough (and fast for fine circles)
  if (holes.length === 0) {
    let convex = true
    let p = start
    do { if (area3(p.prev, p, p.next) < 0) { convex = false; break } p = p.next } while (p !== start)
    if (convex) {
      for (let q = start.next; q.next !== start; q = q.next) if (area3(start, q, q.next) > 0) tris.push([start.i, q.i, q.next.i])
      return
    }
  }
  let off = base + outer.length
  const hs: Node[] = []
  for (const h of holes) {
    const n = makeList(h, off, false)
    off += h.length
    if (n) hs.push(n)
  }
  const right = (n: Node) => { let m = n.x, p = n.next; while (p !== n) { if (p.x > m) m = p.x; p = p.next } return m }
  hs.sort((a, b) => right(b) - right(a))
  for (const h of hs) eliminateHole(h, start)
  clip(start, tris)
}

/** Triangles of a region: all loop points (in region order) and counter-clockwise index triples. */
export function triangulateRegion(r: Region): { points: Vec2[]; tris: number[][] } {
  const points: Vec2[] = []
  const tris: number[][] = []
  for (const g of groupHoles(r)) {
    const base = points.length
    // (no push(...big): a fine outline has more points than a call can take as arguments)
    for (const p of g.outer) points.push(p)
    for (const h of g.holes) for (const p of h) points.push(p)
    triangulateWithHoles(g.outer, g.holes, base, tris)
  }
  return { points, tris }
}
