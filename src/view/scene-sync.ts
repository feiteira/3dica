// §5.6 scene sync. One SceneSync per root (the scene root, and the separate isolateRoot of §4.4).
// The Object3D hierarchy mirrors the instance hierarchy exactly, so a gizmo's local TRS *is* Instance.xf.
import * as THREE from 'three'
import type { Id, InstancePath, Mat4, Project } from '../core/types'
import type { Box, MeshEntry, Occurrence, ResultState } from '../app/context'
import { pathKey } from '../core/graph'
import { isOccurrenceShown } from '../core/evalspec'
import { occurrenceColor } from '../core/colors'
import { DEG, mul, toMatrix, transformBox, unionBoxes } from '../core/transform'
import { displayState, type EntryStatus, type Materials, type StyleInput } from './materials'
import { ensureEdges } from '../eval/mesh-cache'

/** Group.userData of an occurrence (§5.6); `xf` is the instance's stored transform (gizmo commit reads it). */
export interface OccUserData {
  path: InstancePath
  instanceId: Id
  defId: Id
  role: Occurrence['role']
  xf: Occurrence['instance']['xf']
}

interface LastGood { key: string; entry: MeshEntry; defId: Id }

interface Node {
  occ: Occurrence
  group: THREE.Group
  /** holds this occurrence's own meshes and outlines (named 'result' for booleans, 'mesh' for code) */
  content: THREE.Group
  /** entry currently drawn (may be the last good one) and its result key */
  shown: MeshEntry | null
  shownKey: string | null
  status: EntryStatus
  /** its wanted result is not there yet (queued / in flight / unknown): what it draws (if anything) is provisional */
  pending: boolean
  lastGood: LastGood | null
  meshes: THREE.Mesh[]
  outlines: THREE.LineSegments[]
  /** keys of child occurrences (rebuilt every sync) */
  children: string[]
}

export interface SyncInput {
  project: Project
  occurrences: Occurrence[]
  /** occurrence key → resultKey (RenderState.wanted.resultKeyOf) */
  resultKeyOf: Map<string, string>
  lookup: (resultKey: string) => ResultState | undefined
  style: StyleInput
  /** operand display for this root (scene: RenderState.shownOperands; isolate: empty) */
  shownOperands: ReadonlySet<string>
  evalPaused: boolean
  /** skip transform updates of every group with this instance id (the gizmo is dragging it) */
  skipInstanceId: Id | null
}

const noRaycast = () => {}

export class SceneSync {
  readonly root: THREE.Group
  private readonly materials: Materials
  /** isolate root: a last-good entry is only reused for the same def (the '~iso' key is reused across targets) */
  private readonly lastGoodSameDef: boolean
  private nodes = new Map<string, Node>()
  private byInstance = new Map<Id, Set<THREE.Group>>()

  constructor(materials: Materials, opts: { name: string; lastGoodSameDef?: boolean }) {
    this.materials = materials
    this.lastGoodSameDef = !!opts.lastGoodSameDef
    this.root = new THREE.Group()
    this.root.name = opts.name
  }

