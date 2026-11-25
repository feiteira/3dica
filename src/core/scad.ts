// OpenSCAD objects in core: the parameters derived from the code, attached-file paths and limits, and the static
// part() scan. Only the tokenizer-level parts of src/openscad are used here (customizer, lexer, paths), never the
// interpreter or the geometry builder, so this stays cheap on the main thread.
import type { CodeDef, Definition, ParamDef, ParamValue } from './types'
import { choiceOption, extractParams, setParamDefault } from '../openscad/customizer'
import { tokenize, type Token } from '../openscad/lexer'
import { dirOf, normalizePath, resolveFile } from '../openscad/paths'
import { paramDefProblems } from './params'

/** One attached (or imported) file, in UTF-16 characters (≈ bytes for ASCII source). */
export const MAX_SCAD_FILE_CHARS = 2 * 1024 * 1024
/** Attached files of one definition. */
export const MAX_SCAD_FILES = 200
/** All attached files of one definition together. */
export const MAX_SCAD_FILES_TOTAL = 16 * 1024 * 1024
export const MAX_SCAD_PATH = 255

export const SCAD_PARAMS_HINT = "An OpenSCAD object's parameters come from the top-level assignments in its code (width = 40; // [10:100]) — add, remove or rename them by editing the code"

/** A code definition whose code is OpenSCAD. */
export type ScadDef = CodeDef & { lang: 'openscad' }
/** (The guard names ScadDef, not CodeDef, so a false result still leaves a JSCAD CodeDef possible.) */
export const isScad = (d: Definition | undefined | null): d is ScadDef => !!d && d.kind === 'code' && d.lang === 'openscad'

// ───────────────────────────── parameters ─────────────────────────────

/**
 * The 3Dica parameters of OpenSCAD `code` (Customizer conventions, see src/openscad/customizer.ts), as plain
 * ParamDefs that pass paramDefProblems: the Inspector-only fields (line, description, group) are dropped and any
 * entry that would be invalid is left out.
 */
export function scadParams(code: string): ParamDef[] {
  const out: ParamDef[] = []
  const seen = new Set<string>()
  for (const p of extractParams(typeof code === 'string' ? code : '').params) {
    const pd: ParamDef = { name: p.name, type: p.type, default: p.default }
    if (p.min !== undefined) pd.min = p.min
    if (p.max !== undefined) pd.max = p.max
    if (p.step !== undefined) pd.step = p.step
    if (p.options !== undefined) pd.options = [...p.options]
    if (seen.has(pd.name) || paramDefProblems([pd]).length) continue
    seen.add(pd.name)
    out.push(pd)
  }
  return out
}

export interface ScadParamInfo { line: number; description?: string; group?: string }

/** What the Inspector shows next to each parameter: its line, the description comment and the Customizer tab. */
export function scadParamInfo(code: string): Map<string, ScadParamInfo> {
  const m = new Map<string, ScadParamInfo>()
  for (const p of extractParams(code).params) {
    const i: ScadParamInfo = { line: p.line }
    if (p.description) i.description = p.description
    if (p.group) i.group = p.group
    m.set(p.name, i)
  }
  return m
}

/**
 * `code` with the default of parameter `name` set to `value` (only the literal changes), or null when `name` is not
 * a parameter of the code or `value` does not suit it.
 */
export function setScadDefault(code: string, name: string, value: ParamValue): string | null {
  return setParamDefault(code, name, value)
}

/**
 * The option of dropdown parameter `name` that `value` stands for: the option itself or its OpenSCAD item value
 * (3 for // [0, 1, 2, 3], 30 for // [10:Small, 30:Large]); null when it is neither.
 */
export function scadChoiceOption(code: string, name: string, value: ParamValue): string | null {
  return choiceOption(code, name, value)
}

// ───────────────────────────── attached files ─────────────────────────────

const BAD_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * A file path as stored in CodeDef.files: relative, '/'-separated, without '.' segments. Refused: not text, empty,
 * too long, control characters, absolute ('/x', 'C:\x', '~/x'), climbing above the root with '..', and
 * '__proto__' / 'constructor' / 'prototype' segments.
 */
