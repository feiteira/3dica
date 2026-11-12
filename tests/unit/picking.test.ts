import { describe, expect, test } from 'vitest'
import * as THREE from 'three'
import type { GroupDef, InstancePath, Transform, UiState } from '../../src/core/types'
import type { MeshEntry, ResultState } from '../../src/app/context'
import { sampleProject } from '../../src/core/sample'
import { expand, indexOccurrences, pathKey, type Occurrence } from '../../src/core/graph'
import { buildSpecs, computeWantedJobs } from '../../src/core/evalspec'
import { pickPatch, shownOperandBools } from '../../src/core/selection'
import { DEG } from '../../src/core/transform'
import { defaultUi } from '../../src/state/store'
import { chooseHit, classifyClick, isClick, isDoubleClick, Picker, type ClickInput, type PointerSample } from '../../src/view/picking'
import { displayState, Materials, type StyleInput } from '../../src/view/materials'
import { readXf } from '../../src/view/gizmo'
import { countObjectPixels, easeOutCubic, framingDistance, needsSmartFrame, presetDirection } from '../../src/view/viewport'
import { SceneSync } from '../../src/view/scene-sync'

const ui = (patch: Partial<UiState> = {}): UiState => ({ ...defaultUi(), ...patch })
const occSel = (...path: string[]) => ({ kind: 'occ' as const, path })
const at = (x: number, y: number, t: number): PointerSample => ({ x, y, t })

describe('§4.3 click classification', () => {
  test('4 px click threshold (Euclidean)', () => {
    expect(isClick(at(10, 10, 0), at(10, 10, 5))).toBe(true)
    expect(isClick(at(10, 10, 0), at(14, 10, 5))).toBe(true)
    expect(isClick(at(10, 10, 0), at(13, 13, 5))).toBe(false) // 4.24 px
    expect(isClick(at(10, 10, 0), at(15, 10, 5))).toBe(false)
  })

  test('double-click: second click within 400 ms and 4 px', () => {
    expect(isDoubleClick(null, at(0, 0, 100))).toBe(false)
    expect(isDoubleClick(at(0, 0, 0), at(2, 2, 300))).toBe(true)
    expect(isDoubleClick(at(0, 0, 0), at(0, 0, 450))).toBe(false)
    expect(isDoubleClick(at(0, 0, 0), at(6, 0, 100))).toBe(false)
  })

  const base: ClickInput = { viewMode: 'context', button: 0, down: at(100, 100, 0), up: at(101, 100, 80), gizmoDragged: false, prevClick: null, ctrl: false }

  test('plain, ctrl and double clicks pick in context mode', () => {
    expect(classifyClick(base)).toEqual({ pick: true, mods: {} })
    expect(classifyClick({ ...base, ctrl: true })).toEqual({ pick: true, mods: { ctrl: true } })
    expect(classifyClick({ ...base, prevClick: at(100, 100, -150) })).toEqual({ pick: true, mods: { double: true } })
  })

  test('no pick: isolate mode, after a gizmo drag, a drag, other buttons, no pointerdown', () => {
    expect(classifyClick({ ...base, viewMode: 'isolate' })).toEqual({ pick: false })
    expect(classifyClick({ ...base, gizmoDragged: true })).toEqual({ pick: false })
    expect(classifyClick({ ...base, up: at(110, 100, 80) })).toEqual({ pick: false })
    expect(classifyClick({ ...base, button: 2 })).toEqual({ pick: false })
    expect(classifyClick({ ...base, down: null })).toEqual({ pick: false })
  })
})

describe('§4.3 hit choice', () => {
  test('nearest hit wins; empty space is null', () => {
    expect(chooseHit([])).toBeNull()
    expect(chooseHit([{ distance: 50, path: ['i_bs'] }, { distance: 20, path: ['i_fx1', 'i_plate'] }])).toEqual(['i_fx1', 'i_plate'])
  })

  test('coincident surfaces (boolean result vs. its base operand) prefer the deeper path', () => {
    const hits = [{ distance: 100, path: ['i_fx1', 'i_w1'] }, { distance: 100.00001, path: ['i_fx1', 'i_w1', 'i_disc'] }, { distance: 130, path: ['i_bs'] }]
    expect(chooseHit(hits)).toEqual(['i_fx1', 'i_w1', 'i_disc'])
    // clearly in front: the nearer one, even if shallower
    expect(chooseHit([{ distance: 90, path: ['i_fx1', 'i_w1'] }, { distance: 100, path: ['i_fx1', 'i_w1', 'i_disc'] }])).toEqual(['i_fx1', 'i_w1'])
  })
})

