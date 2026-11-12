// §7 params.ts — parameter resolution and validation. Pure; shared by main thread and worker.
import type { Definition, ParamDef, ParamValue } from './types'

const RESERVED = new Set(('break case catch class const continue debugger default delete do else enum export extends false finally for ' +
  'function if import in instanceof new null return super switch this throw true try typeof var void while with yield ' +
  'let static implements interface package private protected public await arguments eval undefined NaN Infinity ' +
  // assigning `out.__proto__ = v` sets the prototype instead of a key, so such a parameter could never hold a value
  '__proto__').split(' '))

/** A valid JS identifier that is not a reserved word (§2.2 ParamDef names). */
export function isValidIdentifier(name: unknown): name is string {
  return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name)
}

/** Whether `v` is an acceptable value for `pd` (number: finite number; boolean; choice: one of options). */
export function isValidParamValue(pd: ParamDef, v: unknown): v is ParamValue {
  switch (pd.type) {
    case 'number': return typeof v === 'number' && Number.isFinite(v)
    case 'boolean': return typeof v === 'boolean'
    case 'choice': return typeof v === 'string' && (pd.options ?? []).includes(v)
  }
}

/**
 * Defaults of `paramDefs` merged with `overrides`. Only names declared in paramDefs appear in the result
 * (unknown override keys are ignored); an override of the wrong type is ignored too (the default is used).
 * Idempotent: resolving already-resolved params returns an equal object. Keys follow paramDefs order.
 */
export function resolveParamDefs(paramDefs: ParamDef[], overrides?: Record<string, ParamValue> | null): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const pd of paramDefs) {
    const o = overrides && Object.prototype.hasOwnProperty.call(overrides, pd.name) ? overrides[pd.name] : undefined
    out[pd.name] = o !== undefined && isValidParamValue(pd, o) ? o : pd.default
  }
  return out
}

/** resolveParams(def, instance.params): resolved params for a code def; {} for a group. */
export function resolveParams(def: Definition, overrides?: Record<string, ParamValue> | null): Record<string, ParamValue> {
  return def.kind === 'code' ? resolveParamDefs(def.params, overrides) : {}
}

/** Override keys not declared by the def ("stale override 'len' ✕" in the inspector, §4.10). */
export function staleOverrideKeys(def: Definition, overrides?: Record<string, ParamValue> | null): string[] {
  if (!overrides) return []
  const known = new Set(def.kind === 'code' ? def.params.map((p) => p.name) : [])
  return Object.keys(overrides).filter((k) => !known.has(k))
}

/** Keys of `overrides` not declared in `paramDefs` (the engine uses this to make part() overrides strict, §3.1). */
export function unknownParamKeys(paramDefs: ParamDef[], overrides?: Record<string, unknown> | null): string[] {
  if (!overrides) return []
  const known = new Set(paramDefs.map((p) => p.name))
  return Object.keys(overrides).filter((k) => !known.has(k))
}

/** Problems with a ParamDef list (§2.2), as readable strings; [] when valid. */
export function paramDefProblems(params: unknown): string[] {
  if (!Array.isArray(params)) return ['params must be a list']
  const problems: string[] = []
  const seen = new Set<string>()
  params.forEach((p, i) => {
    if (!p || typeof p !== 'object') { problems.push(`parameter ${i + 1} is not an object`); return }
    const pd = p as Record<string, unknown>
    const label = typeof pd.name === 'string' && pd.name ? `'${pd.name}'` : `${i + 1}`
    if (!isValidIdentifier(pd.name)) problems.push(`parameter ${label}: name must be a valid identifier`)
    else if (seen.has(pd.name)) problems.push(`parameter ${label}: duplicate name`)
    else seen.add(pd.name)
    if (pd.type !== 'number' && pd.type !== 'boolean' && pd.type !== 'choice') { problems.push(`parameter ${label}: type must be number, boolean or choice`); return }
    for (const k of ['min', 'max', 'step'] as const) {
      if (pd[k] !== undefined && !(typeof pd[k] === 'number' && Number.isFinite(pd[k]))) problems.push(`parameter ${label}: ${k} must be a number`)
    }
    if (pd.type === 'choice') {
      if (!Array.isArray(pd.options) || pd.options.length < 1 || !pd.options.every((o) => typeof o === 'string')) {
        problems.push(`parameter ${label}: a choice needs at least one option`)
        return
      }
    } else if (pd.options !== undefined && !(Array.isArray(pd.options) && pd.options.every((o) => typeof o === 'string'))) {
      problems.push(`parameter ${label}: options must be a list of strings`)
    }
    if (!isValidParamValue(pd as unknown as ParamDef, pd.default)) {
      problems.push(`parameter ${label}: default must be ${pd.type === 'number' ? 'a number' : pd.type === 'boolean' ? 'true or false' : 'one of the options'}`)
    }
  })
  return problems
}
