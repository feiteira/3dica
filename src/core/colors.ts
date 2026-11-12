// §2.4 color resolution (render time only; never part of a geometry key). Hex strings '#rrggbb'.
import type { Project } from './types'
import type { Occurrence } from './graph'

export const DEFAULT_COLOR = '#9aa4b2'

/**
 * Code leaf mesh: the outermost instance color on the path → the color baked by code (colorize; pass it as hex,
 * per geometry, e.g. '#' + entry.baked[i].getHexString(THREE.SRGBColorSpace)) → def.color → #9aa4b2.
 */
export function leafColor(occ: Occurrence, bakedHex?: string | null): string {
  return occ.colorFromInstance ?? bakedHex ?? occ.def.color ?? DEFAULT_COLOR
}

/**
 * Boolean group result: outermost instance color → the group def.color → the first visible operand's color
 * (its instance color, else its def color) → #9aa4b2. jscad booleans drop baked colors [verified].
 */
export function boolColor(project: Project, occ: Occurrence): string {
  if (occ.colorFromInstance) return occ.colorFromInstance
  if (occ.def.color) return occ.def.color
  if (occ.def.kind === 'group') {
    const first = occ.def.children.find((c) => !c.hidden)
    if (first) {
      const c = first.color ?? project.defs[first.def]?.color
      if (c) return c
    }
  }
  return DEFAULT_COLOR
}

/** Color of an operand's own geometry when drawn as an operand overlay (§4.4): its resolved leaf/bool color. */
export function occurrenceColor(project: Project, occ: Occurrence, bakedHex?: string | null): string {
  return occ.role === 'bool' ? boolColor(project, occ) : leafColor(occ, bakedHex)
}
