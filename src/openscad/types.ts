// The contract of the OpenSCAD support (src/openscad/*). An OpenSCAD object is a code definition whose code is
// OpenSCAD source instead of a JSCAD function body. It is evaluated in the eval worker in three steps:
//
//   source ──interpret()──▶ GeomNode tree ──build()──▶ JSCAD Geom3[] ──▶ the engine (memo, meshes, STL) as usual
//
//   1. interp side  — lexer, parser, interpreter with OpenSCAD's semantics (scoping, $-variables, modules, functions,
//                     children(), list comprehensions, built-in functions, echo/assert). Knows nothing about JSCAD.
//   2. build side   — turns the CSG tree into JSCAD geometry with OpenSCAD's tessellation ($fn/$fa/$fs), so results
//                     match real OpenSCAD. Knows nothing about the language.
//   3. customizer   — reads the top-level parameter assignments (OpenSCAD Customizer conventions) into 3Dica
//                     ParamDefs. Tiny and dependency-free: it runs on the main thread when code changes.
//
// Reference behaviour: OpenSCAD 2021.01 (the latest stable release). When in doubt, do what it does.

import type { Geom3 } from '@jscad/modeling/src/geometries/types'
import type { ParamDef, ParamValue } from '../core/types'

// ───────────────────────────── positions, errors, messages ─────────────────────────────

/** A place in the source. `file` is '' for the object's own code, otherwise the attached file's path ('lib/gear.scad'). */
export interface SourcePos { file: string; line: number; col: number }   // 1-based

export type ScadErrorKind =
  /** the source does not parse */
  | 'syntax'
  /** evaluation failed (assert, bad argument, unknown file in include/use, recursion too deep, …) */
  | 'runtime'
  /** a safety limit was hit (too many list elements, too much geometry, too many steps) */
  | 'limit'

/** The one error type both sides throw. The engine turns it into an EvalError (gutter marker when pos.file === ''). */
export class ScadError extends Error {
  readonly kind: ScadErrorKind
  readonly pos?: SourcePos
  /** module/function calls from the outside in, e.g. ['bracket() at line 12', 'hole() at line 4'] */
  readonly trace: string[]
  /** console output printed before the error (interpret() sets it), so echo() debugging still shows */
  messages?: ScadMessage[]
  constructor(kind: ScadErrorKind, message: string, pos?: SourcePos, trace: string[] = []) {
    super(message)
    this.name = 'ScadError'
    this.kind = kind
    this.pos = pos
    this.trace = trace
  }
}

/** Console output, in the order OpenSCAD would print it. */
export interface ScadMessage {
  level: 'echo' | 'warning'
  /** formatted like OpenSCAD's console text without the "ECHO: " / "WARNING: " prefix, e.g. `"w = ", 40` → '"w = ", 40' */
  text: string
  pos?: SourcePos
}

// ───────────────────────────── the CSG tree (interp → build) ─────────────────────────────

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
/** 16 numbers, column-major: the same layout as JSCAD mat4 and 3Dica's Mat4 */
export type Mat4 = number[]
export type Rgba = [number, number, number, number]   // 0..1

/** $fn / $fa / $fs in effect at the call; build turns them into fragment counts with OpenSCAD's formula */
export interface Fragments { fn: number; fa: number; fs: number }

interface NodeBase { pos?: SourcePos }

/**
 * One node per OpenSCAD built-in module instance, with arguments already evaluated, defaulted and validated
 * (d → r, scalar size → vector, rotate/translate/scale/mirror/multmatrix → one matrix, color names → rgba, …).
 * User modules, for, if, let, children(), intersection_for and modifiers are resolved by the interpreter:
 * they produce 'group' nodes (implicit union), 'intersection' nodes (intersection_for) or nothing.
 */
export type GeomNode = NodeBase & (
  // 3D primitives
  | { kind: 'cube'; size: Vec3; center: boolean }
  | { kind: 'sphere'; r: number; frag: Fragments }
  | { kind: 'cylinder'; h: number; r1: number; r2: number; center: boolean; frag: Fragments }
  /** faces as given by the user: OpenSCAD winding (clockwise seen from outside); build reverses them for JSCAD */
  | { kind: 'polyhedron'; points: Vec3[]; faces: number[][] }
  // 2D primitives
  | { kind: 'square'; size: Vec2; center: boolean }
  | { kind: 'circle'; r: number; frag: Fragments }
  /** paths undefined = one outline through all points in order */
  | { kind: 'polygon'; points: Vec2[]; paths?: number[][] }
  | {
      kind: 'text'; text: string; size: number; font: string; halign: 'left' | 'center' | 'right'
      valign: 'top' | 'center' | 'baseline' | 'bottom'; spacing: number; direction: 'ltr' | 'rtl' | 'ttb' | 'btt'; frag: Fragments
    }
  // transforms
  | { kind: 'multmatrix'; m: Mat4; children: GeomNode[] }
  | { kind: 'color'; rgba: Rgba; children: GeomNode[] }
  | { kind: 'resize'; size: Vec3; auto: [boolean, boolean, boolean]; children: GeomNode[] }
  /** exactly one of r / delta; chamfer only with delta */
  | { kind: 'offset'; r?: number; delta?: number; chamfer: boolean; frag: Fragments; children: GeomNode[] }
  // CSG
  /** 'group' = an implicit union (module instance, for, if, children(), render(), the top level) */
  | { kind: 'group' | 'union' | 'difference' | 'intersection' | 'hull' | 'minkowski'; children: GeomNode[] }
  // extrusions and projection
  | {
      kind: 'linear_extrude'; height: number; center: boolean; twist: number
      /** undefined = OpenSCAD's default (computed from the shape and frag when twisted) */
      slices?: number; scale: Vec2; frag: Fragments; children: GeomNode[]
    }
  | { kind: 'rotate_extrude'; angle: number; frag: Fragments; children: GeomNode[] }
  | { kind: 'projection'; cut: boolean; children: GeomNode[] }
  // 3Dica
  /** part("Name", width = 20) — another 3Dica definition's geometry, with parameter overrides */
  | { kind: 'part'; name: string; overrides: Record<string, ParamValue> }
)

