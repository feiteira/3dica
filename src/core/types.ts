// §2.1 — exact. Pure data types shared by every layer.

export type Id = string            // defs: 'd_' + id body, instances: 'i_' + id body; id body = /[a-z0-9]{1,32}/
export type Vec3 = [number, number, number]
export type Mat4 = number[]        // length 16, column-major. three Matrix4.elements and jscad mat4 use the same layout [verified]

/** M = T(t) · Rz(r[2]) · Ry(r[1]) · Rx(r[0]) · S(s), the same as OpenSCAD translate(t) rotate(r) scale(s).
 *  r is in degrees. In three this is Object3D.rotation.order = 'ZYX' [verified equal element-wise to jscad]. */
export interface Transform { t: Vec3; r: Vec3; s: Vec3 }

export type ParamValue = number | boolean | string
export interface ParamDef {
  name: string                     // valid JS identifier, unique within the def
  type: 'number' | 'boolean' | 'choice'
  default: ParamValue              // number for 'number', boolean for 'boolean', one of options for 'choice'
  min?: number; max?: number; step?: number   // UI hints only, never clamped at eval time
  options?: string[]               // required for 'choice', length >= 1
}

export type GroupOp = 'none' | 'union' | 'subtract' | 'intersect'   // subtract = (union of child 0) minus all later children

interface DefBase { id: Id; name: string; color?: string /* '#rrggbb' lowercase */ }
export interface CodeDef  extends DefBase { kind: 'code';  code: string; params: ParamDef[] }
export interface GroupDef extends DefBase { kind: 'group'; op: GroupOp; children: Instance[] }
export type Definition = CodeDef | GroupDef

export interface Instance {
  id: Id
  def: Id                          // the definition it places
  name?: string                    // optional label; the tree shows name ?? def.name
  xf: Transform                    // local transform in the parent group's space
  color?: string                   // '#rrggbb'
  params?: Record<string, ParamValue>   // overrides for code defs; unknown keys are kept but ignored
  hidden?: boolean                 // excluded from render, booleans, part() flattening and STL
}

export interface Project {
  format: '3dica'
  version: 1
  name: string
  root: Id                         // a GroupDef with op 'none'
  defs: Record<Id, Definition>
  camera?: { position: Vec3; target: Vec3 }
}

export type InstancePath = Id[]
export type Selection =
  | { kind: 'none' }
  | { kind: 'occ'; path: InstancePath }
  | { kind: 'def'; def: Id }

export interface UiState {
  selection: Selection
  context: InstancePath            // the entered group occurrence; [] means the scene root
  viewMode: 'context' | 'isolate'
  ghostOthers: boolean             // default true
  gizmoMode: 'translate' | 'rotate' | 'scale'
  gizmoSpace: 'world' | 'local'
  snap: boolean                    // default true: 1 mm / 15° / 0.1
  expanded: Record<string, boolean>   // tree rows, keyed by path.join('/')
  evalPaused: boolean              // true after "Open without running"
  autoIsolatedFrom?: 'context' | 'isolate'   // set when a Library click forced isolate; restored on the next occurrence selection
}
export const IDENTITY_XF: Transform = { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }
