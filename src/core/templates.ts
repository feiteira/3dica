// §3.2 templates. Every primitive sits ON the XY plane (z ≥ 0) and is centered in XY.
import type { Definition, ParamDef, Project, Vec3 } from './types'
import { newId, uniqueName } from './ids'

export type TemplateKind = 'cube' | 'sphere' | 'cylinder' | 'torus' | 'code' | 'group'

export const PALETTE = ['#4f8fd8', '#e07a3a', '#52b788', '#c9a227', '#b56ad8', '#e05252', '#3fb6c6', '#9aa4b2'] as const

export const BLANK_CODE_HEADER = `// params: this object's parameters (defaults + per-instance overrides)
// The main @jscad/modeling functions are in scope: cuboid, sphere, cylinder, union, subtract, translate, rotate, extrudeLinear, … (the rest: jscad.*)
// part('Name', { param: value }) returns another object's geometry, like calling an OpenSCAD module.
// Return a 3D shape or an array of shapes.
`

export interface Template {
  kind: TemplateKind
  /** toolbar label / undo label ("Add Cube") */
  label: string
  /** base for uniqueName */
  baseName: string
  /** nominal half-width for placement (§4.2) */
  halfWidth: number
  /** code templates only */
  params?: ParamDef[]
  code?: string
}

const num = (name: string, def: number, min: number, max: number, step: number): ParamDef => ({ name, type: 'number', default: def, min, max, step })

export const TEMPLATES: Record<TemplateKind, Template> = {
  cube: {
    kind: 'cube', label: 'Cube', baseName: 'Cube', halfWidth: 5,
    params: [num('width', 10, 0.1, 500, 1), num('depth', 10, 0.1, 500, 1), num('height', 10, 0.1, 500, 1)],
    code: 'const { width, depth, height } = params\nreturn cuboid({ size: [width, depth, height], center: [0, 0, height / 2] })\n',
  },
  sphere: {
    kind: 'sphere', label: 'Sphere', baseName: 'Sphere', halfWidth: 6,
    params: [num('radius', 6, 0.1, 500, 0.5), num('segments', 32, 4, 128, 1)],
    code: 'const { radius, segments } = params\nreturn sphere({ radius, segments, center: [0, 0, radius] })\n',
  },
  cylinder: {
    kind: 'cylinder', label: 'Cylinder', baseName: 'Cylinder', halfWidth: 5,
    params: [num('radius', 5, 0.1, 500, 0.5), num('height', 10, 0.1, 500, 1), num('segments', 32, 4, 128, 1)],
    code: 'const { radius, height, segments } = params\nreturn cylinder({ radius, height, segments, center: [0, 0, height / 2] })\n',
  },
  torus: {
    kind: 'torus', label: 'Torus', baseName: 'Torus', halfWidth: 7.5,
    params: [num('innerRadius', 1.5, 0.1, 100, 0.1), num('outerRadius', 6, 0.5, 500, 0.5)],
    code: 'const { innerRadius, outerRadius } = params\nreturn translateZ(innerRadius, torus({ innerRadius, outerRadius, innerSegments: 16, outerSegments: 48 }))\n',
  },
  code: {
    kind: 'code', label: 'Code', baseName: 'Object', halfWidth: 5,
    params: [num('size', 10, 0.1, 500, 1)],
    code: BLANK_CODE_HEADER + 'const { size } = params\nreturn roundedCuboid({ size: [size, size, size], roundRadius: size / 10, segments: 8, center: [0, 0, size / 2] })\n',
  },
  group: { kind: 'group', label: 'Group', baseName: 'Group', halfWidth: 0 },
}

/**
 * A new, not-yet-added def from a template (§3.2): uniqueName(baseName), color PALETTE[colorIndex % 8] for code
 * templates (groups get no color and should not advance the caller's counter). Add it with ops.addDef.
 */
export function createTemplateDef(kind: TemplateKind, project: Project, colorIndex: number): Definition {
  const t = TEMPLATES[kind]
  const name = uniqueName(t.baseName, Object.values(project.defs).map((d) => d.name))
  const id = newId('d')
  if (kind === 'group') return { id, name, kind: 'group', op: 'none', children: [] }
  return { id, name, kind: 'code', color: PALETTE[((colorIndex % PALETTE.length) + PALETTE.length) % PALETTE.length], code: t.code!, params: structuredClone(t.params!) }
}

/**
 * §4.2 placement of a new instance: [ceil(maxX + 5 + halfW), 0, 0] where maxX is the max X of the evaluated
 * parent-space bbox of the target's visible children; [0, 0, 0] when nothing is evaluated or the group is empty.
 */
export function placementFor(kind: TemplateKind, maxX: number | null | undefined): Vec3 {
  if (typeof maxX !== 'number' || !Number.isFinite(maxX)) return [0, 0, 0]
  return [Math.ceil(maxX + 5 + TEMPLATES[kind].halfWidth), 0, 0]
}