export function checkScadPath(raw: unknown): { path: string } | { problem: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return { problem: 'a file path must be text' }
  if (raw.length > MAX_SCAD_PATH) return { problem: `the file path '${raw.slice(0, 40)}…' is longer than ${MAX_SCAD_PATH} characters` }
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { problem: 'a file path can\'t contain control characters' }
  const p = raw.replace(/\\/g, '/')
  if (p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:/.test(p)) return { problem: `'${raw}' is an absolute path — attached files use relative paths like lib/gear.scad` }
  const n = normalizePath(p)
  if (n === null) return { problem: `'${raw}' points outside the object's files ('..' climbs above the root)` }
  if (!n) return { problem: `'${raw}' is not a file name` }
  if (n.split('/').some((s) => BAD_SEGMENTS.has(s))) return { problem: `'${raw}' is not an allowed file name` }
  return { path: n }
}

/** Problem with adding `text` as one more file to `files`, or null. */
export function scadFileProblem(files: Record<string, string> | undefined, path: string, text: unknown): string | null {
  if (typeof text !== 'string') return `${path}: the file content must be text`
  if (text.length > MAX_SCAD_FILE_CHARS) return `${path} is larger than ${MAX_SCAD_FILE_CHARS / 1024 / 1024} MB`
  const others = Object.entries(files ?? {}).filter(([k]) => k !== path)
  if (others.length + 1 > MAX_SCAD_FILES) return `An object can have at most ${MAX_SCAD_FILES} attached files`
  const total = others.reduce((n, [, v]) => n + v.length, text.length)
  if (total > MAX_SCAD_FILES_TOTAL) return `The attached files of an object can't be larger than ${MAX_SCAD_FILES_TOTAL / 1024 / 1024} MB together`
  return null
}

/**
 * A files map read from a project file: a JSON object of path → text. Paths are normalized (checkScadPath) and every
 * problem is listed; `files` is what could be kept (undefined when nothing).
 */
export function normalizeScadFiles(raw: unknown): { files?: Record<string, string>; problems: string[] } {
  const problems: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problems: ['files must be an object of file path → text'] }
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_SCAD_FILES) return { problems: [`at most ${MAX_SCAD_FILES} attached files are allowed (it has ${entries.length})`] }
  const files: Record<string, string> = {}
  let total = 0
  for (const [k, v] of entries) {
    const c = checkScadPath(k)
    if ('problem' in c) { problems.push(`files: ${c.problem}`); continue }
    if (typeof v !== 'string') { problems.push(`files: '${c.path}' must be text`); continue }
    if (v.length > MAX_SCAD_FILE_CHARS) { problems.push(`files: '${c.path}' is larger than ${MAX_SCAD_FILE_CHARS / 1024 / 1024} MB`); continue }
    if (Object.hasOwn(files, c.path)) { problems.push(`files: '${c.path}' is listed twice`); continue }
    total += v.length
    files[c.path] = v
  }
  if (total > MAX_SCAD_FILES_TOTAL) problems.push(`files: the attached files are larger than ${MAX_SCAD_FILES_TOTAL / 1024 / 1024} MB together`)
  return Object.keys(files).length ? { files, problems } : { problems }
}

// ───────────────────────────── static scan (part(), use / include) ─────────────────────────────

export interface ScadRefSite { name: string; line: number; col: number }

interface SourceInfo {
  /** part("Name" calls, in order */
  refs: ScadRefSite[]
  /** the source defines its own `module part` (then part() is that module, not 3Dica's) */
  ownPart: boolean
  /** use <…> / include <…> names */
  includes: string[]
}

/** source text → what the scan found; LRU, so a big library file is tokenized once, not on every render. Bounded by
 *  characters, not entries: an object may have MAX_SCAD_FILES files, and a cache smaller than one object would rescan
 *  all of them on every project change. Old versions of edited code are the oldest entries and go first. */
