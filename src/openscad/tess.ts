// OpenSCAD 2021.01 tessellation of the primitives, so vertex positions match the binary's STL export.
// Pure geometry: arrays of points and polygons, no JSCAD. Polygons are returned in JSCAD winding
// (counter-clockwise seen from outside).
//
// The fragment count is the formula documented in the OpenSCAD manual ("$fa, $fs and $fn"):
//   r < GRID_FINE        → 3
//   $fn > 0              → max($fn, 3)   (truncated to an integer)
//   otherwise            → ceil(max(min(360 / $fa, 2πr / $fs), 5))
import type { Fragments, Vec2, Vec3 } from './types'
import { splitFace } from './build-face'

/** Below this radius OpenSCAD always uses 3 fragments (2^-20). */
export const GRID_FINE = 2 ** -20
/** $fa and $fs below this are clamped, with a warning (as OpenSCAD 2021.01 does). */
export const F_MINIMUM = 0.01

/** The fragments with $fa / $fs clamped to F_MINIMUM; `warn` receives OpenSCAD's warning text. */
export function clampFragments(f: Fragments, warn: (message: string) => void): Fragments {
  let { fn, fa, fs } = f
  // OpenSCAD checks $fs first, then $fa
  if (!(fs >= F_MINIMUM)) { warn('$fs too small - clamping to 0.010000'); fs = F_MINIMUM }
  if (!(fa >= F_MINIMUM)) { warn('$fa too small - clamping to 0.010000'); fa = F_MINIMUM }
  return fn === f.fn && fa === f.fa && fs === f.fs ? f : { fn, fa, fs }
}

/** Number of fragments of a full circle of radius r. */
export function fragments(r: number, f: Fragments): number {
  if (!(r >= GRID_FINE) || !Number.isFinite(f.fn)) return 3
  if (f.fn > 0) return f.fn >= 3 ? Math.trunc(f.fn) : 3
  return Math.ceil(Math.max(Math.min(360 / f.fa, (r * 2 * Math.PI) / f.fs), 5))
}

const mod360 = (x: number): number => {
  if (x >= 0 && x < 360) return x
  const m = x % 360
  return m < 0 ? m + 360 : m
}

const HALF_SQRT3 = Math.sqrt(3) / 2
/** sin at multiples of 30°: OpenSCAD returns exact values there (so circles are exactly symmetric, and its arc
 *  tolerance for $fn = 6 rounds the way the binary does) */
const SIN30 = [0, 0.5, HALF_SQRT3, 1, HALF_SQRT3, 0.5, 0, -0.5, -HALF_SQRT3, -1, -HALF_SQRT3, -0.5]

/** sin of an angle in degrees, exact at multiples of 30°. */
export function sinDeg(x: number): number {
  const a = mod360(x)
  if (a % 30 === 0) return SIN30[a / 30]
  return Math.sin((a * Math.PI) / 180)
}

/** cos of an angle in degrees, exact at multiples of 30°. */
export function cosDeg(x: number): number {
  const a = mod360(x)
  if (a % 30 === 0) return SIN30[(a / 30 + 3) % 12]
  return Math.cos((a * Math.PI) / 180)
}

/** n points of a circle of radius r, counter-clockwise, the first at angle 0. */
export function circlePoints(r: number, n: number): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const phi = (360 * i) / n
    out.push([r * cosDeg(phi), r * sinDeg(phi)])
  }
  return out
}

/** square/rectangle outline, counter-clockwise; [] when a side is not positive */
export function squarePoints(size: Vec2, center: boolean): Vec2[] {
  const [w, h] = size
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return []
  const x0 = center ? -w / 2 : 0, y0 = center ? -h / 2 : 0
  return [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
}

export type PolyList = Vec3[][]

export function cubePolygons(size: Vec3, center: boolean): PolyList {
  const [w, d, h] = size
  if (!(w > 0) || !(d > 0) || !(h > 0) || ![w, d, h].every(Number.isFinite)) return []
  const x0 = center ? -w / 2 : 0, y0 = center ? -d / 2 : 0, z0 = center ? -h / 2 : 0
  const x1 = x0 + w, y1 = y0 + d, z1 = z0 + h
  const p = (x: number, y: number, z: number): Vec3 => [x, y, z]
  return [
    [p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), p(x1, y0, z0)], // bottom (−z)
    [p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1)], // top (+z)
    [p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1)], // front (−y)
    [p(x0, y1, z0), p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0)], // back (+y)
    [p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0)], // left (−x)
    [p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), p(x1, y0, z1)], // right (+x)
  ]
}

