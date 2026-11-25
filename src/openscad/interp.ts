// The OpenSCAD interpreter: runs a parsed program with OpenSCAD 2021.01 semantics and returns the CSG tree.
//
// Within one statement list all assignments run before any instantiation, and a variable assigned twice takes the
// last value at the place of the first (see plan.ts). $-variables are dynamically scoped (see scope.ts). Function
// defaults are evaluated in the defining scope and cannot see the other parameters, as in OpenSCAD.
//
// Expressions are compiled once into small JS closures (no source text is ever turned into code: the closures are
// fixed functions of this file, parameterized by the syntax tree). Small closures keep each OpenSCAD call to a few
// small JS stack frames: non-tail recursion reaches roughly a thousand levels in a browser worker (the JS stack is
// the limit), and calls in tail position (through ?:, let, assert and echo) run in a loop without growing the
// stack at all, as in OpenSCAD.
//
// Safety: names live in Maps or compared arrays, never plain objects, so __proto__ or constructor are ordinary
// names. Limits stop deep recursion, huge lists and strings (ScadError 'limit'); a JS stack overflow is reported as
// recursion instead of crashing the worker.
import type { Arg, Elem, Expr, Param, Stmt } from './ast'
import { BUILTIN_FUNCTIONS, type BuiltinCtx } from './builtins'
import { overrideValues } from './customizer'
import { exprToString, limitedString, shortText, shortValue, valueToString } from './format'
import { BUILTIN_MODULES, type BuiltinModule } from './modules'
import { loadProgram, type FileUnit, type Plan, type Program } from './plan'
import { dynBase, NOT_FOUND, Scope, type ChildInfo } from './scope'
import { Mt19937 } from './rng'
import {
  ScadError, type GeomNode, type Interpret, type InterpretLimits, type InterpretOptions, type InterpretResult, type ScadMessage, type SourcePos,
} from './types'
import {
  addSub, chars, compare, divide, equal, modulo, multiply, negate, power, rangeCount, ScadFunc, ScadRange, truthy, typeName, type Value,
} from './values'
import type { ParamValue } from '../core/types'

/** Defaults: generous for real models (the MCAD library, OpenSCAD's examples) and well below what exhausts a tab. */
export const DEFAULT_LIMITS: InterpretLimits = {
  // OpenSCAD 2021.01 itself stops near 9000 nested function calls and 3500 nested modules; tail calls never count
  maxCallDepth: 5000,
  // OpenSCAD refuses for-loops over ranges of 1 000 000 or more values; lists are held to the same size
  maxListLength: 1_000_000,
  // the largest real models seen (MCAD gears, OpenSCAD's examples) create under 300 000; 20 million values is
  // about 160 MB at worst. Each list counts 4 more (its own overhead) and each geometry node 16 (measured: about
  // 140 bytes per node).
  maxTotalElements: 20_000_000,
  maxStringLength: 1_000_000,
  // the busiest real models (MCAD gears, OpenSCAD's examples) take under 500 000; ten million is a few seconds
  maxSteps: 10_000_000,
}

/** Console lines kept per evaluation (more are counted, not stored: a loop of echo() must not fill the memory). */
export const MAX_MESSAGES = 10_000

/** OpenSCAD's own limit for `for` over a range: larger ranges are skipped with a warning. */
const OPENSCAD_MAX_RANGE = 1_000_000
const NODE_WEIGHT = 16
/** what a list costs beyond its elements (a small list is mostly overhead) */
const LIST_WEIGHT = 4

type Code = (s: Scope) => Value
type TailCode = (s: Scope) => Value | TailCall
type ElemCode = (s: Scope, out: Value[]) => void
interface CArg { name?: string; code: Code; expr: Expr; pos: SourcePos }

type FuncStmt = Extract<Stmt, { t: 'function' }>
type ModStmt = Extract<Stmt, { t: 'module' }>
type InstStmt = Extract<Stmt, { t: 'inst' }>

/**
 * A tail call handed back to the call loop instead of growing the JS stack. The loop reads it before anything else
 * runs, so one instance per interpreter is reused (no garbage per iteration).
 */
class TailCall {
  fn!: ScadFunc
  args!: CArg[]
  scope!: Scope
  pos!: SourcePos
  set(fn: ScadFunc, args: CArg[], scope: Scope, pos: SourcePos): TailCall {
    this.fn = fn
    this.args = args
    this.scope = scope
    this.pos = pos
    return this
  }
}

/** a definition found by name, with the scope it closes over and, for a used file, that file's scope */
interface Found<D> { def: D; closure: Scope; dyn: Scope | null }

const isStackOverflow = (e: unknown) => e instanceof RangeError && /call stack|too much recursion/i.test(e.message)
const isDollar = (name: string) => name.charCodeAt(0) === 36

class BuiltinCall implements BuiltinCtx {
  readonly name: string
  readonly args: Arg[]
  readonly pos: SourcePos
  private readonly I: Interpreter
  private readonly scope: Scope
  constructor(I: Interpreter, name: string, args: Arg[], pos: SourcePos, scope: Scope) {
    this.I = I
    this.name = name
    this.args = args
    this.pos = pos
    this.scope = scope
  }
  eval(e: Expr) { return this.I.code(e)(this.scope) }
  warn(text: string) { this.I.warn(text, this.pos) }
  error(kind: ScadError['kind'], msg: string) { return this.I.error(kind, msg, this.pos) }
  list(v: Value[]) { return this.I.list(v, this.pos) }
  str(s: string) { return this.I.checkString(s, this.pos) }
  checkList(n: number) { this.I.checkList(n, this.pos) }
  maxString() { return this.I.limits.maxStringLength }
  steps(n: number) { this.I.step(this.pos, n) }
  random() { return this.I.rng.real() }
  parentModule(n: number) { return this.I.parentModule(n, this.pos) }
  isUndefVar(name: string) { const v = this.I.find(name, this.scope); return v === undefined || v === NOT_FOUND }
}