const INFO_MAX_CHARS = 64 * 1024 * 1024
const INFO_MAX_ENTRIES = 4 * (MAX_SCAD_FILES + 1)
const infoCache = new Map<string, SourceInfo>()
let infoChars = 0

function scanTokens(toks: Token[]): SourceInfo {
  const info: SourceInfo = { refs: [], ownPart: false, includes: [] }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.type === 'use' || t.type === 'include') info.includes.push(t.text)
    else if (t.type === 'kw' && t.text === 'module' && toks[i + 1]?.type === 'id' && toks[i + 1].text === 'part') info.ownPart = true
    else if (t.type === 'id' && t.text === 'part' && toks[i + 1]?.type === 'op' && toks[i + 1].text === '(' && toks[i + 2]?.type === 'str' && toks[i + 2].text) {
      info.refs.push({ name: toks[i + 2].text, line: t.line, col: t.col })
    }
  }
  return info
}

/** The same facts from text that does not tokenize (an unterminated string, a stray character): a plain text scan. */
function scanText(src: string): SourceInfo {
  const noComments = src.replace(/\/\*[\s\S]*?(\*\/|$)/g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  const info: SourceInfo = { refs: [], ownPart: /\bmodule\s+part\s*\(/.test(noComments), includes: [] }
  for (const m of noComments.matchAll(/\b(?:use|include)\s*<([^>\n]*)>/g)) info.includes.push(m[1])
  // lines are counted as the matches go (counting from the start for each match was quadratic)
  let line = 1, lastNl = -1, at = 0
  for (const m of noComments.matchAll(/\bpart\(\s*"([^"\n\\]+)"/g)) {
    for (; at < m.index; at++) if (noComments.charCodeAt(at) === 10) { line++; lastNl = at }
    info.refs.push({ name: m[1], line, col: m.index - lastNl })
  }
  return info
}

function sourceInfo(src: string): SourceInfo {
  const hit = infoCache.get(src)
  if (hit) { infoCache.delete(src); infoCache.set(src, hit); return hit }
  let info: SourceInfo
  try { info = scanTokens(tokenize(src)) } catch { info = scanText(src) }
  infoCache.set(src, info)
  infoChars += src.length
  while (infoCache.size > 1 && (infoChars > INFO_MAX_CHARS || infoCache.size > INFO_MAX_ENTRIES)) {
    const oldest = infoCache.keys().next().value as string
    infoCache.delete(oldest)
    infoChars -= oldest.length
  }
  return info
}

/** What was worked out for one files map and the last code that used it (the store keeps an unchanged map the same
 *  object across snapshots, so every render after the first finds it here without visiting any file). */
interface FilesMemo { code: string; reach?: string[]; refs?: string[]; ownPart?: boolean }
const filesMemo = new WeakMap<Record<string, string>, FilesMemo>()
function memoOf(code: string, files: Record<string, string>): FilesMemo {
  let m = filesMemo.get(files)
  if (!m || m.code !== code) { m = { code }; filesMemo.set(files, m) }
  return m
}

/** The names that `src` gives to use <…> / include <…>, in order (the same cached scan as the part() scan, so an
 *  import and the specs built right after it tokenize each file once). */
export function scadIncludeNames(src: string): string[] {
  return sourceInfo(src).includes.slice()
}

export interface ScadDep {
  /** the name as written in use <…> / include <…> */
  name: string
  /** the file that names it: '' for the object's own code, else an attached file's path */
  from: string
  /** the attached file it resolves to, or null when it is missing */
  resolved: string | null
}

/**
 * Every file the code needs (directly and through attached files), each once, in the order they are named — the
 * Inspector's list of attached files. Same resolution as the interpreter (src/openscad/paths.ts); cached scans.
 */
export function scadDepList(code: string, files: Record<string, string> | undefined): ScadDep[] {
  const map = new Map(Object.entries(files ?? {}))
  const out: ScadDep[] = []
  const seen = new Set<string>()
  const visit = (src: string, from: string) => {
    for (const name of sourceInfo(src).includes) {
      const resolved = resolveFile(map, from, name)
      const key = resolved ?? `missing:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name, from, resolved })
      if (resolved !== null) visit(map.get(resolved)!, resolved)
    }
  }
  visit(code, '')
  return out
}

/** The attached files `code` reaches through use / include (directly or through other attached files), in order. */
export function reachableScadFiles(code: string, files: Record<string, string> | undefined): string[] {
  if (!files) return []
  const memo = memoOf(code, files)
  return (memo.reach ??= reachable(code, files)).slice()
}

function reachable(code: string, files: Record<string, string>): string[] {
  const map = new Map(Object.entries(files))
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (src: string, from: string) => {
    for (const name of sourceInfo(src).includes) {
      const r = resolveFile(map, from, name)
      if (r === null || seen.has(r)) continue
      seen.add(r)
      out.push(r)
      visit(map.get(r)!, r)
    }
  }
  visit(code, '')
  return out
}

/**
 * The 3Dica definitions an OpenSCAD object's part("Name" calls name: in its code and in the attached files it uses or
 * includes, in order of first appearance, outside comments. None when any of those files defines its own
 * `module part` — then part() is that module and creates no 3Dica dependency.
 */
export function scadRefs(code: string, files?: Record<string, string>): string[] {
  if (!files) return refsOf([sourceInfo(code)])
  const memo = memoOf(code, files)
  return (memo.refs ??= refsOf([sourceInfo(code), ...reachableScadFiles(code, files).map((p) => sourceInfo(files[p]))])).slice()
}

function refsOf(infos: SourceInfo[]): string[] {
  if (infos.some((i) => i.ownPart)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const i of infos) for (const r of i.refs) if (!seen.has(r.name)) { seen.add(r.name); out.push(r.name) }
  return out
}

/** The part("Name" calls in the object's own code, with their 1-based line / column (diagnostics). */
export function scadRefSites(code: string, files?: Record<string, string>): ScadRefSite[] {
  if (scadRefs(code, files).length === 0) return []
  return sourceInfo(code).refs.map((r) => ({ ...r }))
}

/** True when the code (or a file it reaches) defines its own `module part`. */
export function scadDefinesPart(code: string, files?: Record<string, string>): boolean {
  if (sourceInfo(code).ownPart) return true
  if (!files) return false
  const memo = memoOf(code, files)
  return (memo.ownPart ??= reachableScadFiles(code, files).some((p) => sourceInfo(files[p]).ownPart))
}

/** The use / include line in the object's own code that brings in attached file `path` (directly or through others). */
export function scadIncludeLine(code: string, files: Record<string, string> | undefined, path: string): number | null {
  const map = new Map(Object.entries(files ?? {}))
  let toks: Token[]
  try { toks = tokenize(code) } catch { return null }
  for (const t of toks) {
    if (t.type !== 'use' && t.type !== 'include') continue
    const r = resolveFile(map, '', t.text)
    if (r === path) return t.line
    if (r !== null && reachableScadFiles(`include <${t.text}>`, files).includes(path)) return t.line
  }
  return null
}

/**
 * Where an attached file named `name` (as written in use / include in file `from`) is stored: next to the naming
 * file, like OpenSCAD looks for it; the plain name when that would climb above the root, or when a library names its
 * own folder (MCAD/shapes.scad including <MCAD/units.scad> means the library folder's MCAD/units.scad, not
 * MCAD/MCAD/units.scad; both resolve, from the root).
 */
export function scadStorePath(from: string, name: string): string | null {
  const dir = dirOf(from)
  const first = name.replace(/\\/g, '/').split('/')[0]
  if (dir && name.includes('/') && dir.endsWith(`${first}/`)) {
    const own = checkScadPath(name)
    if ('path' in own) return own.path
  }
  const c = checkScadPath(dir + name)
  if ('path' in c) return c.path
  const base = name.replace(/\\/g, '/').split('/').pop() ?? ''
  const b = checkScadPath(base)
  return 'path' in b ? b.path : null
}
