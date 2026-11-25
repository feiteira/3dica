// projection(): the shadow of a solid on the XY plane (cut = false), or its section at z = 0 (cut = true).
//   shadow   the union of the upward faces, projected (a convex piece is just the hull of its projected points)
//   section  the closed set solid ∩ {z = 0}: the union of the sections just above and just below the plane, so faces
//            lying in the plane count (as in OpenSCAD: a cube standing on z = 0 cuts to its bottom square)
import type { Vec2, Vec3 } from './types'
import { arrangeSegments, hull2, union2, type Region, type Seg } from './build-2d'
import { newell } from './tess'

export function projectShadow(pieces: { polys: Vec3[][]; convex: boolean }[]): Region {
  const regions: Region[] = []
  const segs: Seg[] = []
  for (const piece of pieces) {
    if (piece.convex) {
      const h = hull2(piece.polys.flatMap((p) => p.map((v): Vec2 => [v[0], v[1]])))
      if (h.length) regions.push([h])
      continue
    }
    let size = 0
    for (const p of piece.polys) for (const v of p) size = Math.max(size, Math.abs(v[0]), Math.abs(v[1]))
    const tiny = 1e-24 * size * size
    for (const p of piece.polys) {
      if (newell(p)[2] / 2 <= tiny) continue // facing down or sideways
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length]
        segs.push({ a: [a[0], a[1]], b: [b[0], b[1]], op: 0 })
      }
    }
  }
  if (segs.length) regions.push(arrangeSegments(segs, 1, (w) => w[0] > 0))
  return union2(regions)
}

/** One pass of the section: vertices with z > 0 (above = 'strict') or z ≥ 0 count as above. */
function sectionSegs(polys: Vec3[][], strict: boolean, op: number, out: Seg[]): void {
  for (const p of polys) {
    const n = p.length
    const up = p.map((v) => (strict ? v[2] > 0 : v[2] >= 0))
    let any = false, all = true
    for (const u of up) { any ||= u; all &&= u }
    if (!any || all) continue
    const nn = newell(p)
    const dx = -nn[1], dy = nn[0] // the section runs this way (inside on its left)
    const pts: Vec2[] = []
    for (let i = 0; i < n; i++) {
      const a = p[i], b = p[(i + 1) % n]
      if (up[i] === up[(i + 1) % n]) continue
      const t = (0 - a[2]) / (b[2] - a[2])
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
    pts.sort((u, v) => (u[0] - v[0]) * dx + (u[1] - v[1]) * dy)
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const a = pts[i], b = pts[i + 1]
      if (a[0] !== b[0] || a[1] !== b[1]) out.push({ a, b, op })
    }
  }
}

export function projectCut(pieces: { polys: Vec3[][] }[]): Region {
  const segs: Seg[] = []
  for (const piece of pieces) {
    sectionSegs(piece.polys, true, 0, segs)
    sectionSegs(piece.polys, false, 1, segs)
  }
  if (segs.length === 0) return []
  return arrangeSegments(segs, 2, (w) => w[0] > 0 || w[1] > 0)
}
