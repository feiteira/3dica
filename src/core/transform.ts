// §7 transform.ts — the ONE transform convention (§12 risk 1). Column-major Mat4, M = T · Rz · Ry · Rx · S, degrees.
// Equivalent to three's Matrix4.compose(t, quat(Euler(r·D, 'ZYX')), s) and to jscad T·fromTaitBryanRotation(rz, ry, rx)·S [verified].
import type { Mat4, Transform, Vec3 } from './types'

export const DEG = Math.PI / 180

/** Axis-aligned box. Used for evaluated bboxes (§4.2 placement, §4.5 offsets, framing). */
export interface Box { min: Vec3; max: Vec3 }

export function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

/** Transform → column-major Mat4 (element [col * 4 + row]). */
export function toMatrix(xf: Transform): Mat4 {
  const [tx, ty, tz] = xf.t
  const [sx, sy, sz] = xf.s
  const a = xf.r[0] * DEG, b = xf.r[1] * DEG, c = xf.r[2] * DEG
  const ca = Math.cos(a), sa = Math.sin(a)
  const cb = Math.cos(b), sb = Math.sin(b)
  const cc = Math.cos(c), sc = Math.sin(c)
  // R = Rz(c) · Ry(b) · Rx(a)
  const r00 = cc * cb, r01 = cc * sb * sa - sc * ca, r02 = cc * sb * ca + sc * sa
  const r10 = sc * cb, r11 = sc * sb * sa + cc * ca, r12 = sc * sb * ca - cc * sa
  const r20 = -sb, r21 = cb * sa, r22 = cb * ca
  const m = [
    r00 * sx, r10 * sx, r20 * sx, 0,
    r01 * sy, r11 * sy, r21 * sy, 0,
    r02 * sz, r12 * sz, r22 * sz, 0,
    tx, ty, tz, 1,
  ]
  for (let i = 0; i < 16; i++) m[i] += 0 // -0 → 0
  return m
}

const SHEAR_TOL = 1e-6

/**
 * Mat4 → Transform, or null when the matrix cannot be expressed as T·Rz·Ry·Rx·S:
 * shear (non-orthogonal columns, |cos| > 1e-6, e.g. non-uniform scale under rotation), a zero / non-finite scale,
 * or a projective last row. The sign of the determinant goes onto s[0] (mirror in X).
 * Gimbal lock (|cos ry| ≤ 1e-6) gives r[0] = 0. Values are NOT rounded; use roundXf.
 */
export function fromMatrix(m: Mat4): Transform | null {
  if (m.length !== 16 || m.some((v) => !Number.isFinite(v))) return null
  if (Math.abs(m[3]) > 1e-9 || Math.abs(m[7]) > 1e-9 || Math.abs(m[11]) > 1e-9 || Math.abs(m[15] - 1) > 1e-9) return null
  const c0: Vec3 = [m[0], m[1], m[2]], c1: Vec3 = [m[4], m[5], m[6]], c2: Vec3 = [m[8], m[9], m[10]]
  let sx = Math.hypot(...c0)
  const sy = Math.hypot(...c1), sz = Math.hypot(...c2)
  if (!(sx > 1e-12) || !(sy > 1e-12) || !(sz > 1e-12)) return null
  const det = c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1])
  if (det < 0) sx = -sx
  const u0 = c0.map((v) => v / sx) as Vec3, u1 = c1.map((v) => v / sy) as Vec3, u2 = c2.map((v) => v / sz) as Vec3
  const dot = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2]
  if (Math.abs(dot(u0, u1)) > SHEAR_TOL || Math.abs(dot(u0, u2)) > SHEAR_TOL || Math.abs(dot(u1, u2)) > SHEAR_TOL) return null
  // rotation matrix R[row][col]: column j is u_j
  const r00 = u0[0], r10 = u0[1], r20 = u0[2]
  const r01 = u1[0], r11 = u1[1], r21 = u1[2]
  const r22 = u2[2]
  const ry = Math.asin(Math.max(-1, Math.min(1, -r20)))
  let rx: number, rz: number
  if (Math.abs(Math.cos(ry)) > 1e-6) { rx = Math.atan2(r21, r22); rz = Math.atan2(r10, r00) } else { rx = 0; rz = Math.atan2(-r01, r11) }
  return { t: [m[12], m[13], m[14]], r: [rx / DEG, ry / DEG, rz / DEG], s: [sx, sy, sz] }
}

