import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import jscad from '@jscad/modeling'
import type { Mat4, Transform, Vec3 } from '../../src/core/types'
import { applyPoint, fromMatrix, identity, invert, mul, roundXf, toMatrix, transformBox, unionBoxes, DEG } from '../../src/core/transform'

// deterministic PRNG so failures are reproducible
let seed = 12345
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const rr = (a: number, b: number) => a + (b - a) * rand()

function threeMatrix(xf: Transform): number[] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(xf.r[0] * DEG, xf.r[1] * DEG, xf.r[2] * DEG, 'ZYX'))
  return new THREE.Matrix4().compose(new THREE.Vector3(...xf.t), q, new THREE.Vector3(...xf.s)).elements
}

function jscadMatrix(xf: Transform): number[] {
  const { mat4 } = jscad.maths
  const T = mat4.fromTranslation(mat4.create(), xf.t)
  const R = mat4.fromTaitBryanRotation(mat4.create(), xf.r[2] * DEG, xf.r[1] * DEG, xf.r[0] * DEG)
  const S = mat4.fromScaling(mat4.create(), xf.s)
  const out = mat4.create()
  mat4.multiply(out, T, R)
  mat4.multiply(out, out, S)
  return Array.from(out)
}

function randomXf(negative = false): Transform {
  const s: Vec3 = [rr(0.3, 3), rr(0.3, 3), rr(0.3, 3)]
  if (negative) s[Math.floor(rand() * 3)] *= -1
  return { t: [rr(-50, 50), rr(-50, 50), rr(-50, 50)], r: [rr(-180, 180), rr(-89, 89), rr(-180, 180)], s }
}

const expectMat = (a: number[], b: number[], digits = 9) => { for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(b[i], digits) }

describe('toMatrix', () => {
  test('equals three compose(ZYX) and jscad T·Rz·Ry·Rx·S for 50 random TRS (incl. negative scale)', () => {
    for (let k = 0; k < 50; k++) {
      const xf = randomXf(k % 5 === 0)
      const m = toMatrix(xf)
      expectMat(m, threeMatrix(xf))
      expectMat(m, jscadMatrix(xf))
    }
  })

  test('jscad rotate([x,y,z]) applied to a point equals toMatrix applied to it', () => {
    const r: Vec3 = [30, 40, 50]
    const cube = jscad.primitives.cuboid({ size: [2, 4, 6], center: [1, 2, 3] })
    const rotated = jscad.transforms.rotate([r[0] * DEG, r[1] * DEG, r[2] * DEG], cube)
    const v0 = jscad.geometries.geom3.toPoints(cube)[0][0] as unknown as Vec3
    const v1 = jscad.geometries.geom3.toPoints(rotated)[0][0] as unknown as Vec3
    const p = applyPoint(toMatrix({ t: [0, 0, 0], r, s: [1, 1, 1] }), v0)
    for (let i = 0; i < 3; i++) expect(p[i]).toBeCloseTo(v1[i], 9)
  })

  test('identity xf → identity matrix', () => {
    expect(toMatrix({ t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] })).toEqual(identity())
  })
})

describe('fromMatrix', () => {
  test('round-trips for |ry| < 89° (positive scales and a mirrored X)', () => {
    for (let k = 0; k < 100; k++) {
      const xf = randomXf(false)
      if (k % 4 === 0) xf.s[0] = -xf.s[0]
      const back = fromMatrix(toMatrix(xf))!
      expect(back).not.toBeNull()
      for (let i = 0; i < 3; i++) {
        expect(back.t[i]).toBeCloseTo(xf.t[i], 9)
        expect(back.r[i]).toBeCloseTo(xf.r[i], 6)
        expect(back.s[i]).toBeCloseTo(xf.s[i], 9)
      }
    }
  })

  test('any negative scale decomposes to an equal matrix', () => {
    for (let k = 0; k < 30; k++) {
      const xf = randomXf(true)
      const back = fromMatrix(toMatrix(xf))!
      expect(back).not.toBeNull()
      expectMat(toMatrix(back), toMatrix(xf))
    }
  })

  test('gimbal lock (ry = ±90°) gives rx = 0 and the same matrix', () => {
    for (const ry of [90, -90]) {
      const xf: Transform = { t: [1, 2, 3], r: [25, ry, 40], s: [1, 2, 3] }
      const back = fromMatrix(toMatrix(xf))!
      expect(back).not.toBeNull()
      expect(back.r[0]).toBe(0)
      expect(back.r[1]).toBeCloseTo(ry, 6)
      expectMat(toMatrix(back), toMatrix(xf))
    }
  })

  test('returns null for a sheared matrix (non-uniform scale under rotation)', () => {
    const parent = toMatrix({ t: [0, 0, 0], r: [0, 0, 0], s: [2, 1, 1] })
    const child = toMatrix({ t: [0, 0, 0], r: [0, 0, 45], s: [1, 1, 1] })
    expect(fromMatrix(mul(parent, child))).toBeNull()
    const shear: Mat4 = identity()
    shear[4] = 0.5 // x += 0.5 y
    expect(fromMatrix(shear)).toBeNull()
  })

  test('returns null for a zero scale', () => {
    expect(fromMatrix(toMatrix({ t: [0, 0, 0], r: [0, 0, 0], s: [0, 1, 1] }))).toBeNull()
  })
})

describe('mul / invert / boxes / roundXf', () => {
  test('m · invert(m) = I', () => {
    for (let k = 0; k < 20; k++) {
      const m = toMatrix(randomXf(k % 2 === 0))
      expectMat(mul(m, invert(m)!), identity(), 9)
    }
    expect(invert([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull()
  })

  test('mul matches three Matrix4.multiply', () => {
    const a = toMatrix(randomXf()), b = toMatrix(randomXf())
    const t = new THREE.Matrix4().fromArray(a).multiply(new THREE.Matrix4().fromArray(b)).elements
    expectMat(mul(a, b), t)
  })

  test('transformBox / unionBoxes', () => {
    const b = transformBox(toMatrix({ t: [10, 0, 0], r: [0, 0, 90], s: [1, 1, 1] }), { min: [0, 0, 0], max: [2, 1, 1] })
    expect(b.min[0]).toBeCloseTo(9, 9); expect(b.max[0]).toBeCloseTo(10, 9)
    expect(b.min[1]).toBeCloseTo(0, 9); expect(b.max[1]).toBeCloseTo(2, 9)
    expect(unionBoxes([null, { min: [0, 0, 0], max: [1, 1, 1] }, { min: [-1, 2, 0], max: [0, 3, 5] }])).toEqual({ min: [-1, 0, 0], max: [1, 3, 5] })
    expect(unionBoxes([])).toBeNull()
  })

  test('roundXf rounds to 1e-4 and replaces -0', () => {
    const r = roundXf({ t: [0.30000000000000004, -0.00001, 1.23456789], r: [-0, 14.99999, 0], s: [1.00004, 1, 1] })
    expect(r.t).toEqual([0.3, 0, 1.2346])
    expect(Object.is(r.t[1], -0)).toBe(false)
    expect(Object.is(r.r[0], -0)).toBe(false)
    expect(r.r[1]).toBe(15)
    expect(r.s[0]).toBe(1)
  })
})
