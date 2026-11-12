// §3.3 sample project "Bracket kit" — fixed ids, code verbatim from the spec [verified under jscad 2.13].
import type { Instance, ParamDef, Project, Vec3 } from './types'

const num = (name: string, def: number, min: number, max: number, step: number): ParamDef => ({ name, type: 'number', default: def, min, max, step })
const at = (id: string, def: string, t: Vec3 = [0, 0, 0], r: Vec3 = [0, 0, 0], name?: string): Instance => {
  const inst: Instance = { id, def, xf: { t, r, s: [1, 1, 1] } }
  if (name !== undefined) inst.name = name
  return inst
}

export const BOLT_CODE = `const { length, diameter } = params
const r = diameter / 2
const headH = 0.7 * diameter
// hex head: a 6-segment cylinder is a hexagonal prism
const head = cylinder({ radius: 0.9 * diameter, height: headH, segments: 6, center: [0, 0, headH / 2] })
// thread look without booleans: an off-centre circle twisted along the shank
const pitch = 0.8
const profile = translate([0.06 * r, 0, 0], circle({ radius: 0.94 * r, segments: 24 }))
const turns = length / pitch
const shank = translateZ(-length, extrudeLinear({ height: length, twistAngle: turns * 2 * Math.PI, twistSteps: Math.ceil(turns * 6) }, profile))
return [head, shank]`

export const PLATE_CODE = `const { width, depth, thickness, holeDiameter, inset } = params
const slab = roundedCuboid({ size: [width, depth, thickness], roundRadius: Math.min(1.5, thickness / 2 - 0.1), segments: 16, center: [0, 0, thickness / 2] })
const holes = []
for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
  holes.push(cylinder({ radius: holeDiameter / 2, height: thickness + 2, segments: 32,
    center: [sx * (width / 2 - inset), sy * (depth / 2 - inset), thickness / 2] }))
}
return subtract(slab, holes)`

export const DISC_CODE = `return cylinder({ radius: params.radius, height: params.thickness, segments: 48, center: [0, 0, params.thickness / 2] })`

export const HOLE_CODE = `return cylinder({ radius: params.radius, height: params.height, segments: 32 })`

export const BOLT_SIZES_CODE = `const out = []
for (let i = 0; i < params.count; i++) {
  const length = params.start + i * params.step
  out.push(translate([i * params.spacing, 0, length], part('Bolt', { length })))
}
return out`

/** The four fixture corner positions P (§3.3). */
const CORNERS: [number, number][] = [[-23, -13], [23, -13], [-23, 13], [23, 13]]

/** Tree rows expanded by default when the sample loads (UiState.expanded). */
export const SAMPLE_EXPANDED: Record<string, boolean> = { i_fx1: true, i_fx2: true }

/** A fresh copy of the sample project every call. */
export function sampleProject(): Project {
  return {
    format: '3dica',
    version: 1,
    name: 'Bracket kit',
    root: 'd_root',
    defs: {
      d_bolt: { id: 'd_bolt', name: 'Bolt', kind: 'code', color: '#aab4be', params: [num('length', 12, 4, 80, 1), num('diameter', 5, 2, 20, 0.5)], code: BOLT_CODE },
      d_plate: {
        id: 'd_plate', name: 'Plate', kind: 'code', color: '#4f8fd8',
        params: [num('width', 60, 20, 300, 1), num('depth', 40, 20, 300, 1), num('thickness', 4, 2, 20, 0.5), num('holeDiameter', 5.5, 1, 20, 0.5), num('inset', 7, 3, 50, 0.5)],
        code: PLATE_CODE,
      },
      d_disc: { id: 'd_disc', name: 'Disc', kind: 'code', color: '#c9a227', params: [num('radius', 5, 0.5, 100, 0.5), num('thickness', 1, 0.1, 20, 0.1)], code: DISC_CODE },
      d_hole: { id: 'd_hole', name: 'Hole', kind: 'code', color: '#e05252', params: [num('radius', 2.75, 0.1, 100, 0.05), num('height', 3, 0.1, 100, 0.5)], code: HOLE_CODE },
      d_washer: { id: 'd_washer', name: 'Washer', kind: 'group', op: 'subtract', color: '#c9a227', children: [at('i_disc', 'd_disc'), at('i_hole', 'd_hole')] },
      d_fixture: {
        id: 'd_fixture', name: 'Fixture', kind: 'group', op: 'none',
        children: [
          at('i_plate', 'd_plate'),
          ...CORNERS.map(([x, y], k) => at(`i_w${k + 1}`, 'd_washer', [x, y, 4])),
          ...CORNERS.map(([x, y], k) => at(`i_b${k + 1}`, 'd_bolt', [x, y, 5])),
        ],
      },
      d_boltsizes: {
        id: 'd_boltsizes', name: 'Bolt sizes', kind: 'code', color: '#aab4be',
        params: [num('count', 5, 1, 20, 1), num('start', 8, 4, 80, 1), num('step', 4, 0, 20, 1), num('spacing', 12, 1, 100, 1)],
        code: BOLT_SIZES_CODE,
      },
      d_root: {
        id: 'd_root', name: 'Scene', kind: 'group', op: 'none',
        children: [
          at('i_fx1', 'd_fixture', [0, 0, 0], [0, 0, 0], 'Fixture A'),
          at('i_fx2', 'd_fixture', [75, 0, 0], [0, 0, 15], 'Fixture B'),
          at('i_bs', 'd_boltsizes', [-24, -45, 0]),
        ],
      },
    },
  }
}