/** a · b (column-major). */
export function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array<number>(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}

/** General 4×4 inverse; null if singular. */
export function invert(m: Mat4): Mat4 | null {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det || !Number.isFinite(det)) return null
  const d = 1 / det
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ]
}

/** Apply an affine Mat4 to a point. */
export function applyPoint(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]
}

/** AABB of the 8 transformed corners of `box`. */
export function transformBox(m: Mat4, box: Box): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < 8; i++) {
    const p = applyPoint(m, [i & 1 ? box.max[0] : box.min[0], i & 2 ? box.max[1] : box.min[1], i & 4 ? box.max[2] : box.min[2]])
    for (let k = 0; k < 3; k++) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k] }
  }
  return { min, max }
}

/** Union of boxes; null for an empty list. */
export function unionBoxes(boxes: Iterable<Box | null | undefined>): Box | null {
  let out: Box | null = null
  for (const b of boxes) {
    if (!b) continue
    if (!out) { out = { min: [...b.min] as Vec3, max: [...b.max] as Vec3 }; continue }
    for (let k = 0; k < 3; k++) { out.min[k] = Math.min(out.min[k], b.min[k]); out.max[k] = Math.max(out.max[k], b.max[k]) }
  }
  return out
}

function roundTo(v: number, step: number): number {
  const r = Math.round(v / step) * step
  // kill binary noise from the multiply (e.g. 0.30000000000000004) and -0
  const fixed = Number(r.toFixed(Math.max(0, Math.min(15, Math.ceil(-Math.log10(step)) + 1))))
  return fixed === 0 ? 0 : fixed
}

/** Round every component to `step` (default 1e-4, as the gizmo commit in §4.9) and replace -0 with 0. */
export function roundXf(xf: Transform, step = 1e-4): Transform {
  const f = (v: Vec3) => v.map((x) => roundTo(x, step)) as Vec3
  return { t: f(xf.t), r: f(xf.r), s: f(xf.s) }
}

/** Rounding used by world-preserving ops (moveInstance, ungroup): removes float noise without visible drift. */
export const OP_ROUND = 1e-6
/** Significant digits kept for scale by roundOpXf. */
export const OP_SCALE_DIGITS = 10

/**
 * The rounding of world-preserving ops: t and r to OP_ROUND (absolute: mm and degrees), s to OP_SCALE_DIGITS
 * significant digits (RELATIVE: an absolute step would turn a small scale such as 1e-7 into 0 — an invalid xf, §2.2 —
 * or change its size by tens of percent). -0 becomes 0.
 */
export function roundOpXf(xf: Transform): Transform {
  const r = roundXf({ t: xf.t, r: xf.r, s: [1, 1, 1] }, OP_ROUND)
  const sig = (v: number) => { const x = Number(v.toPrecision(OP_SCALE_DIGITS)); return x === 0 ? 0 : x }
  return { t: r.t, r: r.r, s: xf.s.map(sig) as Vec3 }
}

export function cloneXf(xf: Transform): Transform {
  return { t: [...xf.t] as Vec3, r: [...xf.r] as Vec3, s: [...xf.s] as Vec3 }
}

/** §2.2: three finite numbers each, no zero scale component. */
export function isValidXf(xf: unknown): xf is Transform {
  if (!xf || typeof xf !== 'object') return false
  const o = xf as Record<string, unknown>
  const v3 = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
  return v3(o.t) && v3(o.r) && v3(o.s) && (o.s as number[]).every((x) => x !== 0)
}

export function matricesClose(a: Mat4, b: Mat4, tol = 1e-9): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > tol) return false
  return true
}

export function isIdentityXf(xf: Transform): boolean {
  return xf.t.every((v) => v === 0) && xf.r.every((v) => v === 0) && xf.s.every((v) => v === 1)
}