  sync(input: SyncInput): void {
    const { occurrences } = input
    const present = new Set<string>()
    for (const o of occurrences) present.add(o.key)
    for (const [key, node] of this.nodes) if (!present.has(key)) this.removeNode(key, node)

    const byKey = new Map<string, Occurrence>()
    for (const o of occurrences) byKey.set(o.key, o)
    for (const node of this.nodes.values()) node.children.length = 0

    for (const occ of occurrences) {
      let node = this.nodes.get(occ.key)
      if (!node) node = this.createNode(occ)
      const prevInstance = node.occ.instance.id
      node.occ = occ
      if (prevInstance !== occ.instance.id) this.reindex(node, prevInstance)

      // hierarchy
      const parent = occ.parentKey === '' ? this.root : this.nodes.get(occ.parentKey)?.group ?? this.root
      if (node.group.parent !== parent) parent.add(node.group)
      if (occ.parentKey !== '') this.nodes.get(occ.parentKey)?.children.push(occ.key)

      // transform (skipped for the instance being dragged, so linked copies keep their live preview)
      const g = node.group
      const ud: OccUserData = { path: occ.path, instanceId: occ.instance.id, defId: occ.def.id, role: occ.role, xf: occ.instance.xf }
      g.userData = ud
      g.name = occ.instance.name ?? occ.def.name
      if (occ.instance.id !== input.skipInstanceId) {
        const { t, r, s } = occ.instance.xf
        g.position.set(t[0], t[1], t[2])
        g.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG, 'ZYX')
        g.scale.set(s[0], s[1], s[2])
      }
      g.visible = !occ.instance.hidden && (occ.operandOf === undefined || input.shownOperands.has(occ.operandOf))

      this.syncContent(node, input, byKey)
    }
  }

  /** decide which entry this occurrence draws (§5.6 last-good rule) and update its meshes and materials */
  private syncContent(node: Node, input: SyncInput, byKey: Map<string, Occurrence>): void {
    const occ = node.occ
    let entry: MeshEntry | null = null
    let entryKey: string | null = null
    let status: EntryStatus = 'ok'
    const usableLastGood = node.lastGood && (!this.lastGoodSameDef || node.lastGood.defId === occ.def.id) ? node.lastGood : null
    const key = occ.role === 'group' ? undefined : input.resultKeyOf.get(occ.key)
    node.pending = false
    if (key !== undefined) {
      const r = input.lookup(key)
      node.pending = r === undefined || r.state === 'pending'
      if (r?.state === 'ready') {
        entry = r.entry
        entryKey = key
        node.lastGood = { key, entry, defId: occ.def.id }
      } else if (usableLastGood) {
        entry = usableLastGood.entry
        entryKey = usableLastGood.key
        status = r?.state === 'failed' ? 'error' : 'stale'
      }
    } else if (occ.role !== 'group' && !input.evalPaused && usableLastGood
      && isOccurrenceShown(occ, byKey, input.shownOperands)) {
      // shown but no job: its def has a spec error (cycle / unknown part) — keep the last good mesh, as failed
      entry = usableLastGood.entry
      entryKey = usableLastGood.key
      status = 'error'
    } else {
      node.lastGood = null
    }

    if (entry !== node.shown) this.rebuildMeshes(node, entry)
    node.shownKey = entry ? entryKey : null
    node.status = status
    if (!entry) return

    const ds = displayState(occ, status, input.style)
    for (let i = 0; i < node.meshes.length; i++) {
      const baked = entry.baked[i]
      const color = occurrenceColor(input.project, occ, baked ? '#' + baked.getHexString() : null)
      node.meshes[i].material = this.materials.get(color, ds.state)
    }
    this.setOutline(node, ds.outline)
  }

  private rebuildMeshes(node: Node, entry: MeshEntry | null): void {
    for (const m of node.meshes) node.content.remove(m)
    for (const l of node.outlines) node.content.remove(l)
    node.meshes = []
    node.outlines = []
    node.shown = entry
    if (!entry) return
    entry.geometries.forEach((geometry, i) => {
      const mesh = new THREE.Mesh(geometry, this.materials.get('#9aa4b2', 'normal'))
      mesh.userData = { path: node.occ.path, occKey: node.occ.key, index: i }
      mesh.matrixAutoUpdate = false
      node.content.add(mesh)
      node.meshes.push(mesh)
    })
  }

  private setOutline(node: Node, on: boolean): void {
    const entry = node.shown
    if (!on || !entry) {
      for (const l of node.outlines) l.visible = false
      return
    }
    if (node.outlines.length === 0 && entry.geometries.length > 0) {
      for (const eg of ensureEdges(entry)) {
        const line = new THREE.LineSegments(eg, this.materials.outline)
        line.userData = { outline: true }
        line.raycast = noRaycast
        line.matrixAutoUpdate = false
        node.content.add(line)
        node.outlines.push(line)
      }
    }
    for (const l of node.outlines) l.visible = true
  }

  private createNode(occ: Occurrence): Node {
    const group = new THREE.Group()
    group.rotation.order = 'ZYX'
    const content = new THREE.Group()
    content.name = occ.role === 'bool' ? 'result' : 'mesh'
    group.add(content)
    const node: Node = { occ, group, content, shown: null, shownKey: null, status: 'ok', pending: false, lastGood: null, meshes: [], outlines: [], children: [] }
    this.nodes.set(occ.key, node)
    this.index(occ.instance.id, group)
    return node
  }

  private index(instanceId: Id, group: THREE.Group): void {
    let s = this.byInstance.get(instanceId)
    if (!s) this.byInstance.set(instanceId, (s = new Set()))
    s.add(group)
  }

  private unindex(instanceId: Id, group: THREE.Group): void {
    const s = this.byInstance.get(instanceId)
    if (!s) return
    s.delete(group)
    if (s.size === 0) this.byInstance.delete(instanceId)
  }

  private reindex(node: Node, prevInstanceId: Id): void {
    this.unindex(prevInstanceId, node.group)
    this.index(node.occ.instance.id, node.group)
  }

  /** Removed keys are detached. Geometries are not disposed here; the mesh cache owns them (§5.6). */
  private removeNode(key: string, node: Node): void {
    node.group.removeFromParent()
    this.unindex(node.occ.instance.id, node.group)
    this.nodes.delete(key)
  }

  /** Drop every node (leaving isolate). */
  clear(): void {
    for (const [key, node] of this.nodes) this.removeNode(key, node)
  }

  isEmpty(): boolean { return this.nodes.size === 0 }

  /** Some visible occurrence still waits for its result (it draws a stale last-good entry, or nothing yet). */
  hasPending(): boolean {
    for (const n of this.nodes.values()) if (n.pending && n.group.visible) return true
    return false
  }

  /** Result keys this root currently draws, including last-good fallbacks (for client.setInUse). */
  displayedKeys(out: Set<string>): void {
    for (const n of this.nodes.values()) if (n.shownKey) out.add(n.shownKey)
  }

  group(key: string): THREE.Group | undefined { return this.nodes.get(key)?.group }

  occurrence(key: string): Occurrence | undefined { return this.nodes.get(key)?.occ }

  /** Every occurrence Group of this instance id (the linked copies). */
  groupsOfInstance(instanceId: Id): Iterable<THREE.Group> { return this.byInstance.get(instanceId) ?? [] }

  /** Visible meshes of this root (respects every ancestor's visibility). Outlines and helpers excluded. */
  visibleMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = []
    this.root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh) })
    return out
  }

  /**
   * Evaluated bbox of an occurrence: the union of what it currently draws (last-good included; a boolean's result
   * only; hidden descendants excluded; a 'none' group = union of its visible children). 'world' uses occurrence.world;
   * 'parent' is relative to the occurrence's parent frame (includes its own xf). null when nothing is drawn.
   */
  box(path: InstancePath, space: 'world' | 'parent'): Box | null {
    const node = this.nodes.get(pathKey(path))
    if (!node || node.occ.instance.hidden) return null
    const start = space === 'world' ? node.occ.world : toMatrix(node.occ.instance.xf)
    const boxes: Box[] = []
    const visit = (n: Node, m: Mat4) => {
      if (n.shown && !n.shown.bbox.isEmpty()) {
        const b = n.shown.bbox
        boxes.push(transformBox(m, { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] }))
      }
      if (n.occ.role !== 'group') return // a code leaf has no children; a boolean shows its result only
      for (const ck of n.children) {
        const c = this.nodes.get(ck)
        if (!c || !c.group.visible) continue
        visit(c, space === 'world' ? c.occ.world : mul(m, toMatrix(c.occ.instance.xf)))
      }
    }
    visit(node, start)
    return unionBoxes(boxes)
  }

  /** Union of the world bboxes of every top-level visible occurrence. */
  boxAll(): Box | null {
    const boxes: (Box | null)[] = []
    for (const n of this.nodes.values()) if (n.occ.parentKey === '' && n.group.visible) boxes.push(this.box(n.occ.path, 'world'))
    return unionBoxes(boxes)
  }
}
