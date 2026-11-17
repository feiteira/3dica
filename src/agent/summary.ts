// One-line summaries for the collapsed tool cards of the chat ("cube 'Slab'", "'Bolt': code — 1 error"). Pure and
// dependency free, so the loop can use it without loading the tool layer.
import type { ToolOutput } from './types'

const MAX = 90

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const clip = (s: string): string => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const quoted = (v: unknown): string | undefined => (typeof v === 'string' && v ? `'${v}'` : undefined)
/** a path or a target: "i_fx1/i_b1", or a definition name */
const pathText = (v: unknown): string | undefined =>
  Array.isArray(v) ? (v.length ? v.join('/') : 'scene root') : typeof v === 'string' ? (v || 'scene root') : undefined
const fields = (o: Record<string, unknown>, keys: string[]): string => keys.filter((k) => o[k] !== undefined).join(', ')
const join = (...parts: (string | undefined | false)[]): string => parts.filter((p): p is string => !!p).join(' ')

/** What a call does, from its input ('' when there is nothing worth showing). */
export function summarizeCall(name: string, input: unknown): string {
  const o = isObj(input) ? input : {}
  let s: string
  switch (name) {
    case 'create_object': s = join(str(o.kind), quoted(o.name), o.parent !== undefined && `in ${pathText(o.parent)}`); break
    case 'update_definition': s = join(quoted(o.name), fields(o, ['code', 'params', 'defaults', 'op', 'color', 'rename']) && `: ${fields(o, ['code', 'params', 'defaults', 'op', 'color', 'rename'])}`); break
    case 'get_definition': s = quoted(o.name) ?? ''; break
    case 'add_instance': s = join(quoted(o.definition), o.parent !== undefined && `in ${pathText(o.parent)}`); break
    case 'update_instance': s = join(pathText(o.path), fields(o, ['transform', 'params', 'label', 'color', 'hidden']) && `: ${fields(o, ['transform', 'params', 'label', 'color', 'hidden'])}`); break
    case 'move_instance': s = join(pathText(o.path), '→', pathText(o.toParent) ?? 'scene root'); break
    case 'duplicate': s = join(pathText(o.path), str(o.mode)); break
    case 'wrap': s = join(pathText(o.path), 'in', str(o.op) ?? 'group'); break
    case 'make_unique': case 'ungroup': s = pathText(o.path) ?? ''; break
    case 'delete': s = o.path !== undefined ? pathText(o.path) ?? '' : join('definition', quoted(o.definition)); break
    case 'undo': case 'redo': s = typeof o.steps === 'number' && o.steps > 1 ? `${o.steps} steps` : ''; break
    case 'select': s = o.path !== undefined ? pathText(o.path) ?? '' : o.definition !== undefined ? join('definition', quoted(o.definition)) : 'clear'; break
    case 'set_view': s = ['mode', 'ghost', 'preset'].filter((k) => o[k] !== undefined).map((k) => `${k} ${String(o[k])}`).join(', '); break
    case 'get_scene': s = o.path !== undefined ? pathText(o.path) ?? '' : ''; break
    case 'screenshot': s = [str(o.view) ?? 'multi', o.target !== undefined && pathText(o.target), o.isolate === true && 'isolated'].filter(Boolean).join(' · '); break
    case 'new_project': s = quoted(o.name) ?? ''; break
    case 'save_project': s = str(o.fileName) ?? ''; break
    case 'export_stl': s = o.target !== undefined ? pathText(o.target) ?? '' : 'whole scene'; break
    default: s = ''
  }
  return clip(s)
}

/** The outcome, from the tool output: the error's first line, or error counts / sizes / a download name. */
export function summarizeResult(output: ToolOutput): string {
  const first = output.text.split('\n').find((l) => l.trim()) ?? ''
  if (output.isError) return clip(first.replace(/^Error: /, ''))
  let v: unknown
  try { v = JSON.parse(output.text) } catch { return clip(first) } // screenshots and declines are plain text
  if (!isObj(v)) return ''
  if (typeof v.downloaded === 'string') return clip(`downloaded ${v.downloaded}`)
  const errors = Array.isArray(v.errors) ? v.errors.length : 0
  const objects = Array.isArray(v.objects) ? v.objects.filter(isObj) : []
  const failed = objects.find((o) => o.status === 'error')
  if (failed) return clip(`${String(failed.definition)} has an error`)
  const sized = objects.find((o) => Array.isArray(o.size))
  const size = sized ? `${(sized.size as number[]).map((n) => Math.round(n * 100) / 100).join(' × ')} mm` : ''
  const parts = [size, errors ? `${errors} ${errors === 1 ? 'error' : 'errors'} in the project` : ''].filter(Boolean)
  if (v.evaluation === 'timeout') parts.push('still evaluating')
  return clip(parts.join(' · '))
}