/** Rings of a sphere with n fragments: (n + 1) / 2 rings at latitudes 180·(i + ½) / rings, no poles. */
export function sphereRings(n: number): number {
  return Math.floor((n + 1) / 2)
}

export function spherePolygons(r: number, n: number): PolyList {
  if (!(r > 0) || !Number.isFinite(r)) return []
  const rings = sphereRings(n)
  const ring: Vec3[][] = []
  for (let i = 0; i < rings; i++) {
    const phi = (180 * (i + 0.5)) / rings
    const rr = r * sinDeg(phi), z = r * cosDeg(phi)
    ring.push(circlePoints(rr, n).map(([x, y]) => [x, y, z]))
  }
  const out: PolyList = [ring[0]] // top cap, counter-clockwise seen from above
  for (let i = 0; i + 1 < rings; i++) {
    const a = ring[i], b = ring[i + 1]
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n
      out.push([a[j], b[j], b[k], a[k]])
    }
  }
  out.push([...ring[rings - 1]].reverse()) // bottom cap
  return out
}

/** OpenSCAD makes nothing for h ≤ 0, a negative radius or two zero radii. */
export function cylinderPolygons(h: number, r1: number, r2: number, center: boolean, n: number): PolyList {
  if (!(h > 0) || !(r1 >= 0) || !(r2 >= 0) || (r1 === 0 && r2 === 0) || ![h, r1, r2].every(Number.isFinite)) return []
  const z1 = center ? -h / 2 : 0, z2 = center ? h / 2 : h
  const bottom: Vec3[] = r1 > 0 ? circlePoints(r1, n).map(([x, y]) => [x, y, z1]) : []
  const top: Vec3[] = r2 > 0 ? circlePoints(r2, n).map(([x, y]) => [x, y, z2]) : []
  const out: PolyList = []
  if (r1 > 0) out.push([...bottom].reverse())
  if (r2 > 0) out.push(top)
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n
    if (r1 > 0 && r2 > 0) out.push([bottom[j], bottom[k], top[k], top[j]])
    else if (r1 > 0) out.push([bottom[j], bottom[k], [0, 0, z2]])
    else out.push([[0, 0, z1], top[k], top[j]])
  }
  return out
}

// ───────────────────────────── polyhedron faces ─────────────────────────────

/** Newell normal of a 3D polygon (not normalized; zero for a degenerate polygon). */
export function newell(pts: Vec3[]): Vec3 {
  let nx = 0, ny = 0, nz = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    nx += (a[1] - b[1]) * (a[2] + b[2])
    ny += (a[2] - b[2]) * (a[0] + b[0])
    nz += (a[0] - b[0]) * (a[1] + b[1])
  }
  return [nx, ny, nz]
}

/**
 * A face as convex planar pieces: the face itself when it is planar and convex, otherwise triangles split as OpenSCAD
 * splits them (see build-face.ts). `pts` is in OpenSCAD's internal order (the polyhedron() face reversed), which is
 * JSCAD winding; `triangulate` is the 2D ear clipper (injected so this module stays free of the 2D engine).
 */
export function convexPieces(pts: Vec3[], triangulate: (loop: Vec2[]) => number[][]): Vec3[][] {
  if (pts.length === 3) return [pts]
  const n = newell(pts)
  const len = Math.hypot(n[0], n[1], n[2])
  if (!(len > 0)) return []
  const ux = n[0] / len, uy = n[1] / len, uz = n[2] / len
  // planarity and convexity
  let size = 0
  for (const p of pts) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]))
  const tol = 1e-9 * Math.max(size, 1e-300)
  const d0 = ux * pts[0][0] + uy * pts[0][1] + uz * pts[0][2]
  let planar = true
  for (const p of pts) if (Math.abs(ux * p[0] + uy * p[1] + uz * p[2] - d0) > tol) { planar = false; break }
  if (planar) {
    let convex = true
    for (let i = 0; i < pts.length && convex; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length]
      const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2]
      const e2x = c[0] - b[0], e2y = c[1] - b[1], e2z = c[2] - b[2]
      const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x
      if (cx * ux + cy * uy + cz * uz < -1e-12 * size * size) convex = false
    }
    if (convex) return [pts]
  }
  return splitFace(pts, triangulate).map((t) => t.map((i) => pts[i]))
}