describe('§4.3 viewport click → selection path arithmetic (classifyClick + chooseHit + pickPatch)', () => {
  const p = sampleProject()
  const disc = ['i_fx1', 'i_w1', 'i_disc']
  /** run one pointer click through the pure rules and apply the resulting patch */
  const click = (u: UiState, hit: InstancePath | null, input: Partial<ClickInput> = {}): UiState => {
    const d = classifyClick({ viewMode: u.viewMode, button: 0, down: at(5, 5, 0), up: at(5, 5, 50), gizmoDragged: false, prevClick: null, ctrl: false, ...input })
    if (!d.pick) return u
    const h = chooseHit(hit ? [{ distance: 10, path: hit }] : [])
    return { ...u, ...pickPatch(p, u, h, d.mods) }
  }

  test('plain click selects the outermost object at the current level', () => {
    const u = click(ui(), disc)
    expect(u.selection).toEqual(occSel('i_fx1'))
    expect(u.context).toEqual([])
    const inside = click(ui({ context: ['i_fx1'] }), disc)
    expect(inside.selection).toEqual(occSel('i_fx1', 'i_w1'))
    expect(inside.context).toEqual(['i_fx1'])
  })

  test('a hit outside the context exits it', () => {
    const u = click(ui({ context: ['i_fx2'], selection: occSel('i_fx2', 'i_b1') }), disc)
    expect(u.context).toEqual([])
    expect(u.selection).toEqual(occSel('i_fx1'))
  })

  test('ctrl+click selects the deepest leaf', () => {
    const u = click(ui(), disc, { ctrl: true })
    expect(u.selection).toEqual(occSel(...disc))
    expect(u.context).toEqual(['i_fx1', 'i_w1'])
  })

  test('empty space deselects and keeps the context', () => {
    const u = click(ui({ context: ['i_fx1'], selection: occSel('i_fx1', 'i_plate') }), null)
    expect(u.selection).toEqual({ kind: 'none' })
    expect(u.context).toEqual(['i_fx1'])
  })

  test('click then double-click drills one level into a group', () => {
    const first = click(ui(), disc)
    const second = click(first, disc, { prevClick: at(5, 5, -100) })
    expect(second.context).toEqual(['i_fx1'])
    expect(second.selection).toEqual(occSel('i_fx1', 'i_w1'))
    const third = click(second, disc, { prevClick: at(5, 5, -100) })
    expect(third.context).toEqual(['i_fx1', 'i_w1'])
    expect(third.selection).toEqual(occSel(...disc))
  })

  test('isolate mode and gizmo drags never change the selection', () => {
    const iso = ui({ viewMode: 'isolate', selection: occSel('i_bs') })
    expect(click(iso, disc)).toBe(iso)
    const u = ui({ selection: occSel('i_bs') })
    expect(click(u, disc, { gizmoDragged: true })).toBe(u)
  })
})

// ───────────────────────────── display rules (materials) ─────────────────────────────

