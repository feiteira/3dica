// §4.5 in-memory clipboard (the system clipboard is out of scope).
import type { InstancePath, Project, Transform, Vec3 } from '../core/types'
import { instanceAtPath } from '../core/graph'
import type { ClipboardEntry } from '../core/ops'

export type { ClipboardEntry } from '../core/ops'

/** Snapshot `{ def, xf, params, color, name }` of the instance at `path`, or null if it does not resolve. */
export function clipFromPath(project: Project, path: InstancePath): ClipboardEntry | null {
  const inst = instanceAtPath(project, path)
  if (!inst) return null
  const xf: Transform = { t: [...inst.xf.t] as Vec3, r: [...inst.xf.r] as Vec3, s: [...inst.xf.s] as Vec3 }
  const e: ClipboardEntry = { def: inst.def, xf }
  if (inst.params) e.params = structuredClone(inst.params)
  if (inst.color !== undefined) e.color = inst.color
  if (inst.name !== undefined) e.name = inst.name
  return e
}

export class Clipboard {
  private entry: ClipboardEntry | null = null
  get(): ClipboardEntry | null { return this.entry ? structuredClone(this.entry) : null }
  set(entry: ClipboardEntry | null): void { this.entry = entry ? structuredClone(entry) : null }
  clear(): void { this.entry = null }
  has(): boolean { return this.entry !== null }
}