export class Interpreter {
  readonly messages: ScadMessage[] = []
  readonly limits: InterpretLimits
  readonly rng: Mt19937
  private readonly opts: InterpretOptions
  private program!: Program
  private readonly builtinScope: Scope
  private depth = 0
  private readonly stack: { name: string; kind: 'function' | 'module'; pos: SourcePos }[] = []
  private readonly moduleStack: string[] = []
  private total = 0
  private steps = 0
  private nodes = 0
  private dropped = 0
  private root: GeomNode | null = null
  private rootSet = false
  /** an outer ! is being evaluated: it is the root, an inner ! is the second one (OpenSCAD keeps source order) */
  private rootPending = false
  private rootStmt: Stmt | null = null
  private readonly deprecations = new Set<string>()
  private readonly warnedStmts = new WeakSet<Stmt>()
  private overrides = new Map<string, Value>()
  private readonly codes = new WeakMap<Expr, Code>()
  private readonly tails = new WeakMap<Expr, TailCode>()
  private readonly elems = new WeakMap<Elem, ElemCode>()
  private readonly cargs = new WeakMap<Arg[], CArg[]>()
  private readonly tc = new TailCall()

  constructor(opts: InterpretOptions = {}) {
    this.opts = opts
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) }
    this.builtinScope = new Scope(null, null)
    const b = this.builtinScope.vars
    b.set('PI', Math.PI)
    b.set('$fn', 0)
    b.set('$fa', 12)
    b.set('$fs', 2)
    b.set('$t', 0)
    b.set('$preview', opts.preview ?? true)
    b.set('$vpr', [55, 0, 25])
    b.set('$vpt', [0, 0, 0])
    b.set('$vpd', 140)
    b.set('$vpf', 22.5)
    this.rng = new Mt19937((opts.randomSeed ?? 0) >>> 0)
  }

  run(source: string): InterpretResult {
    try {
      this.program = loadProgram(source, this.opts.files ?? {}, (text, pos) => this.warn(text, pos))
      if (this.opts.overrides) this.overrides = overrideValues(source, this.opts.overrides)
      const main = this.program.main
      const scope = new Scope(this.builtinScope, this.builtinScope, main.plan, main)
      const nodes = this.evalPlan(main.plan, scope, true)
      this.noteDropped()
      return { nodes: this.rootSet ? (this.root ? [this.root] : []) : nodes, messages: this.messages }
    } catch (e) {
      this.noteDropped()
      let err = e
      if (isStackOverflow(e)) {
        // the JS stack ran out before maxCallDepth: report it the way OpenSCAD reports deep recursion; with no call
        // on the stack it was data nested too deeply (a list in a list in a list … built by a tail-recursive function)
        const top = this.stack[this.stack.length - 1]
        err = top
          ? this.tooDeep(top.kind, top.name.slice(0, -2), top.pos)
          : this.error('limit', 'Values or expressions nested too deeply (thousands of levels: lists inside lists, or a very long chain of operators)')
      } else if (e instanceof RangeError) {
        // the JS engine's own size limits (array or string length): report them as a limit, never as a crash
        err = this.error('limit', `The model needs more memory than this page can give (${e.message})`)
      }
      if (err instanceof ScadError) err.messages = this.messages
      throw err
    }
  }

  // ───── messages, errors, limits ─────

  warn(text: string, pos?: SourcePos) {
    this.say(pos ? { level: 'warning', text, pos } : { level: 'warning', text })
  }

  private say(m: ScadMessage) {
    if (this.messages.length < MAX_MESSAGES) this.messages.push(m)
    else this.dropped++
  }

  private noteDropped() {
    if (this.dropped) this.messages.push({ level: 'warning', text: `${this.dropped.toLocaleString('en-US')} more console lines were not kept (the limit is ${MAX_MESSAGES.toLocaleString('en-US')})` })
    this.dropped = 0
  }

  /** one function or module call or loop round (`n` for work done in one go, like a big search()) */
  step(pos?: SourcePos, n = 1) {
    this.steps += n
    if (this.steps > this.limits.maxSteps) {
      throw this.error('limit', `The code ran too long (more than ${this.limits.maxSteps.toLocaleString('en-US')} function calls and loop rounds) — a loop or recursion that never ends?`, pos)
    }
  }

  /** a deprecation notice: once per evaluation, without a location, as OpenSCAD prints them */
  deprecated(text: string) {
    if (this.deprecations.has(text)) return
    this.deprecations.add(text)
    this.warn(text)
  }

  error(kind: ScadError['kind'], msg: string, pos?: SourcePos): ScadError {
    const s = this.stack
    const fmt = (c: { name: string; pos: SourcePos }) => `${c.name} at line ${c.pos.line}${c.pos.file ? ` of ${c.pos.file}` : ''}`
    const trace = s.length <= 20 ? s.map(fmt) : [...s.slice(0, 10).map(fmt), `… ${s.length - 20} more …`, ...s.slice(-10).map(fmt)]
    return new ScadError(kind, msg, pos, trace)
  }

  /**
   * Recursion deeper than this page can run (the JS stack, or maxCallDepth). It may well end (a sum over a long list),
   * so it is not called endless as OpenSCAD's "Recursion detected" would: the text says how deep it got and what to do.
   */
  tooDeep(kind: 'function' | 'module', name: string, pos?: SourcePos): ScadError {
    const theirs = kind === 'function' ? '9,000' : '3,500'
    const fix = kind === 'function' ? 'rewrite it with tail recursion or a list comprehension' : 'nest fewer levels (a for loop instead of recursion)'
    return this.error('runtime', `Recursion too deep calling ${kind} '${name}' (${this.depth.toLocaleString('en-US')} nested calls, as deep as this page can go; OpenSCAD allows about ${theirs}) — if it ends, ${fix}`, pos)
  }

  /** count `n` created list elements / characters against the evaluation's budget */
  charge(n: number, pos?: SourcePos) {
    this.total += n
    if (this.total > this.limits.maxTotalElements) {
      // mostly shapes and transforms (a huge loop of cubes): say so in the words of the geometry budget
      if (this.nodes * NODE_WEIGHT * 2 > this.total) {
        throw this.error('limit', `Too much geometry: this code made ${this.nodes.toLocaleString('en-US')} shapes and transforms — stopped before the page runs out of memory`, pos)
      }
      throw this.error('limit', `The model creates too much data (more than ${this.limits.maxTotalElements.toLocaleString('en-US')} list elements and characters)`, pos)
    }
  }

  /** a new geometry node: it counts against the same budget (it holds memory until the build) */
  private chargeNode(pos?: SourcePos) {
    this.nodes++
    this.charge(NODE_WEIGHT, pos)
  }

  checkList(n: number, pos?: SourcePos) {
    if (n > this.limits.maxListLength) throw this.error('limit', `List too long (more than ${this.limits.maxListLength.toLocaleString('en-US')} elements)`, pos)
  }

  checkString(s: string, pos?: SourcePos): string {
    if (s.length > this.limits.maxStringLength) throw this.error('limit', `String too long (more than ${this.limits.maxStringLength.toLocaleString('en-US')} characters)`, pos)
    this.charge(s.length, pos)
    return s
  }

  /** a newly built list: length limit + budget */
  list(v: Value[], pos?: SourcePos): Value[] {
    this.checkList(v.length, pos)
    this.charge(v.length + LIST_WEIGHT, pos)
    return v
  }

  /**
   * An element-wise operator on lists (+, -, unary -, a number times or over a list): the result is charged BEFORE it
   * is built. Shared sub-lists make a small list stand for a huge one (c = [for (i = [0:999]) b] is a thousand
   * references to b), and c + c would allocate all of it before an after-the-fact count could stop it. `operands`
   * bound the result's size (it is never larger than the smallest); the charge is settled to the exact size after.
   */
  private elementwise(operands: Value[][], pos: SourcePos, run: () => Value): Value {
    const cap = this.limits.maxTotalElements - this.total + 1
    let est = Infinity
    for (const x of operands) est = Math.min(est, cappedCount(x, cap))
    this.charge(est, pos)
    const v = run()
    if (Array.isArray(v)) {
      this.checkList(v.length, pos)
      this.total -= est - deepCount(v)
    } else this.total -= est
    return v
  }

  /** an operator result: vectors count against the budget (all levels) */
  private counted(v: Value, pos: SourcePos): Value {
    if (Array.isArray(v)) {
      this.checkList(v.length, pos)
      this.charge(deepCount(v), pos)
    }
    return v
  }

  // ───── lookup ─────

  /** a variable's value, or NOT_FOUND */
  find(name: string, scope: Scope): Value | typeof NOT_FOUND {
    // $children and $parent_modules belong to the module body they are written in (lexical), not to its callees
    if (isDollar(name) && name !== '$children' && name !== '$parent_modules') {
      for (let s: Scope | null = scope; s; s = s.dyn) { const v = s.vars.find(name); if (v !== NOT_FOUND) return v }
    } else {
      for (let s: Scope | null = scope; s; s = s.parent) { const v = s.vars.find(name); if (v !== NOT_FOUND) return v }
    }
    return NOT_FOUND
  }

  lookupVar(name: string, scope: Scope, pos: SourcePos): Value {
    const v = this.find(name, scope)
    if (v !== NOT_FOUND) return v
    this.warn(`Ignoring unknown variable '${name}'`, pos)
    return undefined
  }

  private lookupDef<K extends 'funcs' | 'mods'>(kind: K, name: string, scope: Scope): Found<K extends 'funcs' ? FuncStmt : ModStmt> | null {
    for (let s: Scope | null = scope; s; s = s.parent) {
      const d = s.plan?.[kind].get(name)
      if (d) return { def: d as never, closure: s, dyn: null }
      const uses = s.unit?.uses
      if (uses) {
        for (let i = uses.length - 1; i >= 0; i--) {
          const lib = uses[i]
          const ld = lib.plan[kind].get(name)
          if (ld) {
            // a call into a used file sets up that file's top level again, as OpenSCAD does
            const fs = this.fileScope(lib, scope)
            return { def: ld as never, closure: fs, dyn: fs }
          }
        }
      }
    }
    return null
  }

  private fileScope(unit: FileUnit, caller: Scope): Scope {
    const s = new Scope(this.builtinScope, caller, unit.plan, unit)
    this.runAssignments(unit.plan, s, false)
    return s
  }

  // ───── statements ─────

  private runAssignments(plan: Plan, scope: Scope, top: boolean) {
    for (const a of plan.assigns) {
      if (top && a.pos.file === '' && this.overrides.has(a.name)) { scope.vars.set(a.name, this.overrides.get(a.name)); continue }
      scope.vars.set(a.name, this.code(a.expr)(scope))
    }
  }

  /** run a statement list in `scope`: assignments first, then the instantiations in order */
  evalPlan(plan: Plan, scope: Scope, top = false): GeomNode[] {
    if (plan.assigns.length) this.runAssignments(plan, scope, top)
    const out: GeomNode[] = []
    for (const s of plan.insts) {
      const n = this.evalInst(s, scope)
      if (n) out.push(n)
    }
    return out
  }

  private group(children: GeomNode[], pos: SourcePos): GeomNode {
    this.chargeNode(pos)
    return { kind: 'group', children, pos }
  }

  /**
   * One instantiation (or if). The if branch and the module lookup are written out here instead of in helpers: every
   * JS frame saved on this path is another level of module recursion before the stack runs out.
   */
  private evalInst(s: Stmt, scope: Scope): GeomNode | null {
    let node: GeomNode | null
    // the first ! in source order is the root: claimed before the statement runs, so a ! inside it comes second
    const claim = !this.rootSet && !this.rootPending && (s.t === 'inst' || s.t === 'if') && s.mods.includes('!')
    if (claim) this.rootPending = true
    if (s.t === 'if') {
      const branch = truthy(this.code(s.cond)(scope)) ? s.then : s.else
      if (branch) {
        const plan = this.program.planOf(branch)
        node = this.group(this.evalPlan(plan, new Scope(scope, scope, plan)), s.pos)
      } else node = null
    } else if (s.t === 'inst') {
      // keywords first, then the program's modules (a module named like a built-in wins), then the built-ins
      const name = s.name
      const control = CONTROL.get(name)
      const user = control ? null : this.lookupDef('mods', name, scope)
      const special = control || user ? undefined : SPECIAL.get(name)
      const builtin = control || user || special ? undefined : BUILTIN_MODULES.get(name)
      if (control) node = control(this, s, scope)
      else if (user) node = this.callModule(user, s, scope)
      else if (special) node = special(this, s, scope)
      else if (builtin) node = this.callBuiltinModule(builtin, s, scope)
      else {
        this.warn(`Ignoring unknown module '${name}'`, s.pos)
        node = null
      }
    } else return null
    if (claim) this.rootPending = false
    const mods = s.mods
    if (!mods) return node
    if (mods.includes('!') && node) {
      // the first ! wins; the same statement running again (a module called twice) is not another root. A ! that
      // made nothing (!echo()) claims nothing, as in OpenSCAD.
      if (claim) { this.rootSet = true; this.root = node; this.rootStmt = s }
      else if (s !== this.rootStmt) this.warn('More than one Root Modifier (!)', s.pos)
    }
    return mods.includes('%') ? null : node
  }

  /** the children of a control module (for, let, echo, …) in a new scope */
  private evalChildren(list: Stmt[], scope: Scope): GeomNode[] {
    const plan = this.program.planOf(list)
    return this.evalPlan(plan, new Scope(scope, scope, plan))
  }

  evalFor(s: InstStmt, scope: Scope): GeomNode {
    const out: GeomNode[] = []
    // for () with no loop variable runs no rounds (the [for () x] comprehension runs one)
    if (s.args.length) this.loop(this.compiledArgs(s.args), 0, scope, (sc) => { for (const n of this.evalChildren(s.children, sc)) out.push(n) })
    return this.group(out, s.pos)
  }

  evalIntersectionFor(s: InstStmt, scope: Scope): GeomNode {
    const out: GeomNode[] = []
    if (s.args.length) this.loop(this.compiledArgs(s.args), 0, scope, (sc) => {
      // every statement of every round is an operand of its own (OpenSCAD's CSG tree lists them all directly
      // under the intersection); a statement that is itself a group (if, for, a module call) stays one operand
      for (const n of this.evalChildren(s.children, sc)) out.push(n)
    })
    this.chargeNode(s.pos)
    return { kind: 'intersection', children: out, pos: s.pos }
  }

  evalLetStmt(s: InstStmt, scope: Scope): GeomNode {
    return this.group(this.evalChildren(s.children, this.letScope(this.compiledArgs(s.args), scope, s.pos)), s.pos)
  }

  evalEchoStmt(s: InstStmt, scope: Scope): GeomNode | null {
    this.echo(this.compiledArgs(s.args), scope, s.pos)
    return s.children.length ? this.group(this.evalChildren(s.children, scope), s.pos) : null
  }

  evalAssertStmt(s: InstStmt, scope: Scope): GeomNode | null {
    this.assert(this.compiledArgs(s.args), scope, s.pos)
    return s.children.length ? this.group(this.evalChildren(s.children, scope), s.pos) : null
  }

  evalAssign(s: InstStmt, scope: Scope): GeomNode {
    // printed once per assign() statement, like OpenSCAD
    if (!this.warnedStmts.has(s)) {
      this.warnedStmts.add(s)
      this.warn('The assign() module will be removed in future releases. Use a regular assignment instead.', s.pos)
    }
    const sc = new Scope(scope, scope)
    for (const a of this.compiledArgs(s.args)) if (a.name) sc.vars.set(a.name, a.code(scope))
    return this.group(this.evalChildren(s.children, sc), s.pos)
  }

  private callBuiltinModule(builtin: BuiltinModule, s: InstStmt, scope: Scope): GeomNode | null {
    const { values, dollars } = this.bindBuiltin(builtin.params, builtin.named ?? [], s.args, scope, s.pos)
    // primitives ignore their children (without running them), as OpenSCAD does
    if (builtin.leaf === 'warn' && s.children.length) this.warn(`module ${s.name}() does not support child modules`, s.pos)
    // $-arguments ($fn = 30) apply to the module itself and to its children
    let childScope = scope
    if (dollars.size) {
      childScope = new Scope(scope, scope)
      for (const [k, v] of dollars) childScope.vars.set(k, v)
    }
    const node = builtin.run({
      args: values,
      pos: s.pos,
      special: (n) => { const v = this.find(n, childScope); return v === NOT_FOUND ? undefined : v },
      warn: (t, noPos) => this.warn(t, noPos ? undefined : s.pos),
      deprecated: (t) => this.deprecated(t),
      error: (kind, msg) => this.error(kind, msg, s.pos),
      children: () => { const plan = this.program.planOf(s.children); return this.evalPlan(plan, new Scope(childScope, childScope, plan)) },
    })
    if (node) this.chargeNode(s.pos)
    return node
  }

  /** part("Name", width = 20): another 3Dica definition, with parameter overrides from the named arguments */
  evalPart(s: InstStmt, scope: Scope): GeomNode {
    let name: Value
    const overrides: Record<string, ParamValue> = {}
    for (const a of this.compiledArgs(s.args)) {
      const v = a.code(scope)
      if (!a.name || a.name === 'name') {
        if (name === undefined) name = v
        continue
      }
      if (isDollar(a.name)) continue
      if (typeof v !== 'number' && typeof v !== 'boolean' && typeof v !== 'string') {
        throw this.error('runtime', `part(): parameter '${a.name}' must be a number, true/false or a string, not ${shortValue(v)}`, a.pos)
      }
      Object.defineProperty(overrides, a.name, { value: v, enumerable: true, writable: true, configurable: true })
    }
    if (typeof name !== 'string' || !name) throw this.error('runtime', 'part() needs the name of a 3Dica object as its first argument, e.g. part("Bracket")', s.pos)
    this.chargeNode(s.pos)
    return { kind: 'part', name, overrides, pos: s.pos }
  }

  evalChildrenCall(s: InstStmt, scope: Scope): GeomNode | null {
    // child(i) is the old children(i): child() means child(0), and its messages differ a little
    const old = s.name === 'child'
    if (old) this.deprecated('child() will be removed in future releases. Use children() instead.')
    let info: ChildInfo | null = null
    for (let sc: Scope | null = scope; sc; sc = sc.parent) if (sc.children) { info = sc.children; break }
    if (!info) return null   // children() outside a module: nothing, as in OpenSCAD
    const all = info.plan.insts
    let pick: number[]
    let single = false
    if (!s.args.length && !old) pick = all.map((_, i) => i)
    else {
      const v = s.args.length ? this.code(s.args[0].expr)(scope) : 0
      single = typeof v === 'number'
      pick = []
      const add = (x: Value) => {
        if (typeof x !== 'number') return
        const i = Math.trunc(x)
        if (i < 0) this.warn(`Negative children index (${formatInt(i)}) not allowed`)
        else if (i >= all.length || !Number.isFinite(x)) {
          if (old) this.warn(`Child index (${formatInt(i)}) out of bounds (${all.length} children)`, s.pos)
          else this.warn(`Children index (${formatInt(i)}) out of bounds (${all.length} children)`)
        } else pick.push(i)
      }
      if (typeof v === 'number') add(v)
      else if (Array.isArray(v)) v.forEach(add)
      else if (v instanceof ScadRange) this.forEachValue(v, s.pos, add)
      else this.warn(`Bad parameter type (${shortValue(v)}) for children, only accept: empty, number, vector, range`, s.pos)
    }
    // the children run where the instantiation was written (their own assignments already ran there),
    // with $-variables seen from here
    const sc = new Scope(info.scope, scope)
    const out: GeomNode[] = []
    for (const i of pick) {
      const n = this.evalInst(all[i], sc)
      if (n) out.push(n)
    }
    // children(i) is that child itself; children(), children([…]) and children(range) are a group
    return single ? out[0] ?? null : this.group(out, s.pos)
  }

  private callModule(user: Found<ModStmt>, s: InstStmt, caller: Scope): GeomNode {
    const def = user.def
    if (++this.depth > this.limits.maxCallDepth) throw this.tooDeep('module', def.name, s.pos)
    this.step(s.pos)
    // the children's own assignments run once, at the instantiation, before the arguments
    const childPlan = this.program.planOf(s.children)
    const block = new Scope(caller, caller, childPlan)
    if (childPlan.assigns.length) this.runAssignments(childPlan, block, false)
    const plan = this.program.planOf(def.body)
    const sc = new Scope(user.closure, user.dyn ?? block, plan, null, { plan: childPlan, scope: block })
    this.bindUser(def.params, this.compiledArgs(s.args), user.closure, caller, sc, s.pos)
    sc.vars.set('$children', childPlan.insts.length)
    this.moduleStack.push(def.name)
    sc.vars.set('$parent_modules', this.moduleStack.length)
    this.stack.push({ name: `${def.name}()`, kind: 'module', pos: s.pos })
    const nodes = this.evalPlan(plan, sc)
    this.stack.pop()
    this.moduleStack.pop()
    this.depth--
    return this.group(nodes, s.pos)
  }

  /** `parent_module(n)`: the name of the n-th user module up the instantiation stack */
  parentModule(n: number, pos: SourcePos): Value {
    const k = Math.trunc(n)
    if (k < 0) { this.warn(`Negative parent module index (${formatInt(k)}) not allowed`, pos); return undefined }
    if (k >= this.moduleStack.length || !Number.isFinite(n)) {
      this.warn(`Parent module index (${formatInt(k)}) greater than the number of modules on the stack`, pos)
      return undefined
    }
    return this.moduleStack[this.moduleStack.length - 1 - k]
  }

  /**
   * Bind arguments to a user module's or function's parameters, the way OpenSCAD does: every default is evaluated
   * first (in the defining scope), then the named arguments, then the positional ones.
   */
  private bindUser(params: Param[], args: CArg[], closure: Scope, caller: Scope, into: Scope, pos: SourcePos) {
    if (params.length) {
      let defScope: Scope | null = null
      for (const p of params) {
        const d = p.def
        if (!d) into.vars.set(p.name, undefined)
        // a literal default needs no scope (the common `acc = 0` of a tail-recursive function)
        else if (d.t === 'num' || d.t === 'str' || d.t === 'bool') into.vars.set(p.name, d.v)
        else into.vars.set(p.name, this.code(d)(defScope ??= new Scope(closure, caller)))
      }
    }
    let named: Set<string> | null = null
    for (const a of args) {
      if (!a.name) continue
      const isParam = params.some((p) => p.name === a.name)
      if (!isParam && !isDollar(a.name)) this.warn(`variable ${a.name} not specified as parameter`, pos)
      if (named?.has(a.name)) this.warn(`argument ${a.name} supplied more than once`, pos)
      // OpenSCAD 2021.01 warns about an unknown name but still binds it for the call (old code overrides a global
      // per call this way: plate(size = 5))
      into.vars.set(a.name, a.code(caller))
      ;(named ??= new Set()).add(a.name)
    }
    let k = 0
    let tooMany = false
    for (const a of args) {
      if (a.name) continue
      const p = params[k++]
      const v = a.code(caller)
      if (!p) { if (!tooMany) { tooMany = true; this.warn('Too many unnamed arguments supplied', pos) } continue }
      if (named?.has(p.name)) { this.warn(`argument ${p.name} supplied more than once`, pos); continue }
      into.vars.set(p.name, v)
    }
  }

  /** argument matching for built-in modules: positional `params`, plus names that are only accepted by name */
  private bindBuiltin(params: string[], named: string[], args: Arg[], scope: Scope, pos: SourcePos): { values: Map<string, Value>; dollars: Map<string, Value> } {
    const values = new Map<string, Value>()
    const dollars = new Map<string, Value>()
    let k = 0
    let tooMany = false
    for (const a of this.compiledArgs(args)) {
      const v = a.code(scope)
      if (a.name) {
        if (isDollar(a.name)) dollars.set(a.name, v)
        else if (params.includes(a.name) || named.includes(a.name)) {
          if (values.has(a.name)) this.warn(`argument ${a.name} supplied more than once`, pos)
          values.set(a.name, v)
        } else this.warn(`variable ${a.name} not specified as parameter`, pos)
      } else {
        const p = params[k++]
        if (!p) { if (!tooMany) { tooMany = true; this.warn('Too many unnamed arguments supplied', pos) } continue }
        if (values.has(p)) { this.warn(`argument ${p} supplied more than once`, pos); continue }
        values.set(p, v)
      }
    }
    return { values, dollars }
  }

  private echo(args: CArg[], scope: Scope, pos: SourcePos) {
    // a huge echo is shortened rather than stopping the model: it is only console output
    const max = this.limits.maxStringLength
    let text = ''
    for (let i = 0; i < args.length && text.length <= max; i++) {
      const a = args[i]
      text += (i ? ', ' : '') + (a.name ? `${a.name} = ` : '') + limitedString(a.code(scope), true, max - text.length + 1).text
    }
    if (text.length > max) text = text.slice(0, max) + ' … (cut: too long to show)'
    this.charge(text.length, pos)
    this.say({ level: 'echo', text, pos })
  }

  private assert(args: CArg[], scope: Scope, pos: SourcePos) {
    const cond = args.find((a) => a.name === 'condition') ?? args.find((a) => !a.name)
    const msgArg = args.find((a) => a.name === 'message') ?? args.filter((a) => !a.name)[1]
    if (!cond) throw this.error('runtime', 'Assertion failed: assert() needs a condition', pos)
    if (truthy(cond.code(scope))) return
    const m = msgArg ? msgArg.code(scope) : undefined
    // an undef message prints nothing, as in OpenSCAD; a huge one is shortened (it ends up in the page and the AI chat)
    const msg = m === undefined ? '' : `: ${shortValue(m)}`
    throw this.error('runtime', `Assertion '${shortText(exprToString(cond.expr))}' failed${msg}`, pos)
  }

  /** let(a = 1, b = a + 1): sequential; a repeated name keeps its first value, with OpenSCAD's warning */
  private letScope(args: CArg[], scope: Scope, pos: SourcePos): Scope {
    const sc = new Scope(scope, scope)
    for (const a of args) {
      if (!a.name) { this.warn(`Assignment without variable name ${shortText(exprToString(a.expr))}`, pos); continue }
      if (sc.vars.has(a.name)) { this.warn(`Ignoring duplicate variable assignment ${a.name} = ${shortText(exprToString(a.expr))}`, pos); continue }
      sc.vars.set(a.name, a.code(sc))
    }
    return sc
  }

  // ───── loops ─────

  /** iterate a for-loop value: ranges, vectors and strings element by element; any other defined value once */
  forEachValue(v: Value, pos: SourcePos, fn: (x: Value) => void) {
    if (v === undefined) return
    if (v instanceof ScadRange) {
      const n = rangeCount(v)
      if (n >= OPENSCAD_MAX_RANGE) {
        this.warn(`Bad range parameter in for statement: too many elements (${Math.min(n, 4294967295)})`, pos)
        return
      }
      this.checkList(n, pos)
      for (let i = 0; i < n; i++) fn(v.begin + i * v.step)
      return
    }
    if (Array.isArray(v)) { for (const x of v) fn(x); return }
    if (typeof v === 'string') { for (const c of chars(v)) fn(c); return }
    fn(v)
  }

  /** nested loops over `args` (for (i = …, j = …) is a loop in a loop); each iteration gets its own scope */
  private loop(args: CArg[], i: number, scope: Scope, body: (s: Scope) => void) {
    if (i === args.length) { this.step(args[0]?.pos); body(scope); return }
    const a = args[i]
    // a value without a name is still iterated, without a variable: for ([1, 2]) runs twice
    if (!a.name) { this.forEachValue(a.code(scope), a.pos, () => this.loop(args, i + 1, scope, body)); return }
    const v = a.code(scope)
    this.forEachValue(v, a.pos, (x) => {
      const sc = new Scope(scope, scope)
      sc.vars.set(a.name!, x)
      this.loop(args, i + 1, sc, body)
    })
  }

  // ───── expressions: compiled to closures ─────

  compiledArgs(args: Arg[]): CArg[] {
    let c = this.cargs.get(args)
    if (!c) {
      c = args.map((a) => ({ name: a.name, code: this.code(a.expr), expr: a.expr, pos: a.pos }))
      this.cargs.set(args, c)
    }
    return c
  }

  code(e: Expr): Code {
    let c = this.codes.get(e)
    if (!c) {
      c = this.compile(e)
      this.codes.set(e, c)
    }
    return c
  }

  private compile(e: Expr): Code {
    const pos = e.pos
    switch (e.t) {
      case 'num':
      case 'str':
      case 'bool': { const v = e.v; return () => v }
      case 'undef': return () => undefined
      case 'var': { const name = e.name; return (s) => this.lookupVar(name, s, pos) }
      case 'list': return this.compileList(e.items, pos)
      case 'range': {
        const b = this.code(e.begin)
        const st = e.step ? this.code(e.step) : null
        const en = this.code(e.end)
        return (s) => this.range(b(s), st ? st(s) : 1, en(s), st !== null, pos)
      }
      case 'unary': {
        const x = this.code(e.e)
        if (e.op === '!') return (s) => !truthy(x(s))
        return (s) => {
          const v = x(s)
          if (typeof v === 'number') return -v
          return Array.isArray(v) ? this.elementwise([v], pos, () => negate(v, null)) : negate(v, (t) => this.warn(t, pos))
        }
      }
      case 'binary': return this.compileBinary(e)
      case 'ternary': {
        const c = this.code(e.c), a = this.code(e.a), b = this.code(e.b)
        return (s) => (truthy(c(s)) ? a(s) : b(s))
      }
      case 'index': {
        const x = this.code(e.e), i = this.code(e.i)
        return (s) => index(x(s), i(s))
      }
      case 'member': {
        const x = this.code(e.e)
        const i = e.name === 'x' ? 0 : e.name === 'y' ? 1 : e.name === 'z' ? 2 : -1
        return (s) => { const v = x(s); return Array.isArray(v) && i >= 0 ? v[i] : undefined }
      }
      case 'call': return this.compileCall(e, false) as Code
      case 'func': { const params = e.params, body = e.body; return (s) => new ScadFunc(params, body, s) }
      case 'let': {
        const args = this.compiledArgs(e.args), body = this.code(e.body)
        return (s) => body(this.letScope(args, s, pos))
      }
      case 'echo':
      case 'assert': {
        const args = this.compiledArgs(e.args)
        const body = e.body ? this.code(e.body) : null
        const isEcho = e.t === 'echo'
        return (s) => {
          if (isEcho) this.echo(args, s, pos)
          else this.assert(args, s, pos)
          return body ? body(s) : undefined
        }
      }
    }
  }

  private range(b: Value, st: Value, en: Value, hasStep: boolean, pos: SourcePos): Value {
    if (typeof b !== 'number' || typeof st !== 'number' || typeof en !== 'number') return undefined
    if (!hasStep) {
      if (b > en) {
        this.warn('Using ranges of the form [begin:end] with begin value greater than the end value is deprecated', pos)
        return new ScadRange(en, 1, b)
      }
    } else if (b < en && st < 0) this.warn('begin is smaller than the end, but step is negative', pos)
    else if (b > en && st > 0) this.warn('begin is greater than the end, but step is positive', pos)
    return new ScadRange(b, st, en)
  }

  private compileBinary(e: Extract<Expr, { t: 'binary' }>): Code {
    const l = this.code(e.l), r = this.code(e.r), pos = e.pos
    const w = (t: string) => this.warn(t, pos)
    switch (e.op) {
      case '&&': return (s) => truthy(l(s)) && truthy(r(s))
      case '||': return (s) => truthy(l(s)) || truthy(r(s))
      case '==': return (s) => equal(l(s), r(s))
      case '!=': return (s) => !equal(l(s), r(s))
      case '<': return (s) => { const a = l(s), b = r(s); return typeof a === 'number' && typeof b === 'number' ? a < b : compare(a, b, '<', w) }
      case '<=': return (s) => { const a = l(s), b = r(s); return typeof a === 'number' && typeof b === 'number' ? a <= b : compare(a, b, '<=', w) }
      case '>': return (s) => { const a = l(s), b = r(s); return typeof a === 'number' && typeof b === 'number' ? a > b : compare(a, b, '>', w) }
      case '>=': return (s) => { const a = l(s), b = r(s); return typeof a === 'number' && typeof b === 'number' ? a >= b : compare(a, b, '>=', w) }
      case '+':
      case '-': {
        const op = e.op
        return (s) => {
          const a = l(s), b = r(s)
          if (typeof a === 'number' && typeof b === 'number') return op === '+' ? a + b : a - b
          return Array.isArray(a) && Array.isArray(b) ? this.elementwise([a, b], pos, () => addSub(a, b, op, w)) : addSub(a, b, op, w)
        }
      }
      case '*': return (s) => {
        const a = l(s), b = r(s)
        if (typeof a === 'number' && typeof b === 'number') return a * b
        if (typeof a === 'number' && Array.isArray(b)) return this.elementwise([b], pos, () => multiply(a, b, w))
        if (Array.isArray(a) && typeof b === 'number') return this.elementwise([a], pos, () => multiply(a, b, w))
        // a matrix product does rows × columns × inner work for a result of rows × columns
        if (Array.isArray(a) && Array.isArray(b)) this.step(pos, a.length * b.length * (Array.isArray(b[0]) ? b[0].length : 1) / 16)
        return this.counted(multiply(a, b, w), pos)
      }
      case '/': return (s) => {
        const a = l(s), b = r(s)
        if (typeof a === 'number' && typeof b === 'number') return a / b
        if (typeof a === 'number' && Array.isArray(b)) return this.elementwise([b], pos, () => divide(a, b, w))
        if (Array.isArray(a) && typeof b === 'number') return this.elementwise([a], pos, () => divide(a, b, w))
        return divide(a, b, w)
      }
      case '%': return (s) => modulo(l(s), r(s), w)
      case '^': return (s) => power(l(s), r(s), w)
    }
  }

  private compileList(items: Elem[], pos: SourcePos): Code {
    if (items.every((it) => !it.t.startsWith('lc-'))) {
      const codes = (items as Expr[]).map((it) => this.code(it))
      const n = codes.length
      return (s) => {
        const out: Value[] = new Array(n)
        for (let i = 0; i < n; i++) out[i] = codes[i](s)
        this.charge(n + LIST_WEIGHT, pos)
        return out
      }
    }
    const parts = items.map((it) => this.elem(it))
    return (s) => {
      const out: Value[] = []
      for (const p of parts) p(s, out)
      this.charge(out.length + LIST_WEIGHT, pos)
      return out
    }
  }

  private elem(it: Elem): ElemCode {
    let c = this.elems.get(it)
    if (!c) {
      c = this.compileElem(it)
      this.elems.set(it, c)
    }
    return c
  }

  private compileElem(it: Elem): ElemCode {
    const pos = it.pos
    switch (it.t) {
      case 'lc-for': {
        const args = this.compiledArgs(it.args), body = this.elem(it.body)
        return (s, out) => this.loop(args, 0, s, (sc) => body(sc, out))
      }
      case 'lc-cfor': {
        const init = this.compiledArgs(it.init), cond = this.code(it.cond), update = this.compiledArgs(it.update), body = this.elem(it.body)
        return (s, out) => {
          let sc = new Scope(s, s)
          for (const a of init) if (a.name) sc.vars.set(a.name, a.code(sc))
          while (truthy(cond(sc))) {
            this.step(pos)
            body(sc, out)
            const next = new Scope(s, s)
            sc.vars.forEach((v, k) => next.vars.set(k, v))
            // the updates run in order, each seeing the ones before it (a = b, b = a + b), and may add variables
            for (const a of update) if (a.name) next.vars.set(a.name, a.code(next))
            sc = next
          }
        }
      }
      case 'lc-if': {
        const cond = this.code(it.cond), then = this.elem(it.then), els = it.else ? this.elem(it.else) : null
        return (s, out) => {
          if (truthy(cond(s))) then(s, out)
          else if (els) els(s, out)
        }
      }
      case 'lc-let': {
        const args = this.compiledArgs(it.args), body = this.elem(it.body)
        return (s, out) => body(this.letScope(args, s, pos), out)
      }
      case 'lc-each': {
        const b = it.body
        if (b.t.startsWith('lc-')) {
          const body = this.elem(b)
          return (s, out) => {
            const tmp: Value[] = []
            body(s, tmp)
            for (const v of tmp) this.pushEach(v, pos, out)
          }
        }
        const x = this.code(b as Expr)
        return (s, out) => this.pushEach(x(s), pos, out)
      }
      default: {
        const x = this.code(it)
        const max = this.limits.maxListLength
        return (s, out) => {
          out.push(x(s))
          if (out.length > max) this.checkList(out.length, pos)
        }
      }
    }
  }

  private pushEach(v: Value, pos: SourcePos, out: Value[]) {
    if (v === undefined) return
    if (Array.isArray(v) || v instanceof ScadRange || typeof v === 'string') {
      this.forEachValue(v, pos, (x) => { out.push(x); if (out.length > this.limits.maxListLength) this.checkList(out.length, pos) })
    } else out.push(v)
  }

  // ───── calls ─────

  /** the code of a function body: a call in tail position comes back as a TailCall for the caller's loop */
  private tail(e: Expr): TailCode {
    let c = this.tails.get(e)
    if (!c) {
      c = this.compileTail(e)
      this.tails.set(e, c)
    }
    return c
  }

  private compileTail(e: Expr): TailCode {
    const pos = e.pos
    switch (e.t) {
      case 'ternary': {
        const c = this.code(e.c), a = this.tail(e.a), b = this.tail(e.b)
        return (s) => (truthy(c(s)) ? a(s) : b(s))
      }
      case 'let': {
        const args = this.compiledArgs(e.args), body = this.tail(e.body)
        return (s) => body(this.letScope(args, s, pos))
      }
      case 'echo':
      case 'assert': {
        const args = this.compiledArgs(e.args)
        const body = e.body ? this.tail(e.body) : null
        const isEcho = e.t === 'echo'
        return (s) => {
          if (isEcho) this.echo(args, s, pos)
          else this.assert(args, s, pos)
          return body ? body(s) : undefined
        }
      }
      case 'call': return this.compileCall(e, true)
      default: return this.code(e)
    }
  }

  /**
   * A call. A variable holding a function comes first, then the function namespace (lexical scopes, then used files),
   * then the built-ins. In tail position a user function call comes back as a TailCall.
   */
  private compileCall(e: Extract<Expr, { t: 'call' }>, tail: boolean): TailCode {
    const args = this.compiledArgs(e.args)
    const pos = e.pos
    if (e.callee.t === 'var') {
      const name = e.callee.name
      const builtin = BUILTIN_FUNCTIONS.get(name)
      // the function value of the last call from here, reused while the definition and its scope are the same
      let lastDef: FuncStmt | null = null
      let lastClosure: Scope | null = null
      let lastFn: ScadFunc | null = null
      return (s) => {
        let fn: ScadFunc | null = null
        const v = this.find(name, s)
        if (v instanceof ScadFunc) fn = v
        else {
          const user = this.lookupDef('funcs', name, s)
          if (user) {
            if (user.def === lastDef && user.closure === lastClosure && !user.dyn) fn = lastFn
            else {
              fn = new ScadFunc(user.def.params, user.def.body, user.closure, name, user.dyn)
              if (!user.dyn) { lastDef = user.def; lastClosure = user.closure; lastFn = fn }
            }
          }
        }
        if (fn) return tail ? this.tc.set(fn, args, s, pos) : this.callFunction(fn, args, s, pos)
        if (builtin) return builtin(new BuiltinCall(this, name, e.args, pos, s))
        this.warn(`Ignoring unknown function '${name}'`, pos)
        return undefined
      }
    }
    const callee = this.code(e.callee)
    return (s) => {
      const v = callee(s)
      if (!(v instanceof ScadFunc)) {
        this.warn(`Can't call function on ${typeName(v)}`, pos)
        return undefined
      }
      return tail ? this.tc.set(v, args, s, pos) : this.callFunction(v, args, s, pos)
    }
  }

  callFunction(fn: ScadFunc, args: CArg[], caller: Scope, pos: SourcePos): Value {
    if (++this.depth > this.limits.maxCallDepth) throw this.tooDeep('function', fn.name || 'function literal', pos)
    this.stack.push({ name: `${fn.name || 'function'}()`, kind: 'function', pos })
    let f = fn
    let a = args
    let from = caller
    let at = pos
    let r: Value | TailCall
    for (;;) {
      this.step(at)
      const closure = f.closure as Scope
      const sc = new Scope(closure, (f.dyn as Scope | null) ?? dynBase(from))
      this.bindUser(f.params, a, closure, from, sc, at)
      r = this.tail(f.body)(sc)
      if (!(r instanceof TailCall)) break
      f = r.fn
      a = r.args
      from = r.scope
      at = r.pos
    }
    this.stack.pop()
    this.depth--
    return r
  }
}