describe('§4.4 display states', () => {
  const p = sampleProject()
  const occs = expand(p)
  const byKey = indexOccurrences(occs)
  const o = (key: string) => byKey.get(key)!
  const style = (u: UiState, extra: Partial<StyleInput> = {}): StyleInput => {
    const sel = u.selection
    return {
      isolate: false,
      selPath: sel.kind === 'occ' ? sel.path : null,
      selDef: sel.kind === 'occ' ? byKey.get(pathKey(sel.path))?.def.id ?? null : sel.kind === 'def' ? sel.def : null,
      selIsDef: sel.kind === 'def',
      context: u.context,
      ghostOthers: u.ghostOthers,
      shownOperands: shownOperandBools(occs, u),
      defAt: (k) => byKey.get(k)?.def.id,
      ...extra,
    }
  }

  test('nothing selected: normal everywhere', () => {
    expect(displayState(o('i_bs'), 'ok', style(ui()))).toEqual({ state: 'normal', outline: false })
  })

  test('selected subtree, purple linked copies, ghosted others', () => {
    const s = style(ui({ selection: occSel('i_fx1', 'i_b1') }))
    expect(displayState(o('i_fx1/i_b1'), 'ok', s)).toEqual({ state: 'selected', outline: true })
    expect(displayState(o('i_fx2/i_b1'), 'ok', s).state).toBe('ghostLinked')
    expect(displayState(o('i_fx1/i_b2'), 'ok', s).state).toBe('ghostLinked')
    expect(displayState(o('i_fx1/i_plate'), 'ok', s).state).toBe('ghost')
    expect(displayState(o('i_bs'), 'ok', s).state).toBe('ghost')
    const noGhost = style(ui({ selection: occSel('i_fx1', 'i_b1'), ghostOthers: false }))
    expect(displayState(o('i_fx2/i_b1'), 'ok', noGhost).state).toBe('linked')
    expect(displayState(o('i_bs'), 'ok', noGhost).state).toBe('normal')
  })

  test('selecting a group highlights its subtree and tints the other copy', () => {
    const s = style(ui({ selection: occSel('i_fx1'), ghostOthers: false }))
    expect(displayState(o('i_fx1/i_plate'), 'ok', s).state).toBe('selected')
    expect(displayState(o('i_fx1/i_w2'), 'ok', s).state).toBe('selected')
    expect(displayState(o('i_fx2/i_plate'), 'ok', s).state).toBe('linked')
  })

  test('entered context with nothing selected ghosts everything outside it', () => {
    const s = style(ui({ context: ['i_fx1'] }))
    expect(displayState(o('i_fx1/i_plate'), 'ok', s).state).toBe('normal')
    expect(displayState(o('i_fx2/i_plate'), 'ok', s).state).toBe('ghost')
  })

  test('boolean operands: base / cut materials; the result is ghosted while an operand is selected', () => {
    const onBool = style(ui({ selection: occSel('i_fx1', 'i_w1') }))
    expect(displayState(o('i_fx1/i_w1'), 'ok', onBool)).toEqual({ state: 'selected', outline: true })
    expect(displayState(o('i_fx1/i_w1/i_disc'), 'ok', onBool).state).toBe('operandBase')
    expect(displayState(o('i_fx1/i_w1/i_hole'), 'ok', onBool).state).toBe('operandCut')
    const onCutter = style(ui({ selection: occSel('i_fx1', 'i_w1', 'i_hole') }))
    expect(displayState(o('i_fx1/i_w1'), 'ok', onCutter).state).toBe('ghost')
    expect(displayState(o('i_fx1/i_w1/i_hole'), 'ok', onCutter)).toEqual({ state: 'selected', outline: true })
    expect(displayState(o('i_fx1/i_w1/i_disc'), 'ok', onCutter).state).toBe('operandBase')
  })

  test('union / intersect operands use operandOther', () => {
    const q = sampleProject()
    ;(q.defs.d_washer as GroupDef).op = 'union'
    const qo = expand(q)
    const qk = indexOccurrences(qo)
    const s: StyleInput = { ...style(ui()), selPath: ['i_fx1', 'i_w1'], selDef: 'd_washer', shownOperands: new Set(['i_fx1/i_w1']), defAt: (k) => qk.get(k)?.def.id }
    expect(displayState(qk.get('i_fx1/i_w1/i_hole')!, 'ok', s).state).toBe('operandOther')
  })

  test('stale / failed entries replace normal, selected and linked (the outline stays)', () => {
    const s = style(ui({ selection: occSel('i_fx1', 'i_b1'), ghostOthers: false }))
    expect(displayState(o('i_fx1/i_b1'), 'stale', s)).toEqual({ state: 'stale', outline: true })
    expect(displayState(o('i_fx2/i_b1'), 'error', s).state).toBe('error')
    const g = style(ui({ selection: occSel('i_fx1', 'i_b1') }))
    expect(displayState(o('i_bs'), 'stale', g).state).toBe('ghost')
  })

  test('isolate: plain materials', () => {
    const s = style(ui({ viewMode: 'isolate', selection: occSel('i_fx1', 'i_b1') }), { isolate: true })
    expect(displayState(o('i_fx1/i_b1'), 'ok', s)).toEqual({ state: 'normal', outline: false })
  })

  test('material cache: one material per (color, state); cutters ignore their color', () => {
    const m = new Materials()
    expect(m.get('#AABBCC', 'normal')).toBe(m.get('#aabbcc', 'normal'))
    expect(m.get('#aabbcc', 'normal')).not.toBe(m.get('#aabbcc', 'selected'))
    expect(m.get('#111111', 'operandCut')).toBe(m.get('#222222', 'operandCut'))
    const ghost = m.get('#aabbcc', 'ghost') as THREE.MeshStandardMaterial
    expect([ghost.transparent, ghost.opacity, ghost.depthWrite]).toEqual([true, 0.15, false])
    const sel = m.get('#aabbcc', 'selected') as THREE.MeshStandardMaterial
    expect(sel.emissive.getHexString()).toBe('2255aa')
    expect(sel.emissiveIntensity).toBe(0.35)
    expect((m.get('#aabbcc', 'operandBase') as THREE.MeshStandardMaterial).wireframe).toBe(true)
    m.dispose()
  })
})

