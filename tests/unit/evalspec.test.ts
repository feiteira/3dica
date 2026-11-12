import { describe, expect, test } from 'vitest'
import type { CodeDef, GroupDef, Project, UiState } from '../../src/core/types'
import { sampleProject } from '../../src/core/sample'
import { expand } from '../../src/core/graph'
import { defaultUi } from '../../src/state/store'
import {
  buildSpecs, computeDefStates, computeRowStatuses, computeStlItems, computeWantedJobs, CycleError, stlFileName,
  type ResultLookup, type CodeSpec, type GroupSpec,
} from '../../src/core/evalspec'
import { shownOperandBools } from '../../src/core/selection'
import { renameDef, setColor, setInstanceLabel, setTransform } from '../../src/core/ops'

const keyOf = (p: Project, defId: string, params?: Record<string, number>) => buildSpecs(p).jobFor(defId, params)!.resultKey
const defKeyOf = (p: Project, defId: string) => buildSpecs(p).specOf(defId)!.defKey
const ui = (patch: Partial<UiState> = {}): UiState => ({ ...defaultUi(), ...patch })
const wantedFor = (p: Project, u: UiState = ui()) => {
  const specs = buildSpecs(p)
  const occs = expand(p)
  return { specs, occs, wanted: computeWantedJobs(p, specs, occs, u, shownOperandBools(occs, u)) }
}

describe('keys', () => {
  test('stable across two builds', () => {
    const a = buildSpecs(sampleProject()), b = buildSpecs(sampleProject())
    for (const id of ['d_bolt', 'd_plate', 'd_washer', 'd_fixture', 'd_boltsizes', 'd_disc', 'd_hole']) {
      expect(a.specOf(id)!.defKey).toBe(b.specOf(id)!.defKey)
      expect(a.jobFor(id)!.resultKey).toBe(b.jobFor(id)!.resultKey)
    }
    expect(a.specErrors.size).toBe(0)
  })

  test('linked occurrences share a resultKey; an override changes it', () => {
    const p = sampleProject()
    const { wanted } = wantedFor(p)
    const k1 = wanted.resultKeyOf.get('i_fx1/i_b1')!
    expect(wanted.resultKeyOf.get('i_fx2/i_b3')).toBe(k1)
    expect(k1).toBe(keyOf(p, 'd_bolt'))
    expect(keyOf(p, 'd_bolt', { length: 20 })).not.toBe(k1)
    expect(keyOf(p, 'd_bolt', { length: 12 })).toBe(k1) // overriding with the default is the same result
    expect(keyOf(p, 'd_bolt', { bogus: 1 })).toBe(k1) // unknown keys are ignored
  })

  test('editing Bolt code changes Bolt and "Bolt sizes" (Merkle) but not Plate', () => {
    const p = sampleProject()
    const before = { bolt: defKeyOf(p, 'd_bolt'), bs: defKeyOf(p, 'd_boltsizes'), plate: defKeyOf(p, 'd_plate'), fx: defKeyOf(p, 'd_fixture') }
    ;(p.defs.d_bolt as CodeDef).code = (p.defs.d_bolt as CodeDef).code.replace('segments: 6', 'segments: 8')
    expect(defKeyOf(p, 'd_bolt')).not.toBe(before.bolt)
    expect(defKeyOf(p, 'd_boltsizes')).not.toBe(before.bs)
    expect(defKeyOf(p, 'd_plate')).toBe(before.plate)
    expect(defKeyOf(p, 'd_fixture')).not.toBe(before.fx)
  })

  test('param defaults are part of the code key', () => {
    const p = sampleProject()
    const before = defKeyOf(p, 'd_bolt')
    ;(p.defs.d_bolt as CodeDef).params[0].default = 13
    expect(defKeyOf(p, 'd_bolt')).not.toBe(before)
  })

  test('a color, label or name change leaves keys unchanged', () => {
    const p = sampleProject()
    const ids = ['d_bolt', 'd_plate', 'd_washer', 'd_fixture', 'd_boltsizes']
    const before = ids.map((id) => keyOf(p, id))
    setColor(p, { def: 'd_washer' }, '#000000')
    setColor(p, { instance: 'i_hole' }, '#ffffff')
    setColor(p, { instance: 'i_b1' }, '#ffffff')
    setInstanceLabel(p, 'i_w1', 'Left washer')
    renameDef(p, 'd_plate', 'Base plate')
    renameDef(p, 'd_washer', 'Ring')
    expect(ids.map((id) => keyOf(p, id))).toEqual(before)
  })

  test('renaming a part() dependency rewrites the code → key changes only through the rewrite', () => {
    const p = sampleProject()
    const before = defKeyOf(p, 'd_boltsizes')
    renameDef(p, 'd_bolt', 'Screw')
    expect(defKeyOf(p, 'd_boltsizes')).not.toBe(before) // code text changed ('Screw')
    expect(buildSpecs(p).specErrors.size).toBe(0)
  })

  test('moving the Washer\'s Hole changes the Washer defKey', () => {
    const p = sampleProject()
    const before = defKeyOf(p, 'd_washer')
    setTransform(p, 'i_hole', { t: [1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] })
    expect(defKeyOf(p, 'd_washer')).not.toBe(before)
  })

  test('hidden children are excluded from group specs', () => {
    const p = sampleProject()
    const before = buildSpecs(p).specOf('d_washer') as GroupSpec
    expect(before.children.length).toBe(2)
    ;(p.defs.d_washer as GroupDef).children[1].hidden = true
    const after = buildSpecs(p).specOf('d_washer') as GroupSpec
    expect(after.children.length).toBe(1)
    expect(after.defKey).not.toBe(before.defKey)
  })

  test('code specs carry their deps; group children carry resolved params and matrices', () => {
    const s = buildSpecs(sampleProject())
    const bs = s.specOf('d_boltsizes') as CodeSpec
    expect(Object.keys(bs.deps)).toEqual(['Bolt'])
    expect(bs.deps.Bolt.def).toBe('d_bolt')
    const fx = s.specOf('d_fixture') as GroupSpec
    expect(fx.children.length).toBe(9)
    expect(fx.children[0].params).toEqual({ width: 60, depth: 40, thickness: 4, holeDiameter: 5.5, inset: 7 })
    expect(fx.children[1].matrix[12]).toBe(-23)
    expect(s.jobFor('d_fixture')!.params).toEqual({})
  })
})

