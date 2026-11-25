// §5.5 mesh cache (main thread): resultKey → MeshEntry. Survives worker respawns.
// Entries that neither the wanted set nor the view (setInUse: displayed keys incl. last-good fallbacks) references are
// evicted LRU once the cache holds more than MESH_CACHE_MAX entries OR more than MESH_CACHE_MAX_BYTES of vertex data,
// and their geometries (and lazy edges) disposed. An entry that stops being protected also gives its WebGL buffers back
// right away (BufferGeometry.dispose(); three re-uploads it if it is shown again), so superseded results of an edit
// hold no GPU memory while they wait in the cache for a cheap undo.
import * as THREE from 'three'
import type { MeshEntry } from '../app/context'
import type { ConsoleLine, MeshData } from './protocol'
import { buildEdges } from './edges'

export const MESH_CACHE_MAX = 300
/** Vertex data (positions, normals, edges) the cache may hold, protected entries included (they are never evicted). */
export const MESH_CACHE_MAX_BYTES = 256 * 1024 * 1024
/** EdgesGeometry threshold angle in degrees (§5.6 / MeshEntry.edges). */
export const EDGE_THRESHOLD_DEG = 30

/** MeshData[] (as posted by the worker) → MeshEntry with one non-indexed BufferGeometry per mesh. */
export function toMeshEntry(meshes: MeshData[], tris: number, ms: number, warnings: string[], console?: ConsoleLine[]): MeshEntry {
  const geometries: THREE.BufferGeometry[] = []
  const baked: (THREE.Color | null)[] = []
  const bbox = new THREE.Box3() // empty until a mesh is added
  for (const m of meshes) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3))
    // the worker computes bbox from the float32 values themselves, so it is exact
    g.boundingBox = new THREE.Box3(new THREE.Vector3(...m.bbox[0]), new THREE.Vector3(...m.bbox[1]))
    g.computeBoundingSphere()
    geometries.push(g)
    baked.push(m.color ? new THREE.Color().setRGB(m.color[0], m.color[1], m.color[2], THREE.SRGBColorSpace) : null)
    bbox.union(g.boundingBox)
  }
  const entry: MeshEntry = { geometries, baked, tris, bbox, ms, warnings: [...warnings] }
  if (console) entry.console = console
  return entry
}

/**
 * Above this many triangles an entry gets no selection outline (the selected tint still shows): even the fast edge
 * builder takes a noticeable fraction of a second on the main thread for each new result of a huge selected mesh.
 */
export const OUTLINE_MAX_TRIS = 300_000

/**
 * Lazily build (once) and return the entry's edge geometries (EdgesGeometry-equivalent, see edges.ts); they are
 * disposed together with the entry. [] for an entry above OUTLINE_MAX_TRIS.
 */
export function ensureEdges(entry: MeshEntry, thresholdDeg = EDGE_THRESHOLD_DEG): THREE.BufferGeometry[] {
  if (!entry.edges) entry.edges = entry.tris > OUTLINE_MAX_TRIS ? [] : entry.geometries.map((g) => buildEdges(g, thresholdDeg))
  return entry.edges
}

export function disposeEntry(entry: MeshEntry): void {
  for (const g of entry.geometries) g.dispose()
  for (const g of entry.edges ?? []) g.dispose()
}

/** Bytes of vertex data an entry holds on the CPU (and, while shown, on the GPU). */
export function entryBytes(entry: MeshEntry): number {
  let n = 0
  for (const g of [...entry.geometries, ...(entry.edges ?? [])]) {
    for (const a of Object.values(g.attributes)) n += (a as THREE.BufferAttribute).array?.byteLength ?? 0
    if (g.index) n += g.index.array.byteLength
  }
  return n
}

export class MeshCache {
  /** insertion order = recency (oldest first) */
  private readonly map = new Map<string, MeshEntry>()
  /** keys that were protected (shown or wanted) at the last evict(): their geometries may hold WebGL buffers */
  private readonly hot = new Set<string>()
  readonly max: number
  readonly maxBytes: number

  constructor(max = MESH_CACHE_MAX, maxBytes = MESH_CACHE_MAX_BYTES) {
    this.max = max
    this.maxBytes = maxBytes
  }

  get size(): number { return this.map.size }

  /** Vertex data held by every entry. */
  bytes(): number {
    let n = 0
    for (const e of this.map.values()) n += entryBytes(e)
    return n
  }

  has(key: string): boolean { return this.map.has(key) }

  /** Look up and mark as most recently used. */
  get(key: string): MeshEntry | undefined {
    const e = this.map.get(key)
    if (e) { this.map.delete(key); this.map.set(key, e) }
    return e
  }

  /** Look up without touching recency. */
  peek(key: string): MeshEntry | undefined { return this.map.get(key) }

  set(key: string, entry: MeshEntry): void {
    const old = this.map.get(key)
    if (old && old !== entry) disposeEntry(old)
    this.map.delete(key)
    this.map.set(key, entry)
  }

  delete(key: string): boolean {
    const e = this.map.get(key)
    if (!e) return false
    this.map.delete(key)
    this.hot.delete(key)
    disposeEntry(e)
    return true
  }

  /**
   * 1. Entries that were protected and no longer are release their WebGL buffers (CPU data kept).
   * 2. Evict least-recently-used entries for which `isProtected(key)` is false until size <= max and bytes <= maxBytes.
   * Returns evicted keys. Protected entries are never evicted, even when that leaves the cache above a limit.
   */
  evict(isProtected: (key: string) => boolean): string[] {
    for (const k of [...this.hot]) {
      if (isProtected(k)) continue
      this.hot.delete(k)
      const e = this.map.get(k)
      if (e) disposeEntry(e) // GPU only: the arrays stay, three uploads them again if the entry is shown again
    }
    for (const k of this.map.keys()) if (isProtected(k)) this.hot.add(k)
    const out: string[] = []
    let bytes = this.bytes()
    for (const [k, e] of this.map) {
      if (this.map.size <= this.max && bytes <= this.maxBytes) break
      if (isProtected(k)) continue
      bytes -= entryBytes(e)
      this.map.delete(k)
      this.hot.delete(k)
      disposeEntry(e)
      out.push(k)
    }
    return out
  }

  keys(): IterableIterator<string> { return this.map.keys() }

  clear(): void {
    for (const e of this.map.values()) disposeEntry(e)
    this.map.clear()
    this.hot.clear()
  }
}