// ───────────────────────────── gizmo commit ─────────────────────────────

describe('§4.9 gizmo commit xf', () => {
  const stored: Transform = { t: [1.23456789, 2, 3], r: [10, 95, 0], s: [1, 1, 1] }
  const objFrom = (xf: Transform) => {
    const o = new THREE.Object3D()
    o.rotation.order = 'ZYX'
    o.position.set(...xf.t)
    o.rotation.set(xf.r[0] * DEG, xf.r[1] * DEG, xf.r[2] * DEG, 'ZYX')
    o.scale.set(...xf.s)
    return o
  }
  const startOf = (o: THREE.Object3D) => ({ position: o.position.clone(), quaternion: o.quaternion.clone(), scale: o.scale.clone() })

  test('a translate keeps r and s verbatim and rounds t to 1e-4', () => {
    const o = objFrom(stored)
    const start = startOf(o)
    o.position.x = 5.000049
    o.position.y = -0.00001
    const { xf, changed } = readXf(o, stored, start)
    expect(changed).toBe(true)
    expect(xf.t).toEqual([5, 0, 3])
    expect(Object.is(xf.t[1], -0)).toBe(false)
    expect(xf.r).toEqual([10, 95, 0])
    expect(xf.s).toEqual([1, 1, 1])
  })

  test('a rotation is read back in ZYX degrees', () => {
    const base: Transform = { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }
    const o = objFrom(base)
    const start = startOf(o)
    o.rotation.set(20 * DEG, -30 * DEG, 45 * DEG, 'ZYX')
    const { xf } = readXf(o, base, start)
    expect(xf.r).toEqual([20, -30, 45])
    expect(xf.t).toEqual([0, 0, 0])
  })

  test('nothing moved → no commit', () => {
    const o = objFrom(stored)
    expect(readXf(o, stored, startOf(o)).changed).toBe(false)
  })
})

// ───────────────────────────── framing math ─────────────────────────────

describe('§4.4 framing helpers', () => {
  test('distance = 1.2 · radius / sin(fov / 2); cubic ease-out', () => {
    expect(framingDistance(10, 45)).toBeCloseTo(12 / Math.sin(22.5 * DEG), 9)
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 9)
    expect(easeOutCubic(2)).toBe(1)
  })

  test('presets: front looks along +Y, right along −X, top down −Z', () => {
    expect(presetDirection('front')).toEqual([0, -1, 0])
    expect(presetDirection('right')).toEqual([1, 0, 0])
    const top = presetDirection('top')
    expect(top[2]).toBeCloseTo(1, 5)
    expect(top[1]).toBeLessThan(0)
    expect(Math.hypot(...top)).toBeCloseTo(1, 12)
  })

  test('smart framing: outside the frustum or < 5% of the viewport height', () => {
    const box = (x0: number, y0: number, x1: number, y1: number) => [x0, x1].flatMap((x) => [y0, y1].map((y) => ({ x, y, z: 0.5 })))
    expect(needsSmartFrame(box(-0.5, -0.5, 0.5, 0.5))).toBe(false)
    expect(needsSmartFrame(box(0.5, -0.5, 1.2, 0.5))).toBe(true)
    expect(needsSmartFrame(box(0, 0, 0.02, 0.02))).toBe(true)
    expect(needsSmartFrame(box(0, 0, 0.5, 0.09))).toBe(true) // 4.5% of the height, however wide
    expect(needsSmartFrame(box(0, 0, 0.02, 0.11))).toBe(false) // 5.5% of the height
    expect(needsSmartFrame([{ x: 0, y: 0, z: 1.5 }])).toBe(true) // behind the far plane / camera
  })

  test('object pixels: channels differing by more than 12 from the background', () => {
    const px = new Uint8Array([31, 35, 41, 255, 43, 35, 41, 255, 44, 35, 41, 255, 31, 35, 60, 255])
    expect(countObjectPixels(px, [31, 35, 41])).toBe(2)
  })
})