// ───────────────────────────── interp side (src/openscad/interp.ts and friends) ─────────────────────────────

export interface InterpretLimits {
  /** nested module/function calls (tail-recursive functions do not count, as in OpenSCAD) */
  maxCallDepth: number
  /** elements in one list or range iteration */
  maxListLength: number
  /** list elements + string characters created in one evaluation (out-of-memory protection) */
  maxTotalElements: number
  /** characters in one string */
  maxStringLength: number
  /** function and module calls plus loop rounds in one evaluation: stops loops and tail recursion that never end */
  maxSteps: number
}

export interface InterpretOptions {
  /** files that `use <…>` / `include <…>` can name, keyed by normalized relative path ('lib/gear.scad', no './') */
  files?: Record<string, string>
  /**
   * 3Dica parameter values for top-level variables (the object's ParamDefs, resolved with the instance's overrides).
   * Each replaces the value of that variable's top-level assignment in the main source. The values have the meaning
   * that extractParams() gives them on the same source: a choice option is mapped back to the OpenSCAD value
   * (numeric dropdown "2" → 2, labelled dropdown "Medium" → 20).
   */
  overrides?: Record<string, ParamValue>
  /** seed for rands() calls without a seed argument (3Dica seeds per object + parameters so a re-run is identical) */
  randomSeed?: number
  /** value of $preview (default true) */
  preview?: boolean
  limits?: Partial<InterpretLimits>
}

export interface InterpretResult {
  /** the top-level objects (an implicit union, like OpenSCAD's root) */
  nodes: GeomNode[]
  messages: ScadMessage[]
}

/** Parse and run OpenSCAD source; throws ScadError. Pure: no DOM, no network, never eval / new Function. */
export type Interpret = (source: string, opts?: InterpretOptions) => InterpretResult

// ───────────────────────────── build side (src/openscad/build.ts and friends) ─────────────────────────────

export interface BuildContext {
  /** geometry of another 3Dica definition, for 'part' nodes; throws (the engine's error passes through unchanged) */
  resolvePart(name: string, overrides: Record<string, ParamValue>, pos?: SourcePos): Geom3[]
  /**
   * Called before (estimate) and after (actual) creating polygons. Throws ScadError('limit', …) when the evaluation's
   * geometry budget is exceeded, so a runaway model is stopped while it is still allocating.
   */
  charge(polygons: number, what: string, pos?: SourcePos): void
}

export interface BuildResult {
  /** 3D results; top-level objects stay separate (no union), each keeps its color */
  geoms: Geom3[]
  /** e.g. '2D result shown 1 mm thick, like OpenSCAD's preview — use linear_extrude() for a solid' */
  warnings: string[]
}

/** CSG tree → JSCAD geometry; throws ScadError. Pure: no DOM. */
export type Build = (nodes: GeomNode[], ctx: BuildContext) => BuildResult

// ───────────────────────────── customizer side (src/openscad/customizer.ts) ─────────────────────────────

/** A ParamDef read from the source, plus what the Inspector can show about it. */
export interface ScadParam extends ParamDef {
  /** 1-based line of the assignment in the main source */
  line: number
  /** the comment line above the assignment (Customizer description) */
  description?: string
  /** the Customizer tab it is in: the last `/* [Group] *\/` comment before it */
  group?: string
}

export interface ExtractResult {
  params: ScadParam[]
  /** top-level assignments that cannot be a 3Dica parameter, with why ('a vector', 'a string without options', …) */
  skipped: { name: string; line: number; reason: string }[]
}

/** The Customizer parameters of `source`. Never throws (unparsable source → what could be read). Main-thread safe. */
export type ExtractParams = (source: string) => ExtractResult

/** `source` with the value of top-level parameter `name` replaced by `value` (only the literal changes); null if it is not a parameter. */
export type SetParamDefault = (source: string, name: string, value: ParamValue) => string | null

// ───────────────────────────── glue (src/openscad/index.ts) ─────────────────────────────

export interface RunScadOptions extends InterpretOptions, BuildContext {}

export interface RunScadResult {
  geoms: Geom3[]
  /** console output and build warnings, in order (the Inspector shows them like OpenSCAD's console) */
  messages: ScadMessage[]
}

/** interpret + build; throws ScadError (or the error resolvePart threw). */
export type RunScad = (source: string, opts: RunScadOptions) => RunScadResult
