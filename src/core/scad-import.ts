// Import of .scad files (toolbar Import, files dropped on the window): which of the chosen files become objects and
// which are attached to them. Pure; the file reading and the store update are in app/commands.ts.
//
// A file that another file of the same import names with use <…> / include <…> is attached to the object that needs
// it (under the path the include gives, relative to the naming file, as OpenSCAD looks for it); the other files each
// become one OpenSCAD object. Names that no chosen file matches are reported as missing — the object then shows
// "Can't open include file 'gear.scad'" until the user attaches it in the Inspector.
import { resolveFile } from '../openscad/paths'
import { MAX_NAME } from './ids'
import { scadIncludeNames, scadStorePath } from './scad'

export interface ImportFile { name: string; text: string }

export interface ImportObject {
  /** the file it comes from ('bracket.scad') */
  file: string
  code: string
  /** attached files, keyed by relative path */
  files: Record<string, string>
  /** use / include names no chosen file provides */
  missing: string[]
}

const baseOf = (name: string): string => name.replace(/\\/g, '/').split('/').pop() ?? name

/** The files that become objects, each with what it needs from the others. Order follows the input. */
export function planScadImport(input: ImportFile[]): ImportObject[] {
  // each file is tokenized once (a library import can be 200 files and 16 MB, on the main thread), in the scan cache
  // the specs use right after
  const incs = new Map<ImportFile, { name: string }[]>()
  const includesOf = (f: ImportFile) => {
    let r = incs.get(f)
    if (!r) { r = scadIncludeNames(f.text).map((name) => ({ name })); incs.set(f, r) }
    return r
  }
  const byBase = new Map<string, ImportFile>()
  for (const f of input) if (!byBase.has(baseOf(f.name))) byBase.set(baseOf(f.name), f)
  const unique = [...byBase.values()]
  const included = new Set<ImportFile>()
  for (const f of unique) {
    for (const inc of includesOf(f)) {
      const t = byBase.get(baseOf(inc.name))
      if (t && t !== f) included.add(t)
    }
  }
  let roots = unique.filter((f) => !included.has(f))
  if (roots.length === 0 && unique.length) roots = [unique[0]] // every file includes another: start with the first
  return roots.map((root) => {
    const files: Record<string, string> = {}
    const byPath = new Map<string, ImportFile>()
    const attached = new Set<ImportFile>([root])
    const visit = (f: ImportFile, from: string) => {
      for (const inc of includesOf(f)) {
        const t = byBase.get(baseOf(inc.name))
        if (!t || attached.has(t)) continue
        const key = scadStorePath(from, inc.name)
        if (key === null || Object.hasOwn(files, key)) continue
        attached.add(t)
        files[key] = t.text
        byPath.set(key, t)
        visit(t, key)
      }
    }
    visit(root, '')
    // what is still missing, resolved the interpreter's way (as missingScadFiles does, without tokenizing again)
    const map = new Map(Object.entries(files))
    const missing: string[] = []
    const seen = new Set<string>()
    const walk = (f: ImportFile, from: string) => {
      for (const inc of includesOf(f)) {
        const r = resolveFile(map, from, inc.name)
        const key = r ?? `missing:${inc.name}`
        if (seen.has(key)) continue
        seen.add(key)
        if (r === null) missing.push(inc.name)
        else walk(byPath.get(r)!, r)
      }
    }
    walk(root, '')
    return { file: root.name, code: root.text, files, missing }
  })
}

/** A definition name from a file name: 'bracket.scad' → 'bracket', without characters names can't have. */
export function scadObjectName(fileName: string): string {
  const base = baseOf(fileName).replace(/\.scad$/i, '')
  const clean = base.replace(/['"`\\\r\n\t]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim()
  return clean && clean !== 'Scene' ? clean : 'Object'
}