// ───────────────────────────── scene sync (§5.6), headless ─────────────────────────────

describe('§5.6 scene sync', () => {
  const cubeEntry = (size: number): MeshEntry => {
    const g = new THREE.BoxGeometry(size, size, size).toNonIndexed()
    g.computeBoundingSphere()
    return { geometries: [g], baked: [null], tris: 12, bbox: new THREE.Box3(new THREE.Vector3(-size / 2, -size / 2, -size / 2), new THREE.Vector3(size / 2, size / 2, size / 2)), ms: 1, warnings: [] }
  }

  const setup = (u: UiState = ui()) => {
    const p = sampleProject()
    const occs = expand(p)
    const specs = buildSpecs(p)
    const shown = shownOperandBools(occs, u)
    const wanted = computeWantedJobs(p, specs, occs, u, shown)
    const results = new Map<string, ResultState>()
    for (const j of wanted.jobs) results.set(j.resultKey, { state: 'ready', entry: cubeEntry(2) })
    const sync = new SceneSync(new Materials(), { name: 'sceneRoot' })
    const byKey = indexOccurrences(occs)
    const style: StyleInput = {
      isolate: false, selPath: u.selection.kind === 'occ' ? u.selection.path : null, selDef: null, selIsDef: false,
      context: u.context, ghostOthers: u.ghostOthers, shownOperands: shown, defAt: (k) => byKey.get(k)?.def.id,
    }
    const run = (over: { occurrences?: Occurrence[]; resultKeyOf?: Map<string, string>; skip?: string } = {}) => sync.sync({
      project: p, occurrences: over.occurrences ?? occs, resultKeyOf: over.resultKeyOf ?? wanted.resultKeyOf,
      lookup: (k) => results.get(k), style, shownOperands: shown, evalPaused: false, skipInstanceId: over.skip ?? null,
    })
    return { p, occs, wanted, results, sync, run }
  }
  const keys = (sync: SceneSync) => { const s = new Set<string>(); sync.displayedKeys(s); return s }

  test('hierarchy mirrors the instances; ZYX rotation; operands hidden; shared geometry per key', () => {
    const { sync, run, occs } = setup()
    run()
    expect(sync.root.children.length).toBe(3)
    const fx2 = sync.group('i_fx2')!
    expect(fx2.rotation.order).toBe('ZYX')
    expect(fx2.rotation.z).toBeCloseTo(15 * DEG, 12)
    expect(fx2.position.x).toBe(75)
    expect(sync.group('i_fx2/i_b1')!.parent).toBe(fx2)
    expect(sync.group('i_fx1/i_w1/i_disc')!.visible).toBe(false)
    expect(sync.group('i_fx1/i_w1/i_disc')!.parent).toBe(sync.group('i_fx1/i_w1'))
    expect(sync.group('i_fx1')!.userData).toMatchObject({ path: ['i_fx1'], instanceId: 'i_fx1', defId: 'd_fixture', role: 'group' })
    // 2 fixtures × (plate + 4 washers + 4 bolts) + Bolt sizes
    const meshes = sync.visibleMeshes()
    expect(meshes.length).toBe(19)
    expect(meshes.every((m) => Array.isArray(m.userData.path))).toBe(true)
    expect(keys(sync).size).toBe(4)
    const bolts = meshes.filter((m) => (m.userData.path as string[]).at(-1)?.startsWith('i_b') && m.userData.path.length === 2)
    expect(new Set(bolts.map((m) => m.geometry)).size).toBe(1)
    expect([...sync.groupsOfInstance('i_b1')].length).toBe(2)
    expect(occs.length).toBeGreaterThan(19)
  })

  test('pending → last good shown stale; failed → error; no last good → nothing', () => {
    const { sync, run, wanted, results } = setup()
    run()
    const boltKey = wanted.resultKeyOf.get('i_fx1/i_b1')!
    // the Bolt gets a new key (code edit) that is still pending
    const next = new Map(wanted.resultKeyOf)
    for (const [k, v] of next) if (v === boltKey) next.set(k, 'k_new')
    results.set('k_new', { state: 'pending' })
    run({ resultKeyOf: next })
    const boltMesh = () => sync.visibleMeshes().find((m) => pathKey(m.userData.path) === 'i_fx1/i_b1')!
    expect(boltMesh()).toBeDefined()
    expect((boltMesh().material as THREE.Material).opacity).toBe(0.6)
    expect(keys(sync).has(boltKey)).toBe(true)
    results.set('k_new', { state: 'failed', error: { kind: 'runtime', def: 'd_bolt', defName: 'Bolt', message: 'boom', trace: ['Bolt'] } })
    run({ resultKeyOf: next })
    expect((boltMesh().material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0.4)
    expect(sync.visibleMeshes().length).toBe(19) // never blank while typing
    // a brand-new occurrence with nothing evaluated yet shows nothing
    const fresh = setup()
    for (const k of fresh.results.keys()) fresh.results.set(k, { state: 'pending' })
    fresh.run()
    expect(fresh.sync.visibleMeshes().length).toBe(0)
  })

  test('the dragged instance keeps its live transform; removed occurrences are detached', () => {
    const { sync, run, occs } = setup()
    run()
    const g = sync.group('i_bs')!
    g.position.x = 99
    run({ skip: 'i_bs' })
    expect(g.position.x).toBe(99)
    run()
    expect(g.position.x).toBe(-24)
    run({ occurrences: occs.filter((o) => o.path[0] !== 'i_bs') })
    expect(g.parent).toBeNull()
    expect(sync.group('i_bs')).toBeUndefined()
  })

  test('occurrence boxes: world / parent space, a boolean result only, none groups = union of children', () => {
    const { sync, run } = setup()
    run()
    // Bolt sizes at (-24, -45, 0), a 2 mm test cube
    expect(sync.box(['i_bs'], 'world')).toEqual({ min: [-25, -46, -1], max: [-23, -44, 1] })
    // i_fx1/i_b1 sits at (-23, -13, 5) inside Fixture A (identity)
    expect(sync.box(['i_fx1', 'i_b1'], 'parent')).toEqual({ min: [-24, -14, 4], max: [-22, -12, 6] })
    const fx1 = sync.box(['i_fx1'], 'parent')!
    expect(fx1.min).toEqual([-24, -14, -1])
    expect(fx1.max).toEqual([24, 14, 6])
    const w = sync.box(['i_fx1', 'i_w1'], 'world')!
    expect(w.min).toEqual([-24, -14, 3])
    const fx2 = sync.box(['i_fx2'], 'world')!
    expect(fx2.min[0]).toBeGreaterThan(40)
    expect(sync.boxAll()!.min[1]).toBe(-46)
  })
})

// ───────────────────────────── regressions ─────────────────────────────

describe('Picker: double-click through a gizmo handle (§4.3)', () => {
  /** a minimal canvas stand-in: listeners + a 100×100 rect at the origin */
  const fakeDom = () => {
    const ls = new Map<string, ((e: unknown) => void)[]>()
    return {
      addEventListener: (t: string, cb: (e: unknown) => void) => { ls.set(t, [...(ls.get(t) ?? []), cb]) },
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      fire: (t: string, e: object) => { for (const cb of ls.get(t) ?? []) cb({ isPrimary: true, button: 0, ctrlKey: false, metaKey: false, ...e }) },
    }
  }
  test('both clicks land on the selected group\'s gizmo: the second still counts as a double-click', () => {
    const dom = fakeDom()
    const picks: { double?: boolean }[] = []
    const picker = new Picker({
      dom: dom as unknown as HTMLElement, camera: new THREE.PerspectiveCamera(), viewMode: () => 'context', pickables: () => [],
      gizmoDragging: () => false, gizmoMoved: () => false, onPick: (_hit, mods) => picks.push(mods),
    })
    const click = (t: number) => {
      dom.fire('pointerdown', { clientX: 50, clientY: 50, timeStamp: t })
      picker.notifyGizmoDrag() // the press grabbed a gizmo handle (TransformControls dragging-changed → true)…
      dom.fire('pointerup', { clientX: 50, clientY: 50, timeStamp: t + 40 }) // …and released without moving
    }
    click(0)
    expect(picks).toEqual([]) // one motionless press on the gizmo does not re-pick
    click(150)
    expect(picks).toEqual([{ double: true }]) // the pair is a double-click → pickPatch enters the group
    // a lone gizmo press much later is again only a first click
    click(5000)
    expect(picks).toHaveLength(1)
  })
})

describe('nested booleans: an inner result is ghosted when its operand is selected (§4.4)', () => {
  test('Cut(subtract) > [Blob(union) > [Cube, Cube], Rod]: selecting a Cube ghosts both results', () => {
    const q = sampleProject()
    const cube = { id: 'd_cube', name: 'Cube', kind: 'code' as const, code: 'return cuboid()', params: [] }
    q.defs.d_cube = cube
    q.defs.d_blob = { id: 'd_blob', name: 'Blob', kind: 'group', op: 'union', children: [
      { id: 'i_a', def: 'd_cube', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } },
      { id: 'i_b', def: 'd_cube', xf: { t: [1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } }] }
    q.defs.d_cut = { id: 'd_cut', name: 'Cut', kind: 'group', op: 'subtract', children: [
      { id: 'i_u', def: 'd_blob', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } },
      { id: 'i_r', def: 'd_cube', xf: { t: [0, 0, 1], r: [0, 0, 0], s: [1, 1, 1] } }] }
    ;(q.defs[q.root] as GroupDef).children.push({ id: 'i_s', def: 'd_cut', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } })
    const qo = expand(q)
    const qk = indexOccurrences(qo)
    const u = ui({ selection: occSel('i_s', 'i_u', 'i_a'), context: ['i_s', 'i_u'] })
    const s: StyleInput = {
      isolate: false, selPath: ['i_s', 'i_u', 'i_a'], selDef: 'd_cube', selIsDef: false, context: u.context, ghostOthers: true,
      shownOperands: shownOperandBools(qo, u), defAt: (k) => qk.get(k)?.def.id,
    }
    expect(displayState(qk.get('i_s')!, 'ok', s).state).toBe('ghost') // the outer result
    expect(displayState(qk.get('i_s/i_u')!, 'ok', s).state).toBe('ghost') // the inner result (was a 0.35 wireframe)
    expect(displayState(qk.get('i_s/i_u/i_a')!, 'ok', s)).toEqual({ state: 'selected', outline: true })
    expect(displayState(qk.get('i_s/i_u/i_b')!, 'ok', s).state).toBe('operandOther')
    // selecting the inner boolean itself still highlights it as the selection
    const sb: StyleInput = { ...s, selPath: ['i_s', 'i_u'], selDef: 'd_blob' }
    expect(displayState(qk.get('i_s/i_u')!, 'ok', sb)).toEqual({ state: 'selected', outline: true })
  })
})

