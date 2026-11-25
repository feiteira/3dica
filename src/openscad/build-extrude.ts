// linear_extrude() and rotate_extrude() as OpenSCAD 2021.01 builds them: the same slice levels and vertex
// placement (slice j of n: the outline rotated by -twist·j/n, scaled by 1 - (1 - scale)·j/n), so vertices match.
//
// Default number of slices (fitted to the binary; "frag(r)" is the circle fragment formula):
//   twist ≠ 0  max(ceil(min(|twist| / $fa, L / $fs)), ceil(|twist| / 120))  ($fn > 0: ceil($fn·|twist| / 360))
//              L = path length of the outermost point: sqrt((r·twist)² + h²) for a helix; with a uniform scale ≠ 1
//              the arc length of the matching planar Archimedean spiral combined with h (a scale s > 1 is
//              measured as 1/s, like the binary)
//   only a non-uniform scale: ceil(sqrt(d² + h²) / $fs), d = the largest distance a point moves ($fn > 0: $fn)
//   otherwise 1
import type { Fragments, Vec2, Vec3 } from './types'
import type { Region } from './build-2d'
import { triangulateRegion } from './build-tri'
import { cosDeg, fragments, GRID_FINE, sinDeg } from './tess'

export interface LinearOpts { height: number; center: boolean; twist: number; slices?: number; scale: Vec2; frag: Fragments }

const asinh = (x: number) => Math.log(x + Math.sqrt(x * x + 1))

export function linearSlices(r: Region, o: LinearOpts): number {
  if (o.slices !== undefined && Number.isFinite(o.slices) && Math.trunc(o.slices) >= 1) return Math.trunc(o.slices)
  const [sx, sy] = o.scale
  const { fn, fa, fs } = o.frag
  const h = o.height
  if (o.twist !== 0) {
    const tw = Math.abs(o.twist)
    const minSlices = Math.max(Math.ceil(tw / 120), 1)
    let r2 = 0
    for (const l of r) for (const p of l) r2 = Math.max(r2, p[0] * p[0] + p[1] * p[1])
    const rmax = Math.sqrt(r2)
    if (rmax < GRID_FINE || !Number.isFinite(fn)) return minSlices
    if (fn > 0) return Math.max(Math.ceil((tw / 360) * fn), minSlices)
    const rad = (tw * Math.PI) / 180
    let L: number
    if (sx === sy && sx !== 1 && sx >= 0) {
      const s = sx > 1 ? 1 / sx : sx
      const end = rad / (1 - s), start = end - rad, a = rmax / end
      const G = (phi: number) => phi * Math.sqrt(1 + phi * phi) + asinh(phi)
      const planar = (a / 2) * (G(end) - G(start))
      L = Math.sqrt(planar * planar + h * h)
    } else {
      L = Math.sqrt(rmax * rad * rmax * rad + h * h)
    }
    return Math.max(Math.ceil(Math.min(tw / fa, L / fs)), minSlices)
  }
  if (sx !== sy) {
    if (!Number.isFinite(fn)) return 1
    if (fn > 0) return Math.max(Math.trunc(fn), 1)
    let d2 = 0
    for (const l of r) for (const p of l) {
      const dx = p[0] * (sx - 1), dy = p[1] * (sy - 1)
      d2 = Math.max(d2, dx * dx + dy * dy)
    }
    return Math.max(Math.ceil(Math.sqrt(d2 + h * h) / fs), 1)
  }
  return 1
}

const dist2 = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2

/**
 * Which diagonal splits a non-planar wall quad (p1, c1 on the lower slice, p2, c2 above them): the shorter one,
 * and on a tie the one in the twist direction. This is what the binary does (fitted on twisted, scaled and holed
 * extrusions: volumes match to 1e-8); it matters, a twisted quad's diagonal changes the volume.
 * true = diagonal p1–c2.
 */
function diag(p1: Vec3, c1: Vec3, p2: Vec3, c2: Vec3, dflt: boolean): boolean {
  const a = dist2(p1, c2), b = dist2(c1, p2)
  if (Math.abs(a - b) <= 1e-9 * Math.max(a, b)) return dflt
  return a < b
}
const area3 = (a: Vec3, b: Vec3, c: Vec3): number => {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
}

