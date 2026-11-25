// File names in use <…> / include <…>: how they are found in an object's attached files. Small and dependency-free,
// so the import code and the Inspector can use it on the main thread.

/** 'a/./b/../c.scad' → 'a/c.scad'; null when it climbs above the root */
export function normalizePath(p: string): string | null {
  const out: string[] = []
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { if (!out.length) return null; out.pop(); continue }
    out.push(part)
  }
  return out.join('/')
}

export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '')

/**
 * Where `use <name>` / `include <name>` written in file `from` finds its file in `files`: next to `from` first,
 * then from the root (OpenSCAD's library folder), then, if exactly one attached file has that file name, that one.
 */
export function resolveFile(files: Map<string, string>, from: string, name: string): string | null {
  const candidates = [normalizePath(dirOf(from) + name), normalizePath(name)]
  for (const c of candidates) if (c && files.has(c)) return c
  const base = name.replace(/\\/g, '/').split('/').pop()
  if (!base) return null
  const hits = [...files.keys()].filter((k) => k === base || k.endsWith('/' + base))
  return hits.length === 1 ? hits[0] : null
}