describe('scene sync: provisional (pending) content is known, so isolate can re-frame on the real result (§4.4)', () => {
  test('hasPending is true while a shown occurrence waits for its result, false once it is ready or failed', () => {
    const p = sampleProject()
    const occs = expand(p).filter((o) => o.key === 'i_bs')
    const specs = buildSpecs(p)
    const u = ui()
    const wanted = computeWantedJobs(p, specs, occs, u, new Set())
    const key = wanted.resultKeyOf.get('i_bs')!
    const sync = new SceneSync(new Materials(), { name: 'isolateRoot', lastGoodSameDef: true })
    const g = new THREE.BoxGeometry(2, 2, 2).toNonIndexed()
    const entry: MeshEntry = { geometries: [g], baked: [null], tris: 12, bbox: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)), ms: 1, warnings: [] }
    const style: StyleInput = { isolate: true, selPath: null, selDef: null, selIsDef: false, context: [], ghostOthers: true, shownOperands: new Set(), defAt: () => undefined }
    let state: ResultState | undefined = { state: 'pending' }
    const run = (k = key) => sync.sync({ project: p, occurrences: occs, resultKeyOf: new Map([['i_bs', k]]), lookup: () => state, style, shownOperands: new Set(), evalPaused: false, skipInstanceId: null })
    run()
    expect(sync.hasPending()).toBe(true)
    expect(sync.boxAll()).toBeNull()
    state = { state: 'ready', entry }
    run()
    expect(sync.hasPending()).toBe(false)
    // a new key for the same def: the last good mesh is drawn (a box exists) but it is provisional
    state = { state: 'pending' }
    run('k-other')
    expect(sync.boxAll()).not.toBeNull()
    expect(sync.hasPending()).toBe(true)
    state = { state: 'failed', error: { kind: 'runtime', def: 'd_boltsizes', defName: 'Bolt sizes', message: 'x', trace: ['Bolt sizes'] } }
    run('k-other')
    expect(sync.hasPending()).toBe(false)
  })
})
