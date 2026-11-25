// Which files an OpenSCAD source names with use <…> / include <…>, followed through the attached files, and which
// of them are missing. Tokenizer only (no parser, no interpreter): safe and fast on the main thread, for the import
// of several .scad files at once and for the Inspector's list of attached files.
import { tokenize } from './lexer'
import { normalizePath, resolveFile } from './paths'

export interface ScadDependency {
  kind: 'use' | 'include'
  /** the name as written, e.g. 'MCAD/involute_gears.scad' */
  name: string
  /** the file that names it: '' for the main source, else an attached file's path */
  from: string
  line: number
  /** the attached file it resolves to, or null when it is missing */
  resolved: string | null
}

/** the use / include statements of one source, in order; never throws */
export function scadIncludes(source: string): { kind: 'use' | 'include'; name: string; line: number }[] {
  let toks
  try { toks = tokenize(source) } catch { return [] }
  return toks.filter((t) => t.type === 'use' || t.type === 'include').map((t) => ({ kind: t.type as 'use' | 'include', name: t.text, line: t.line }))
}

/**
 * All files `source` needs, directly and through the attached `files` (keyed by relative path), each once, in the
 * order they are named. Resolution is the interpreter's: next to the naming file, then from the root, then a unique
 * attached file with that name.
 */
export function scadDependencies(source: string, files: Record<string, string> = {}): ScadDependency[] {
  const map = new Map<string, string>()
  for (const [k, v] of Object.entries(files)) {
    const n = normalizePath(k)
    if (n && typeof v === 'string') map.set(n, v)
  }
  const out: ScadDependency[] = []
  const seen = new Set<string>()
  const visit = (src: string, from: string) => {
    for (const d of scadIncludes(src)) {
      const resolved = resolveFile(map, from, d.name)
      const key = resolved ?? `missing:${d.name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ kind: d.kind, name: d.name, from, line: d.line, resolved })
      if (resolved !== null) visit(map.get(resolved)!, resolved)
    }
  }
  visit(source, '')
  return out
}

/** the names that `source` (or an attached file) uses or includes but that are not attached */
export function missingScadFiles(source: string, files: Record<string, string> = {}): string[] {
  return scadDependencies(source, files).filter((d) => d.resolved === null).map((d) => d.name)
}