/** Polygons (JSCAD winding) of linear_extrude of a region with `n` slices. */
export function linearExtrude(r: Region, o: LinearOpts, n: number): Vec3[][] {
  const h = o.height
  if (!(h > 0) || r.length === 0) return []
  const [sx, sy] = o.scale
  const h1 = o.center ? -h / 2 : 0, h2 = o.center ? h / 2 : h
  const level = (j: number) => {
    const rot = (o.twist * j) / n
    const c = cosDeg(rot), s = sinDeg(rot)
    const kx = 1 - ((1 - sx) * j) / n, ky = 1 - ((1 - sy) * j) / n
    const z = j === n ? h2 : h1 + ((h2 - h1) * j) / n
    // rotate by -rot, then scale
    return (p: Vec2): Vec3 => [kx * (p[0] * c + p[1] * s), ky * (-p[0] * s + p[1] * c), z]
  }
  const out: Vec3[][] = []
  const { points, tris } = triangulateRegion(r)
  const bottom = level(0)
  const b = points.map(bottom)
  for (const t of tris) out.push([b[t[0]], b[t[2]], b[t[1]]])
  if (sx > 0 && sy > 0) {
    const top = level(n)
    const tp = points.map(top)
    for (const t of tris) out.push([tp[t[0]], tp[t[1]], tp[t[2]]])
  }
  const planar = o.twist === 0 && sx === sy
  const forward = o.twist >= 0
  for (const loop of r) {
    const m = loop.length
    let ccw = 0
    for (let i = 0; i < m; i++) ccw += loop[i][0] * loop[(i + 1) % m][1] - loop[(i + 1) % m][0] * loop[i][1]
    const tie = forward !== (ccw < 0) // holes run the other way round
    let lo = loop.map(level(0))
    for (let j = 0; j < n; j++) {
      const hi = loop.map(level(j + 1))
      for (let i = 0; i < m; i++) {
        const k = (i + 1) % m
        const p1 = lo[i], c1 = lo[k], p2 = hi[i], c2 = hi[k]
        if (planar) {
          const quad = p2[0] === c2[0] && p2[1] === c2[1] ? [p1, c1, c2] : [p1, c1, c2, p2]
          out.push(quad)
        } else if (diag(p1, c1, p2, c2, tie)) {
          if (area3(p1, c1, c2) > 0) out.push([p1, c1, c2])
          if (area3(p1, c2, p2) > 0) out.push([p1, c2, p2])
        } else {
          if (area3(p1, c1, p2) > 0) out.push([p1, c1, p2])
          if (area3(c1, c2, p2) > 0) out.push([c1, c2, p2])
        }
      }
      lo = hi
    }
  }
  return out
}

export interface RotateSetup { angle: number; n: number; error?: string }

/** Angle (clamped to ±360), fragment count, or OpenSCAD's error when the outline crosses the Y axis. */
export function rotateSetup(r: Region, angle: number, frag: Fragments): RotateSetup {
  const a = Math.max(-360, Math.min(360, angle))
  let minX = 0, maxX = 0
  for (const l of r) for (const p of l) { if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0] }
  if (minX < 0 && maxX > 0) {
    return { angle: a, n: 0, error: `all points for rotate_extrude() must have the same X coordinate sign (range is ${minX.toFixed(2)} -> ${maxX.toFixed(2)})` }
  }
  const n = Math.max(Math.trunc((fragments(maxX - minX, frag) * Math.abs(a)) / 360), 1)
  return { angle: a, n }
}

/** Polygons of rotate_extrude: rings at 180° + k·360°/n for a full turn (as OpenSCAD), else from 0° to angle. */
export function rotateExtrude(r: Region, angle: number, n: number): Vec3[][] {
  if (angle === 0 || r.length === 0) return []
  const full = Math.abs(angle) === 360
  const thetas: number[] = []
  if (full) for (let k = 0; k <= n; k++) thetas.push(180 + (360 * (k % n)) / n)
  else for (let k = 0; k <= n; k++) thetas.push((angle * k) / n)
  const at = (p: Vec2, th: number): Vec3 => [p[0] * cosDeg(th), p[0] * sinDeg(th), p[1]]
  const out: Vec3[][] = []
  const push = (poly: Vec3[]) => {
    const q: Vec3[] = []
    for (const v of poly) {
      const last = q[q.length - 1]
      if (!last || last[0] !== v[0] || last[1] !== v[1] || last[2] !== v[2]) q.push(v)
    }
    while (q.length > 1 && q[0][0] === q[q.length - 1][0] && q[0][1] === q[q.length - 1][1] && q[0][2] === q[q.length - 1][2]) q.pop()
    if (q.length >= 3) out.push(q)
  }
  for (const loop of r) {
    const m = loop.length
    let ring = loop.map((p) => at(p, thetas[0]))
    for (let k = 0; k < n; k++) {
      const next = loop.map((p) => at(p, thetas[k + 1]))
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % m
        if (loop[i][0] === 0 && loop[j][0] === 0) continue // an edge on the axis sweeps nothing
        push([ring[i], ring[j], next[j], next[i]])
      }
      ring = next
    }
  }
  if (!full) {
    const { points, tris } = triangulateRegion(r)
    const s = points.map((p) => at(p, thetas[0])), e = points.map((p) => at(p, thetas[n]))
    for (const t of tris) {
      out.push([s[t[0]], s[t[2]], s[t[1]]])
      out.push([e[t[0]], e[t[1]], e[t[2]]])
    }
  }
  return orientOutward(out)
}

/** Signed volume of closed polygons (positive when they face outwards). */
export function signedVolume(polys: Vec3[][]): number {
  let v = 0
  for (const p of polys) {
    const a = p[0]
    for (let i = 1; i + 1 < p.length; i++) {
      const b = p[i], c = p[i + 1]
      v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])
    }
  }
  return v / 6
}

/** Flips every polygon when the solid is inside out (mirrored parameterizations). */
export function orientOutward(polys: Vec3[][]): Vec3[][] {
  return signedVolume(polys) < 0 ? polys.map((p) => [...p].reverse()) : polys
}
