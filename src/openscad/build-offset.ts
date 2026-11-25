// offset() and strokes, with the corner joins OpenSCAD 2021.01 gets from Clipper's offsetting:
//   r       round joins: arcs that start at the incoming edge's normal and step by a fixed angle (360° / steps,
//           steps from $fn/$fa/$fs of |r| through Clipper's arc tolerance), ending exactly at the outgoing normal
//   delta   sharp (mitred) corners; chamfer = true cuts each corner at distance |delta| across the bisector
// Each outline is offset into a raw path (concave corners just go through the original vertex) and the raw paths
// are filled with the positive winding rule, which removes the loops that a large offset makes.
import type { Fragments, Vec2 } from './types'
import { fillPositive, type Loop, type Region } from './build-2d'
import { cosDeg, fragments } from './tess'

/** OpenSCAD 2021.01 scales 2D coordinates by 2^16 for Clipper; a few of Clipper's thresholds are in those units. */
const CLIPPER_SCALE = 65536

export type Join = 'round' | 'miter' | 'square'

interface JoinSetup { join: Join; delta: number; sin: number; cos: number; stepsPerRad: number }

function setup(delta: number, join: Join, frag: Fragments): JoinSetup {
  const s: JoinSetup = { join, delta, sin: 0, cos: 1, stepsPerRad: 0 }
  if (join === 'round') {
    const ad = Math.abs(delta)
    const n = fragments(ad, frag)
    let y = ad * (1 - cosDeg(180 / n)) // OpenSCAD's arc tolerance
    if (y > ad * 0.25) y = ad * 0.25 // Clipper caps the tolerance at a quarter of the offset
    let steps = Math.PI / Math.acos(1 - y / ad)
    if (steps > ad * CLIPPER_SCALE * Math.PI) steps = ad * CLIPPER_SCALE * Math.PI
    s.sin = Math.sin((2 * Math.PI) / steps)
    s.cos = Math.cos((2 * Math.PI) / steps)
    s.stepsPerRad = steps / (2 * Math.PI)
    if (delta < 0) s.sin = -s.sin
  }
  return s
}

/** Points of a round / miter / square arc between unit normals (kx, ky) and (jx, jy) at p. `turn` is the corner's
 *  angle as Clipper measures it (from the vertices on its 1/65536 grid), which decides a round join's step count. */
function addJoin(out: Vec2[], s: JoinSetup, p: Vec2, kx: number, ky: number, jx: number, jy: number, turn: number): void {
  const d = s.delta
  let sinA = kx * jy - jx * ky
  const cosA = kx * jx + ky * jy
  if (Math.abs(sinA * d) * CLIPPER_SCALE < 1 && cosA > 0) { out.push([p[0] + kx * d, p[1] + ky * d]); return } // straight on
  if (sinA > 1) sinA = 1
  else if (sinA < -1) sinA = -1
  if (sinA * d < 0) {
    // concave for this direction: through the vertex; the fill removes the little loop
    out.push([p[0] + kx * d, p[1] + ky * d], [p[0], p[1]], [p[0] + jx * d, p[1] + jy * d])
    return
  }
  const square = () => {
    const t = Math.tan(Math.atan2(sinA, cosA) / 4)
    out.push([p[0] + d * (kx - ky * t), p[1] + d * (ky + kx * t)], [p[0] + d * (jx + jy * t), p[1] + d * (jy - jx * t)])
  }
  switch (s.join) {
    case 'miter': {
      const r = 1 + cosA
      if (r >= 2e-12) { const q = d / r; out.push([p[0] + (kx + jx) * q, p[1] + (ky + jy) * q]) } // limit 1e6 as OpenSCAD
      else square()
      return
    }
    case 'square':
      square()
      return
    case 'round': {
      // round half up, as Clipper. The angle comes from the snapped vertices: when steps × angle is k + ½ (a 45° corner
      // with $fn = 12), the grid decides which way it rounds, and the exact angle would give one step more or less
      const steps = Math.max(Math.round(s.stepsPerRad * Math.abs(turn)), 1)
      let x = kx, y = ky
      for (let i = 0; i < steps; i++) {
        out.push([p[0] + x * d, p[1] + y * d])
        const x2 = x
        x = x * s.cos - s.sin * y
        y = x2 * s.sin + y * s.cos
      }
      out.push([p[0] + jx * d, p[1] + jy * d])
    }
  }
}

/** The raw offset path of one closed outline (its own orientation decides which side is outside). */
function rawOffset(loop: Loop, s: JoinSetup): Loop {
  const pts: Vec2[] = []
  for (const p of loop) {
    const q = pts[pts.length - 1]
    if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p)
  }
  while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop()
  const n = pts.length
  if (n < 2) return []
  const nx: number[] = [], ny: number[] = []
  // the same normals from the vertices on Clipper's grid: only for the angle of each corner (see addJoin)
  const gx: number[] = [], gy: number[] = []
  // truncated, not rounded: that matches OpenSCAD 2021.01 on all 84 cases of a $fn × corner sweep (rounding: 82)
  const snap = (v: number) => Math.trunc(v * CLIPPER_SCALE)
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n]
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy)
    nx.push(dy / l); ny.push(-dx / l) // right-hand normal: outward for counter-clockwise outlines
    const ex = snap(b[0]) - snap(a[0]), ey = snap(b[1]) - snap(a[1]), m = Math.hypot(ex, ey)
    if (m > 0) { gx.push(ey / m); gy.push(-ex / m) } else { gx.push(dy / l); gy.push(-dx / l) }
  }
  const out: Vec2[] = []
  for (let j = 0; j < n; j++) {
    const k = (j + n - 1) % n
    const turn = Math.atan2(gx[k] * gy[j] - gx[j] * gy[k], gx[k] * gx[j] + gy[k] * gy[j])
    addJoin(out, s, pts[j], nx[k], ny[k], nx[j], ny[j], turn)
  }
  return out
}

/** offset(r | delta, chamfer) of a region. */
export function offsetRegion(r: Region, delta: number, join: Join, frag: Fragments): Region {
  if (r.length === 0 || delta === 0 || !Number.isFinite(delta)) return delta === 0 ? r : []
  const s = setup(delta, join, frag)
  return fillPositive(r.map((l) => rawOffset(l, s)).filter((l) => l.length >= 3))
}

/** Point count a round offset adds per full turn (for the budget estimate). */
export function roundSteps(delta: number, frag: Fragments): number {
  return Math.ceil(setup(delta, 'round', frag).stepsPerRad * 2 * Math.PI)
}

/** An open polyline stroked with round caps and joins (text strokes): the path there and back, offset by w/2. */
export function strokePaths(paths: Vec2[][], width: number, frag: Fragments): Region {
  const s = setup(width / 2, 'round', frag)
  const raws: Loop[] = []
  for (const path of paths) {
    const pts: Vec2[] = []
    for (const p of path) {
      const q = pts[pts.length - 1]
      if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p)
    }
    if (pts.length === 1) pts.push([pts[0][0] + width * 1e-3, pts[0][1]]) // a dot
    if (pts.length < 2) continue
    const closed = pts.length > 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]
    if (closed) {
      // a closed stroke is the ring between the outline offset out and in
      const loop = pts.slice(0, -1)
      raws.push(rawOffset(loop, s), rawOffset([...loop].reverse(), s))
      continue
    }
    raws.push(rawOffset([...pts, ...pts.slice(1, -1).reverse()], s))
  }
  return fillPositive(raws.filter((l) => l.length >= 3))
}
