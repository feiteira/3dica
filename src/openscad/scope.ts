// Scopes of the OpenSCAD interpreter. Every scope has a lexical parent (normal variables, functions, modules) and a
// dynamic parent, the scope it was entered from: $-variables are looked up along the dynamic chain, which is how
// $fn reaches a module's children.
import type { FileUnit, Plan } from './plan'
import type { Value } from './values'

export const NOT_FOUND = Symbol('not found')

/** the children of a user module instantiation, and the scope they were written in */
export interface ChildInfo { plan: Plan; scope: Scope }

/**
 * A scope's variables. Most scopes hold one or two names (a function's parameters, a loop variable), so they live in
 * two small arrays and move to a Map past 8 names; that keeps calls cheap for the garbage collector. Never a plain
 * object, so names like __proto__ or constructor are ordinary names.
 */
export class Vars {
  /** whether any $-variable lives here (scopes without one can be skipped on the dynamic chain) */
  hasDollar = false
  private keys: string[] | null = null
  private vals: Value[] | null = null
  private map: Map<string, Value> | null = null

  find(name: string): Value | typeof NOT_FOUND {
    const m = this.map
    if (m) { const v = m.get(name); return v !== undefined || m.has(name) ? v : NOT_FOUND }
    const k = this.keys
    if (k) for (let i = 0; i < k.length; i++) if (k[i] === name) return this.vals![i]
    return NOT_FOUND
  }

  has(name: string): boolean { return this.find(name) !== NOT_FOUND }

  get(name: string): Value { const v = this.find(name); return v === NOT_FOUND ? undefined : v }

  set(name: string, v: Value) {
    if (name.charCodeAt(0) === 36) this.hasDollar = true
    if (this.map) { this.map.set(name, v); return }
    const k = this.keys
    if (!k) { this.keys = [name]; this.vals = [v]; return }
    for (let i = 0; i < k.length; i++) if (k[i] === name) { this.vals![i] = v; return }
    if (k.length < 8) { k.push(name); this.vals!.push(v); return }
    this.map = new Map(k.map((n, i) => [n, this.vals![i]]))
    this.map.set(name, v)
    this.keys = this.vals = null
  }

  forEach(fn: (v: Value, k: string) => void) {
    if (this.map) { this.map.forEach(fn); return }
    if (this.keys) for (let i = 0; i < this.keys.length; i++) fn(this.vals![i], this.keys[i])
  }
}

export class Scope {
  readonly vars = new Vars()
  readonly parent: Scope | null
  readonly dyn: Scope | null
  /** the statement list whose functions and modules this scope defines */
  readonly plan: Plan | null
  /** set on the top-level scope of a file: its `use`d libraries */
  readonly unit: FileUnit | null
  /** set on a user module call: the instantiation's children */
  readonly children: ChildInfo | null
  constructor(parent: Scope | null, dyn: Scope | null, plan: Plan | null = null, unit: FileUnit | null = null, children: ChildInfo | null = null) {
    this.parent = parent
    this.dyn = dyn
    this.plan = plan
    this.unit = unit
    this.children = children
  }
}

/**
 * The dynamic parent for a new call scope: scopes without $-variables are skipped (lookups would pass through them
 * anyway). This keeps a long tail recursion from chaining every iteration's scope to the previous one.
 */
export function dynBase(s: Scope): Scope {
  while (!s.vars.hasDollar && s.dyn) s = s.dyn
  return s
}
