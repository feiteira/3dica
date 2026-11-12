// The selection outline (§4.4): eval/edges.ts must draw the same segments as three's EdgesGeometry(g, 30), much
// faster, and huge meshes get no outline at all (the selected tint still shows) so selecting them never freezes the UI.
import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import { createEngine } from '../../src/eval/engine'
import { buildSpecs, makeJob } from '../../src/core/evalspec'
import { sampleProject } from '../../src/core/sample'
import { buildEdges, edgeSegments } from '../../src/eval/edges'
import { ensureEdges, OUTLINE_MAX_TRIS, toMeshEntry } from '../../src/eval/mesh-cache'

/** segments as a sorted list of rounded, undirected endpoint pairs */
const segs = (a: ArrayLike<number>) => {
  const out: string[] = []
  for (let i = 0; i < a.length; i += 6) {
    const p = [a[i], a[i + 1], a[i + 2]].map((x) => Math.round(x * 1e4)).join(',')
    const q = [a[i + 3], a[i + 4], a[i + 5]].map((x) => Math.round(x * 1e4)).join(',')
    out.push(p < q ? p + '|' + q : q + '|' + p)
  }
  return out.sort()
}
const geom = (positions: Float32Array) => {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return g
}

describe('selection outline edges', () => {
  test('the same segments as THREE.EdgesGeometry on every sample mesh (CSG results with T-junctions included)', () => {
    const e = createEngine()
    const specs = buildSpecs(sampleProject())
    let meshes = 0
    for (const id of ['d_plate', 'd_washer', 'd_bolt', 'd_boltsizes', 'd_disc', 'd_hole']) {
      for (const m of e.run(specs.jobFor(id)!).meshes) {
        const ref = new THREE.EdgesGeometry(geom(m.positions), 30).getAttribute('position').array
        expect(segs(edgeSegments(m.positions, 30)!)).toEqual(segs(ref))
        meshes++
      }
    }
    expect(meshes).toBeGreaterThan(10)
    // other thresholds too
    const box = new THREE.BoxGeometry(2, 3, 4, 2, 2, 2).toNonIndexed()
    const p = box.getAttribute('position').array as Float32Array
    for (const deg of [1, 30, 89]) expect(segs(edgeSegments(p, deg)!)).toEqual(segs(new THREE.EdgesGeometry(geom(p), deg).getAttribute('position').array))
  })

  test('several times faster than EdgesGeometry on a big mesh', () => {
    const e = createEngine()
    const r = e.run(makeJob({ kind: 'code', defKey: 'k-edges', def: 'd_x', name: 'X', code: 'return sphere({ segments: 360 })', paramDefs: [], deps: {} }))
    const pos = r.meshes[0].positions
    edgeSegments(pos, 30) // warm up
    let t = performance.now()
    edgeSegments(pos, 30)
    const fast = performance.now() - t
    t = performance.now()
    new THREE.EdgesGeometry(geom(pos), 30)
    const three = performance.now() - t
    expect(fast * 1.5).toBeLessThan(three)
  })

  test('no outline above OUTLINE_MAX_TRIS; indexed geometries fall back to EdgesGeometry', () => {
    const huge = toMeshEntry([{ positions: new Float32Array(9), normals: new Float32Array(9), bbox: [[0, 0, 0], [1, 1, 0]] }], OUTLINE_MAX_TRIS + 1, 1, [])
    expect(ensureEdges(huge)).toEqual([])
    const indexed = new THREE.BoxGeometry(1, 1, 1)
    expect(buildEdges(indexed, 30)).toBeInstanceOf(THREE.EdgesGeometry)
  })
})
