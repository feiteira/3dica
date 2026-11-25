// Loading a program: parse the main source and the files it names, expand `include <…>` in place (it is textual
// in OpenSCAD), collect `use <…>` libraries, and turn every statement list into a Plan, the shape OpenSCAD
// evaluates a scope in: all assignments first (a name assigned twice keeps the first position and the last value),
// then the module instantiations in order. Function and module definitions belong to the whole scope.
import type { Expr, Stmt } from './ast'
import { parse } from './parser'
import { normalizePath, resolveFile } from './paths'
import { ScadError, type SourcePos } from './types'

type FuncStmt = Extract<Stmt, { t: 'function' }>
type ModStmt = Extract<Stmt, { t: 'module' }>

export interface Plan {
  assigns: { name: string; expr: Expr; pos: SourcePos }[]
  funcs: Map<string, FuncStmt>
  mods: Map<string, ModStmt>
  /** 'inst' and 'if' statements, in order */
  insts: Stmt[]
}

export interface FileUnit {
  /** '' for the main source */
  path: string
  body: Stmt[]
  plan: Plan
  /** libraries named by `use <…>`, in order (a later one wins on a name clash) */
  uses: FileUnit[]
}

export interface Program {
  main: FileUnit
  planOf(list: Stmt[]): Plan
}

/** Includes nested deeper than this are treated as an include loop. */
const MAX_INCLUDE_DEPTH = 32
/** Statements read while expanding includes, over the whole program (as many as the tokenizer allows in one file):
 *  a few files that each include the next twice would otherwise expand to billions before anything runs. */
export const MAX_EXPANDED = 2_000_000

export function loadProgram(source: string, fileMap: Record<string, string>, warn: (text: string, pos?: SourcePos) => void): Program {
  const files = new Map<string, string>()
  for (const [k, v] of Object.entries(fileMap)) {
    const n = normalizePath(k)
    if (n && typeof v === 'string') files.set(n, v)
  }
  const parsed = new Map<string, Stmt[]>()
  let expanded = 0
  // where each use / include of each file leads (a file included many times asks the same again and again)
  const found = new Map<string, string | null>()
  const resolve = (from: string, name: string): string | null => {
    const k = from + '\u0000' + name
    let r = found.get(k)
    if (r === undefined) { r = resolveFile(files, from, name); found.set(k, r) }
    return r
  }
  const units = new Map<string, FileUnit>()
  const plans = new WeakMap<Stmt[], Plan>()

  const parseFile = (path: string): Stmt[] => {
    let body = parsed.get(path)
    if (!body) {
      body = parse(files.get(path)!, path).body
      parsed.set(path, body)
    }
    return body
  }

  /** Build the plan of `list` (once), expanding includes and blocks, warning about overwritten variables. */
  const build = (list: Stmt[], unit: FileUnit): Plan => {
    const cached = plans.get(list)
    if (cached) return cached
    const plan: Plan = { assigns: [], funcs: new Map(), mods: new Map(), insts: [] }
    plans.set(list, plan)
    const index = new Map<string, number>()
    const lastPos = new Map<string, SourcePos>()
    /** `chain`: the attached files being included, outermost first (an include of one of them is skipped) */
    const add = (stmts: Stmt[], chain: string[]) => {
      if ((expanded += stmts.length) > MAX_EXPANDED) {
        const at = stmts.find((x) => x.t === 'include')
        throw new ScadError('limit', `The code expands to too much: more than ${MAX_EXPANDED.toLocaleString('en-US')} statements after its include <…> files are read in (a file included again and again?)`, at?.pos)
      }
      for (const s of stmts) {
        switch (s.t) {
          case 'assign': {
            const i = index.get(s.name)
            if (i === undefined) {
              index.set(s.name, plan.assigns.length)
              lastPos.set(s.name, s.pos)
              plan.assigns.push({ name: s.name, expr: s.expr, pos: s.pos })
            } else {
              // OpenSCAD warns about the previous assignment, except when the main code overrides an included
              // file's value (the usual way to set a library's defaults) or the same statement is included again
              const prev = lastPos.get(s.name)!
              const same = prev.file === s.pos.file && prev.line === s.pos.line && prev.col === s.pos.col
              if (!same && !(s.pos.file === '' && prev.file !== '')) {
                const where = prev.file === '' && s.pos.file === '' ? '' : prev.file === '' ? ' of the main code' : ` of "${prev.file}"`
                warn(`${s.name} was assigned on line ${prev.line}${where} but was overwritten`, s.pos)
              }
              lastPos.set(s.name, s.pos)
              plan.assigns[i] = { name: s.name, expr: s.expr, pos: plan.assigns[i].pos }
            }
            break
          }
          case 'function': plan.funcs.set(s.name, s); break
          // nested statement lists are planned where they appear, so warnings come out in source order
          case 'module': plan.mods.set(s.name, s); build(s.body, unit); break
          case 'block': add(s.body, chain); break
          case 'include': {
            const path = resolve(s.pos.file, s.path)
            if (path === null) throw new ScadError('runtime', `Can't open include file '${s.path}'`, s.pos)
            // a file that includes itself (directly or round a loop) is not read again: OpenSCAD warns and goes on
            // (without a position, as OpenSCAD prints it)
            if (path === s.pos.file || chain.includes(path)) { warn(`Can't open include file '${s.path}'.`); break }
            if (chain.length >= MAX_INCLUDE_DEPTH) throw new ScadError('runtime', `include <${s.path}> nests too deeply (more than ${MAX_INCLUDE_DEPTH} files, each including the next)`, s.pos)
            add(parseFile(path), [...chain, path])
            break
          }
          case 'use': {
            const path = resolve(s.pos.file, s.path)
            if (path === null) throw new ScadError('runtime', `Can't open library '${s.path}'`, s.pos)
            pendingUses.push({ unit, path })
            break
          }
          // a disabled (*) instantiation is not even a child: $children does not count it
          case 'inst':
            if (s.mods.includes('*')) break
            plan.insts.push(s)
            build(s.children, unit)
            break
          case 'if':
            if (s.mods.includes('*')) break
            plan.insts.push(s)
            build(s.then, unit)
            if (s.else) build(s.else, unit)
            break
        }
      }
    }
    add(list, [])
    return plan
  }

  const pendingUses: { unit: FileUnit; path: string }[] = []

  const loadUnit = (path: string, body: Stmt[]): FileUnit => {
    const unit: FileUnit = { path, body, plan: null as unknown as Plan, uses: [] }
    units.set(path, unit)
    unit.plan = build(body, unit)
    return unit
  }

  const main = loadUnit('', parse(source, '').body)
  // libraries after the main file, each once
  while (pendingUses.length) {
    const { unit, path } = pendingUses.shift()!
    let lib = units.get(path)
    if (!lib) lib = loadUnit(path, parseFile(path))
    if (!unit.uses.includes(lib)) unit.uses.push(lib)
  }
  return {
    main,
    planOf: (list) => plans.get(list) ?? build(list, main),
  }
}