describe('spec errors', () => {
  test('a part() cycle goes into specErrors and produces no job', () => {
    const p = sampleProject()
    ;(p.defs.d_bolt as CodeDef).code = "const x = 1\nreturn part('Bolt sizes')"
    const s = buildSpecs(p)
    const e = s.specErrors.get('d_bolt')!
    expect(e.kind).toBe('cycle')
    expect(e.message).toMatch(/^Cycle: (Bolt → Bolt sizes → Bolt|Bolt sizes → Bolt → Bolt sizes)$/)
    expect(e.line).toBe(2)
    expect(s.specErrors.get('d_boltsizes')!.kind).toBe('cycle')
    expect(s.jobFor('d_bolt')).toBeUndefined()
    expect(s.jobFor('d_boltsizes')).toBeUndefined()
    // dependents get a dependency error and no job; unrelated defs are fine
    expect(s.specErrors.get('d_fixture')!.kind).toBe('dependency')
    expect(s.specErrors.get('d_fixture')!.message).toMatch(/^depends on "/)
    expect(s.jobFor('d_fixture')).toBeUndefined()
    expect(s.jobFor('d_plate')).toBeDefined()
    expect(s.jobFor('d_washer')).toBeDefined()
    expect(s.specErrors.has('d_root')).toBe(false)
    const { wanted } = wantedFor(p)
    expect(wanted.jobsOfDef.has('d_bolt')).toBe(false)
    expect(wanted.jobsOfDef.has('d_plate')).toBe(true)
  })

  test('CycleError carries ids and names', () => {
    const e = new CycleError(['d_a', 'd_b', 'd_a'], ['A', 'B', 'A'])
    expect(e.message).toBe('Cycle: A → B → A')
    expect(e).toBeInstanceOf(Error)
  })

  test('an unknown name goes into specErrors and produces no job', () => {
    const p = sampleProject()
    ;(p.defs.d_boltsizes as CodeDef).code = "\n\nreturn part('Nut')"
    const s = buildSpecs(p)
    const e = s.specErrors.get('d_boltsizes')!
    expect(e).toMatchObject({ kind: 'dependency', def: 'd_boltsizes', message: 'Unknown part "Nut" — no definition with that name', line: 3, trace: ['Bolt sizes'] })
    expect(s.jobFor('d_boltsizes')).toBeUndefined()
    expect(s.specErrors.size).toBe(1)
  })
})

describe('wanted jobs', () => {
  test('the sample wants 4 distinct jobs: Bolt(12,5), Plate, Washer, Bolt sizes', () => {
    const { wanted } = wantedFor(sampleProject())
    expect(wanted.jobs.length).toBe(4)
    expect(wanted.jobs.map((j) => j.spec.def).sort()).toEqual(['d_bolt', 'd_boltsizes', 'd_plate', 'd_washer'])
    expect([...wanted.jobsOfDef.keys()].sort()).toEqual(['d_bolt', 'd_boltsizes', 'd_plate', 'd_washer'])
    expect(wanted.resultKeyOf.has('i_fx1')).toBe(false) // 'none' groups are composed by three
    expect(wanted.resultKeyOf.has('i_fx1/i_w1/i_disc')).toBe(false) // operands hidden by default
    expect(wanted.priorityKeys.size).toBe(0)
  })

  test('operands are wanted while shown; selection gives priority', () => {
    const p = sampleProject()
    const u = ui({ selection: { kind: 'occ', path: ['i_fx1', 'i_w1'] }, context: ['i_fx1'] })
    const { wanted } = wantedFor(p, u)
    expect(wanted.resultKeyOf.has('i_fx1/i_w1/i_disc')).toBe(true)
    expect(wanted.resultKeyOf.has('i_fx1/i_w1/i_hole')).toBe(true)
    expect(wanted.resultKeyOf.has('i_fx2/i_w1/i_disc')).toBe(false)
    expect(wanted.jobs.length).toBe(6)
    const washer = wanted.resultKeyOf.get('i_fx1/i_w1')!
    expect(wanted.priorityKeys.has(washer)).toBe(true)
    expect(wanted.priorityKeys.has(wanted.resultKeyOf.get('i_fx1/i_w1/i_disc')!)).toBe(true)
    expect(wanted.priorityKeys.has(wanted.resultKeyOf.get('i_bs')!)).toBe(false)
  })

  test('hidden occurrences get no job; evalPaused wants nothing', () => {
    const p = sampleProject()
    ;(p.defs.d_root as GroupDef).children[2].hidden = true
    expect(wantedFor(p).wanted.jobsOfDef.has('d_boltsizes')).toBe(false)
    const paused = wantedFor(sampleProject(), ui({ evalPaused: true })).wanted
    expect(paused.jobs).toEqual([])
    expect(paused.resultKeyOf.size).toBe(0)
  })

  test('isolate target jobs come first and are priority', () => {
    const p = sampleProject()
    const specs = buildSpecs(p)
    const occs = expand(p)
    const u = ui({ selection: { kind: 'def', def: 'd_bolt' }, viewMode: 'isolate' })
    const iso = expand(p, { rootDef: 'd_bolt' })
    const w = computeWantedJobs(p, specs, occs, u, new Set(), iso)
    expect(w.jobs[0].spec.def).toBe('d_bolt')
    expect(w.resultKeyOf.get('~iso')).toBe(w.jobs[0].resultKey)
    expect(w.priorityKeys.has(w.jobs[0].resultKey)).toBe(true)
    expect(w.jobs.length).toBe(4) // the iso Bolt(12,5) key is shared with the scene's bolts
    // isolating a 'none' group expands its contents
    const isoFx = expand(p, { rootDef: 'd_fixture' })
    const w2 = computeWantedJobs(p, specs, occs, u, new Set(), isoFx)
    expect(w2.resultKeyOf.has('~iso')).toBe(false)
    expect(w2.resultKeyOf.has('~iso/i_plate')).toBe(true)
  })
})

describe('def states and rows', () => {
  test('ok / pending / idle / error and dependency failures', () => {
    const p = sampleProject()
    const { specs, occs, wanted } = wantedFor(p)
    const boltKey = wanted.resultKeyOf.get('i_fx1/i_b1')!
    const bsKey = wanted.resultKeyOf.get('i_bs')!
    const plateKey = wanted.resultKeyOf.get('i_fx1/i_plate')!
    const results = new Map<string, ResultLookup>()
    for (const j of wanted.jobs) results.set(j.resultKey, { state: 'ready' })
    let st = computeDefStates(p, wanted, specs.specErrors, (k) => results.get(k))
    expect(st.get('d_bolt')!.status).toBe('ok')
    expect(st.get('d_disc')!.status).toBe('idle')
    expect(st.get('d_fixture')!.status).toBe('idle')
    expect(st.has('d_root')).toBe(false)

    results.set(plateKey, { state: 'pending' })
    results.delete(boltKey)
    const bsErr = { kind: 'runtime' as const, def: 'd_bolt', defName: 'Bolt', message: 'boom', line: 1, trace: ['Bolt sizes', 'Bolt'] }
    results.set(bsKey, { state: 'failed', error: bsErr })
    st = computeDefStates(p, wanted, specs.specErrors, (k) => results.get(k))
    expect(st.get('d_plate')!.status).toBe('pending')
    expect(st.get('d_boltsizes')!.status).toBe('error')
    expect(st.get('d_boltsizes')!.error).toMatchObject({ kind: 'dependency', def: 'd_boltsizes', message: 'depends on "Bolt" (failed)' })
    expect(st.get('d_bolt')!.status).toBe('error') // named as error.def by Bolt sizes' failure
    expect(st.get('d_bolt')!.error).toBe(bsErr)

    const rows = computeRowStatuses(occs, st)
    expect(rows.get('i_fx1/i_b1')).toBe('error')
    expect(rows.get('i_fx1')).toBe('error') // worst of the subtree
    expect(rows.get('i_fx1/i_w1')).toBe('ok')
    expect(rows.get('i_fx1/i_w1/i_disc')).toBe('idle')
    expect(rows.get('i_bs')).toBe('error')
  })

  test('specErrors make a def error', () => {
    const p = sampleProject()
    ;(p.defs.d_plate as CodeDef).code = "return part('Nope')"
    const { specs, wanted } = wantedFor(p)
    const st = computeDefStates(p, wanted, specs.specErrors, () => ({ state: 'ready' }))
    expect(st.get('d_plate')!.status).toBe('error')
    expect(st.get('d_plate')!.error!.message).toMatch(/Unknown part "Nope"/)
    expect(st.get('d_fixture')!.status).toBe('error')
  })
})

describe('STL items', () => {
  test('whole scene: visible top-level instances with world matrices', () => {
    const p = sampleProject()
    const { specs, occs } = wantedFor(p)
    const plan = computeStlItems(specs, occs, ui())
    expect(plan.label).toBe('scene')
    expect(plan.items.length).toBe(3)
    expect(plan.items[0].job.spec.def).toBe('d_fixture')
    expect(plan.items[1].matrix[12]).toBe(75)
    expect(stlFileName(p.name, plan.label)).toBe('Bracket kit-scene.stl')
  })

  test('selected occurrence: its def job at occurrence.world', () => {
    const p = sampleProject()
    const { specs, occs } = wantedFor(p)
    const plan = computeStlItems(specs, occs, ui({ selection: { kind: 'occ', path: ['i_fx2', 'i_b1'] } }))
    expect(plan.label).toBe('Bolt')
    expect(plan.items.length).toBe(1)
    expect(plan.items[0].job.spec.def).toBe('d_bolt')
    expect(plan.items[0].matrix).toEqual(occs.find((o) => o.key === 'i_fx2/i_b1')!.world)
  })
})

describe('keys follow everything the evaluation depends on', () => {
  const rack = (options: string[], min?: number) => {
    const p = sampleProject()
    const bolt = p.defs.d_bolt as CodeDef
    bolt.params.push({ name: 'finish', type: 'choice', default: 'gloss', options, ...(min !== undefined ? { min } : {}) })
    ;(p.defs.d_boltsizes as CodeDef).code = "return part('Bolt', { finish: 'matte' })"
    return p
  }
  test("a dependency's choice options are in the key (part() overrides are validated against them)", () => {
    // before: part("Bolt"): finish must be one of "gloss"; after adding 'matte' it evaluates — a new key
    expect(keyOf(rack(['gloss', 'matte']), 'd_boltsizes')).not.toBe(keyOf(rack(['gloss']), 'd_boltsizes'))
    expect(keyOf(rack(['gloss', 'matte']), 'd_bolt')).not.toBe(keyOf(rack(['gloss']), 'd_bolt'))
  })
  test('UI hints (min / max / step) stay out of the key', () => {
    const a = sampleProject(), b = sampleProject()
    ;(b.defs.d_bolt as CodeDef).params[0].max = 999
    expect(keyOf(b, 'd_bolt')).toBe(keyOf(a, 'd_bolt'))
  })
})

describe('defs with identical content share a job, but each gets its own error', () => {
  const twins = () => {
    const p = sampleProject()
    const w: CodeDef = { id: 'd_w', name: 'Widget', kind: 'code', code: 'null.x\nreturn []', params: [] }
    p.defs.d_w = w
    p.defs.d_w2 = { ...structuredClone(w), id: 'd_w2', name: 'Widget 2' } // a fresh Ctrl+Shift+D clone
    const root = p.defs[p.root] as GroupDef
    root.children.push({ id: 'i_w', def: 'd_w', xf: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } })
    root.children.push({ id: 'i_w2', def: 'd_w2', xf: { t: [20, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } })
    return p
  }
  test("the clone's own failing line is its own error, not 'depends on \"Widget\" (failed)'", () => {
    const p = twins()
    const { specs, wanted } = wantedFor(p)
    const k = wanted.resultKeyOf.get('i_w')!
    expect(wanted.resultKeyOf.get('i_w2')).toBe(k) // one shared job…
    const job = wanted.jobs.find((j) => j.resultKey === k)!
    const err = { kind: 'runtime' as const, def: job.spec.def, defName: job.spec.name, message: "TypeError: Cannot read properties of null (reading 'x')", line: 1, trace: [job.spec.name] }
    const st = computeDefStates(p, wanted, specs.specErrors, (key) => (key === k ? { state: 'failed', error: err } : { state: 'ready' }))
    for (const [id, name] of [['d_w', 'Widget'], ['d_w2', 'Widget 2']]) {
      expect(st.get(id)!.status).toBe('error')
      expect(st.get(id)!.error).toMatchObject({ kind: 'runtime', def: id, defName: name, line: 1 }) // …two own errors
    }
  })
  test('a failure inside a dependency is still a dependency error', () => {
    const p = twins()
    ;(p.defs.d_w as CodeDef).code = (p.defs.d_w2 as CodeDef).code = "return part('Bolt')"
    const { specs, wanted } = wantedFor(p)
    const k = wanted.resultKeyOf.get('i_w2')!
    const err = { kind: 'runtime' as const, def: 'd_bolt', defName: 'Bolt', message: 'boom', line: 2, trace: ['Widget', 'Bolt'] }
    const st = computeDefStates(p, wanted, specs.specErrors, (key) => (key === k ? { state: 'failed', error: err } : { state: 'ready' }))
    expect(st.get('d_w2')!.error).toMatchObject({ kind: 'dependency', def: 'd_w2', message: 'depends on "Bolt" (failed)', trace: ['Widget 2', 'Bolt'] })
    expect(st.get('d_bolt')!.error).toBe(err)
  })
})

describe('STL export skips objects whose evaluation already failed', () => {
  test('a top-level item whose subtree has a failed result is skipped and the failing def named', () => {
    const p = sampleProject()
    const { specs, occs } = wantedFor(p)
    // Plate (inside both fixtures) failed, e.g. timed out: the fixtures are skipped, Bolt sizes is exported
    const plan = computeStlItems(specs, occs, ui(), (o) => o.def.id === 'd_plate')
    expect(plan.items.map((i) => i.job.spec.name)).toEqual(['Bolt sizes'])
    expect(plan.skipped).toEqual(['Plate'])
    // the selection itself failed: nothing to export
    const sel = computeStlItems(specs, occs, ui({ selection: { kind: 'occ', path: ['i_bs'] } }), (o) => o.key === 'i_bs')
    expect(sel.items).toEqual([])
    expect(sel.skipped).toEqual(['Bolt sizes'])
    // a hidden failing occurrence does not block its parent
    expect(computeStlItems(specs, occs.map((o) => (o.def.id === 'd_plate' ? { ...o, hidden: true } : o)), ui(), (o) => o.def.id === 'd_plate').items).toHaveLength(3)
  })
})
