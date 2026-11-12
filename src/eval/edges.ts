// The selection outline (§4.4: EdgesGeometry, threshold 30°) of a result mesh, built fast.
// three's EdgesGeometry keys every vertex and edge with template strings in plain objects: about 2.4 s of main-thread
// time for a 1M-triangle mesh, repeated for every new result of the selected object. This is the same algorithm on
// typed-array hash tables (open addressing), so it produces the same segments (in another order) several times faster.
// Rules, as in three r187: vertices are merged by position rounded to 1e-4; degenerate triangles are skipped; a
// directed edge a→b is matched with a later b→a, and drawn when the two face normals differ by more than the threshold
// (dot <= cos(threshold)); edges never matched are drawn too (boundaries, and the T-junctions of CSG results).
import * as THREE from 'three'

const PRECISION = 1e4
const I32_MAX = 2147483647

function pow2AtLeast(n: number): number {
  let c = 16
  while (c < n) c *= 2
  return c
}

/**
 * Line-segment positions (6 floats per edge) for a non-indexed triangle position array, or null when a coordinate is
 * too large for the integer grid (|x| > 214 m) — the caller then uses three's EdgesGeometry.
 */
export function edgeSegments(pos: ArrayLike<number>, thresholdDeg = 30): Float32Array | null {
  const vcount = Math.floor(pos.length / 3)
  const tris = Math.floor(vcount / 3)
  const thresholdDot = Math.cos((thresholdDeg * Math.PI) / 180)

  // 1. vertex ids by rounded position. Table rows [id + 1 (0 = empty), qx, qy, qz], grown when half full
  //    (closed meshes share each vertex between ~6 triangles, so the table stays small and cache friendly).
  let vcap = pow2AtLeast(vcount / 4)
  let vtab = new Int32Array(vcap * 4)
  const vid = new Int32Array(vcount)
  let ids = 0
  const vput = (tab: Int32Array, mask: number, qx: number, qy: number, qz: number, id: number): number => {
    let h = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & mask
    for (;;) {
      const r = h * 4
      const cur = tab[r]
      if (cur === 0) { tab[r] = id + 1; tab[r + 1] = qx; tab[r + 2] = qy; tab[r + 3] = qz; return id }
      if (tab[r + 1] === qx && tab[r + 2] === qy && tab[r + 3] === qz) return cur - 1
      h = (h + 1) & mask
    }
  }
  for (let v = 0; v < vcount; v++) {
    const x = Math.round(pos[v * 3] * PRECISION), y = Math.round(pos[v * 3 + 1] * PRECISION), z = Math.round(pos[v * 3 + 2] * PRECISION)
    if (!(Math.abs(x) <= I32_MAX && Math.abs(y) <= I32_MAX && Math.abs(z) <= I32_MAX)) return null
    if (ids * 2 >= vcap) {
      const old = vtab
      vcap *= 2
      vtab = new Int32Array(vcap * 4)
      for (let r = 0; r < old.length; r += 4) if (old[r] !== 0) vput(vtab, vcap - 1, old[r + 1], old[r + 2], old[r + 3], old[r] - 1)
    }
    const id = vput(vtab, vcap - 1, x, y, z, ids)
    if (id === ids) ids++
    vid[v] = id
  }

  // 2. edges, one row per undirected edge lo–hi: [lo + 1 (0 = empty), hi, state, first lo→hi, first hi→lo]
  //    state bits 0-1: lo→hi, bits 2-3: hi→lo (0 none, 1 waiting for its reverse, 2 matched);
  //    first = vertex index (triangle * 3 + j) of the edge's start in the triangle that brought it
  const ROW = 5
  let ecap = pow2AtLeast(tris * 2)
  let etab = new Int32Array(ecap * ROW)
  let edges = 0
  const efind = (tab: Int32Array, mask: number, lo: number, hi: number): number => {
    let h = (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi + 0x7f4a7c15, 0x85ebca77)) & mask
    for (;;) {
      const r = h * ROW
      if (tab[r] === 0 || (tab[r] === lo + 1 && tab[r + 1] === hi)) return r
      h = (h + 1) & mask
    }
  }
  const normals = new Float32Array(tris * 3)
  let out = new Float32Array(Math.max(18, tris * 2))
  let o = 0
  const emit = (a: number, b: number) => {
    if (o + 6 > out.length) { const bigger = new Float32Array(out.length * 2); bigger.set(out); out = bigger }
    out[o++] = pos[a * 3]; out[o++] = pos[a * 3 + 1]; out[o++] = pos[a * 3 + 2]
    out[o++] = pos[b * 3]; out[o++] = pos[b * 3 + 1]; out[o++] = pos[b * 3 + 2]
  }
  for (let t = 0; t < tris; t++) {
    const i0 = t * 3
    const a = vid[i0], b = vid[i0 + 1], c = vid[i0 + 2]
    if (a === b || b === c || c === a) continue
    // three's Triangle.getNormal: (c - b) × (a - b), normalized
    const p = i0 * 3
    const bx = pos[p + 3], by = pos[p + 4], bz = pos[p + 5]
    const ux = pos[p + 6] - bx, uy = pos[p + 7] - by, uz = pos[p + 8] - bz
    const wx = pos[p] - bx, wy = pos[p + 1] - by, wz = pos[p + 2] - bz
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx
    const len2 = nx * nx + ny * ny + nz * nz
    if (len2 > 0) { const k = 1 / Math.sqrt(len2); nx *= k; ny *= k; nz *= k } else { nx = ny = nz = 0 }
    normals[i0] = nx; normals[i0 + 1] = ny; normals[i0 + 2] = nz
    for (let j = 0; j < 3; j++) {
      const x = j === 0 ? a : j === 1 ? b : c
      const y = j === 0 ? b : j === 1 ? c : a
      const fwd = x < y
      const lo = fwd ? x : y, hi = fwd ? y : x
      if (edges * 2 >= ecap) {
        const old = etab
        ecap *= 2
        etab = new Int32Array(ecap * ROW)
        for (let r = 0; r < old.length; r += ROW) {
          if (old[r] === 0) continue
          const q = efind(etab, ecap - 1, old[r] - 1, old[r + 1])
          for (let k = 0; k < ROW; k++) etab[q + k] = old[r + k]
        }
      }
      const r = efind(etab, ecap - 1, lo, hi)
      if (etab[r] === 0) { etab[r] = lo + 1; etab[r + 1] = hi; edges++ }
      const st = etab[r + 2]
      const same = fwd ? st & 3 : (st >> 2) & 3
      const rev = fwd ? (st >> 2) & 3 : st & 3
      if (rev === 1) {
        // a sibling edge (the reverse direction) is waiting: draw it if the faces meet at more than the threshold
        const first = etab[fwd ? r + 4 : r + 3]
        const ot = first - (first % 3)
        if (nx * normals[ot] + ny * normals[ot + 1] + nz * normals[ot + 2] <= thresholdDot) emit(i0 + j, i0 + (j + 1) % 3)
        etab[r + 2] = fwd ? (st & 3) | (2 << 2) : (st & ~3) | 2
      } else if (same === 0) {
        etab[r + 2] = fwd ? (st & ~3) | 1 : (st & 3) | (1 << 2)
        etab[fwd ? r + 3 : r + 4] = i0 + j
      }
    }
  }
  // 3. edges that never met their reverse
  const unmatched = (first: number) => { const j = first % 3; emit(first, first - j + (j + 1) % 3) }
  for (let r = 0; r < etab.length; r += ROW) {
    if (etab[r] === 0) continue
    const st = etab[r + 2]
    if ((st & 3) === 1) unmatched(etab[r + 3])
    if (((st >> 2) & 3) === 1) unmatched(etab[r + 4])
  }
  return out.slice(0, o)
}

/** EdgesGeometry-equivalent for `geometry` (non-indexed fast path; indexed geometries use three's EdgesGeometry). */
export function buildEdges(geometry: THREE.BufferGeometry, thresholdDeg = 30): THREE.BufferGeometry {
  const p = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  if (geometry.index || !p || p.itemSize !== 3 || (p as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) {
    return new THREE.EdgesGeometry(geometry, thresholdDeg)
  }
  const segs = edgeSegments(p.array, thresholdDeg)
  if (!segs) return new THREE.EdgesGeometry(geometry, thresholdDeg)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(segs, 3))
  return g
}
