// The OpenSCAD syntax tree. Every node carries its source position; `file` is '' for the object's own code.
import type { SourcePos } from './types'

export interface Arg { name?: string; expr: Expr; pos: SourcePos }
export interface Param { name: string; def?: Expr; pos: SourcePos }

export type Expr =
  | { t: 'num'; v: number; pos: SourcePos }
  | { t: 'str'; v: string; pos: SourcePos }
  | { t: 'bool'; v: boolean; pos: SourcePos }
  | { t: 'undef'; pos: SourcePos }
  | { t: 'var'; name: string; pos: SourcePos }
  | { t: 'list'; items: Elem[]; pos: SourcePos }
  | { t: 'range'; begin: Expr; step?: Expr; end: Expr; pos: SourcePos }
  | { t: 'unary'; op: '-' | '!'; e: Expr; pos: SourcePos }
  | { t: 'binary'; op: BinOp; l: Expr; r: Expr; pos: SourcePos }
  | { t: 'ternary'; c: Expr; a: Expr; b: Expr; pos: SourcePos }
  | { t: 'index'; e: Expr; i: Expr; pos: SourcePos }
  | { t: 'member'; e: Expr; name: string; pos: SourcePos }
  | { t: 'call'; callee: Expr; args: Arg[]; pos: SourcePos }
  | { t: 'func'; params: Param[]; body: Expr; pos: SourcePos }
  | { t: 'let'; args: Arg[]; body: Expr; pos: SourcePos }
  | { t: 'assert'; args: Arg[]; body?: Expr; pos: SourcePos }
  | { t: 'echo'; args: Arg[]; body?: Expr; pos: SourcePos }

export type BinOp = '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%' | '^'

/** A list element: an expression or a list-comprehension element. */
export type Elem =
  | Expr
  | { t: 'lc-for'; args: Arg[]; body: Elem; pos: SourcePos }
  | { t: 'lc-cfor'; init: Arg[]; cond: Expr; update: Arg[]; body: Elem; pos: SourcePos }
  | { t: 'lc-if'; cond: Expr; then: Elem; else?: Elem; pos: SourcePos }
  | { t: 'lc-let'; args: Arg[]; body: Elem; pos: SourcePos }
  | { t: 'lc-each'; body: Elem; pos: SourcePos }

export type Stmt =
  | { t: 'assign'; name: string; expr: Expr; pos: SourcePos }
  | { t: 'module'; name: string; params: Param[]; body: Stmt[]; pos: SourcePos }
  | { t: 'function'; name: string; params: Param[]; body: Expr; pos: SourcePos }
  /** a module instantiation, including for / let / echo / assert / intersection_for / children */
  | { t: 'inst'; name: string; args: Arg[]; children: Stmt[]; mods: string; pos: SourcePos }
  | { t: 'if'; cond: Expr; then: Stmt[]; else?: Stmt[]; mods: string; pos: SourcePos }
  /** a bare `{ … }` at statement level: no scope of its own, its statements belong to the enclosing scope */
  | { t: 'block'; body: Stmt[]; pos: SourcePos }
  | { t: 'use'; path: string; pos: SourcePos }
  | { t: 'include'; path: string; pos: SourcePos }

export interface ScadFile { path: string; body: Stmt[] }