// control modules: always these, whatever the program defines (for, let, echo, assert are keywords)
const CONTROL = new Map<string, (I: Interpreter, s: InstStmt, scope: Scope) => GeomNode | null>([
  ['for', (I, s, sc) => I.evalFor(s, sc)],
  ['let', (I, s, sc) => I.evalLetStmt(s, sc)],
  ['echo', (I, s, sc) => I.evalEchoStmt(s, sc)],
  ['assert', (I, s, sc) => I.evalAssertStmt(s, sc)],
])

// built-in modules handled by the interpreter; a module of the same name in the program wins
const SPECIAL = new Map<string, (I: Interpreter, s: InstStmt, scope: Scope) => GeomNode | null>([
  ['intersection_for', (I, s, sc) => I.evalIntersectionFor(s, sc)],
  ['assign', (I, s, sc) => I.evalAssign(s, sc)],
  ['children', (I, s, sc) => I.evalChildrenCall(s, sc)],
  ['child', (I, s, sc) => I.evalChildrenCall(s, sc)],
  ['part', (I, s, sc) => I.evalPart(s, sc)],
])

function index(v: Value, i: Value): Value {
  if (typeof i !== 'number') return undefined
  const k = Math.floor(i)
  if (Array.isArray(v)) return k >= 0 && k < v.length ? v[k] : undefined
  if (typeof v === 'string') {
    const c = chars(v)
    return k >= 0 && k < c.length ? c[k] : undefined
  }
  if (v instanceof ScadRange) return k === 0 ? v.begin : k === 1 ? v.step : k === 2 ? v.end : undefined
  return undefined
}

function deepCount(v: Value[]): number {
  let n = v.length + LIST_WEIGHT
  for (const x of v) if (Array.isArray(x)) n += deepCount(x)
  return n
}

/** deepCount, but it stops as soon as the count is past `cap` (so its own cost is bounded by the budget, not by the
 *  size a list of shared sub-lists stands for) */
function cappedCount(v: Value[], cap: number): number {
  let n = 0
  const stack: Value[][] = [v]
  while (stack.length && n <= cap) {
    const x = stack.pop()!
    n += x.length + LIST_WEIGHT
    for (const y of x) if (Array.isArray(y)) stack.push(y)
  }
  return n
}

/** an index as OpenSCAD prints it in children() / parent_module() warnings (an integer) */
const formatInt = (n: number) => (Number.isFinite(n) ? String(n) : valueToString(n))

export const interpret: Interpret = (source, opts = {}) => new Interpreter(opts).run(source)
