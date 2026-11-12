// app/commands.ts against a real Store + core, with a fake viewport / client / controller / files (no DOM).
import { describe, expect, it, vi } from 'vitest'
import { Store } from '../../src/state/store'
import { Clipboard } from '../../src/state/clipboard'
import { sampleProject, SAMPLE_EXPANDED } from '../../src/core/sample'
import { createCommands } from '../../src/app/commands'
import { createEvents, type AppContext, type Box, type EvalClientApi, type FilesApi, type RenderState, type ToastKind, type ViewportApi } from '../../src/app/context'
import { buildSpecs, computeDefStates, computeRowStatuses, computeWantedJobs } from '../../src/core/evalspec'
import { expand, indexOccurrences, instanceAtPath, occurrenceCounts, worldMatrix } from '../../src/core/graph'
import { shownOperandBools } from '../../src/core/selection'
import { PALETTE } from '../../src/core/templates'
import { serialize } from '../../src/core/project-io'
import type { InstancePath } from '../../src/core/types'

function makeCtx(boxes: Record<string, Box> = {}) {
  const toasts: { msg: string; kind: ToastKind }[] = []
  const store = new Store(sampleProject(), { expanded: { ...SAMPLE_EXPANDED } }, { onError: (m) => toasts.push({ msg: m, kind: 'error' }) })
  const events = createEvents()
  let version = 0
  let last: RenderState | null = null
  const pass = (): RenderState => {
    const project = store.project
    const ui = store.ui
    const specs = buildSpecs(project)
    const occurrences = expand(project)
    const shownOperands = shownOperandBools(occurrences, ui)
    const wanted = computeWantedJobs(project, specs, occurrences, ui, shownOperands, [])
    const defStates = computeDefStates(project, wanted, specs.specErrors, () => undefined)
    last = {
      version: ++version, project, ui, occurrences, byKey: indexOccurrences(occurrences), isolate: null, shownOperands, specs, wanted,
      defStates, rowStatus: computeRowStatuses(occurrences, defStates), counts: occurrenceCounts(project),
    }
    return last
  }
  const controller = { current: () => last ?? pass(), schedule: () => {}, run: pass, idle: async () => {} }
  const viewport = {
    occurrenceBox: vi.fn((path: InstancePath) => boxes[path.join('/')] ?? null),
    frameIfNeeded: vi.fn(), frameAll: vi.fn(), frameSelection: vi.fn(), viewPreset: vi.fn(),
    getCamera: () => ({ position: [10, -20, 30], target: [0, 0, 0] }), setCamera: vi.fn(),
  } as unknown as ViewportApi
  const client = {
    retry: vi.fn(), get: vi.fn(() => undefined),
    exportStl: vi.fn(async () => ({ parts: [new ArrayBuffer(84)], tris: 0 })),
  } as unknown as EvalClientApi
  const files: FilesApi = { downloadBlob: vi.fn(), pickFile: vi.fn(async () => null), onWindowDrop: vi.fn(() => () => {}) }
  const confirm = vi.fn(async () => true)
  const problems = vi.fn()
  const ctx = {
    store, client, viewport, controller, clipboard: new Clipboard(), files, confirm, problems,
    toast: (msg: string, kind: ToastKind = 'info') => { toasts.push({ msg, kind }) },
    ...events, params: { fresh: true, evalTimeoutMs: 20000 },
  } as unknown as AppContext
  ctx.commands = createCommands(ctx)
  return { ctx, c: ctx.commands, store, toasts, viewport, client, files, confirm, problems }
}

const count = (store: Store, name: string) => {
  const d = Object.values(store.project.defs).find((x) => x.name === name)
  return d ? occurrenceCounts(store.project).get(d.id) ?? 0 : -1
}
const sel = (store: Store) => store.ui.selection
const pastLabels = (store: Store) => store.history.labels().past

describe('commands: create / structure (§4.2)', () => {
  it('adds a template at the origin when nothing is evaluated, selects it and takes the next palette color', () => {
    const { c, store } = makeCtx()
    c.addTemplate('cube')
    expect(pastLabels(store)).toEqual(['Add Cube'])
    const s = sel(store)
    expect(s.kind).toBe('occ')
    const path = (s as { path: InstancePath }).path
    expect(path).toHaveLength(1)
    const inst = instanceAtPath(store.project, path)!
    expect(inst.xf.t).toEqual([0, 0, 0])
    const def = store.project.defs[inst.def]
    expect(def.name).toBe('Cube')
    expect(def.color).toBe(PALETTE[0])
    c.addTemplate('sphere')
    expect(store.project.defs[instanceAtPath(store.project, (sel(store) as { path: InstancePath }).path)!.def].color).toBe(PALETTE[1])
  })

  it('places right of the evaluated parent-space bboxes of the visible children', () => {
    const { c, store } = makeCtx({
      i_fx1: { min: [-30, -20, -12], max: [30, 20, 9] },
      i_fx2: { min: [40, -30, -12], max: [105.2, 30, 9] },
      i_bs: { min: [-30, -50, -4], max: [30, -40, 30] },
    })
    c.addTemplate('torus')
    const inst = instanceAtPath(store.project, (sel(store) as { path: InstancePath }).path)!
    expect(inst.xf.t).toEqual([Math.ceil(105.2 + 5 + 7.5), 0, 0])
  })

  it('adds into the entered context group and toasts the linked change', () => {
    const { c, store, toasts } = makeCtx()
    store.setUi({ context: ['i_fx1'] })
    c.addTemplate('code')
    expect(store.project.defs.d_fixture.kind === 'group' && store.project.defs.d_fixture.children.length).toBe(10)
    expect(toasts.map((t) => t.msg)).toContain("Added to 'Fixture' — 2 copies updated")
    expect((sel(store) as { path: InstancePath }).path[0]).toBe('i_fx1')
  })

  it('wraps in a union (one step, selects + expands) and ungroups back', () => {
    const { c, store } = makeCtx()
    c.selectFromTree(['i_bs'])
    c.wrap('union')
    expect(pastLabels(store)).toEqual(['Wrap in Union'])
    const gp = (sel(store) as { path: InstancePath }).path
    expect(store.ui.expanded[gp.join('/')]).toBe(true)
    expect(Object.values(store.project.defs).some((d) => d.name === 'Union')).toBe(true)
    c.ungroup()
    expect(pastLabels(store).at(-1)).toMatch(/^Ungroup /)
    const s = sel(store) as { path: InstancePath }
    expect(instanceAtPath(store.project, s.path)!.def).toBe('d_boltsizes')
  })
})

describe('commands: duplicate / clipboard (§4.5)', () => {
  it('Ctrl+D links (default offset 15), Ctrl+Shift+D clones', () => {
    const { c, store } = makeCtx()
    c.selectFromTree(['i_fx1'])
    c.duplicateLinked()
    expect(count(store, 'Fixture')).toBe(3)
    expect(count(store, 'Bolt')).toBe(12)
    const copy = instanceAtPath(store.project, (sel(store) as { path: InstancePath }).path)!
    expect(copy.xf.t[0]).toBe(15)
    expect(pastLabels(store)).toEqual(['Duplicate Fixture A'])
    c.duplicateUnique()
    expect(Object.values(store.project.defs).some((d) => d.name === 'Fixture 2')).toBe(true)
    expect(count(store, 'Bolt')).toBe(16)
  })

  it('uses the evaluated bbox width for the offset', () => {
    const { c, store } = makeCtx({ i_bs: { min: [-30, -50, -4], max: [30.4, -40, 30] } })
    c.selectFromTree(['i_bs'])
    c.duplicateLinked()
    const copy = instanceAtPath(store.project, (sel(store) as { path: InstancePath }).path)!
    expect(copy.xf.t[0]).toBe(-24 + Math.ceil(60.4 + 5))
  })

  it('copy + paste is one undo step; repeated pastes step further', () => {
    const { c, store } = makeCtx()
    c.selectFromTree(['i_bs'])
    c.copy()
    expect(store.history.labels().past).toEqual([])
    c.paste(false)
    expect(count(store, 'Bolt sizes')).toBe(2)
    const a = instanceAtPath(store.project, (sel(store) as { path: InstancePath }).path)!
    c.paste(false)
    const b = instanceAtPath(store.project, (sel(store) as { path: InstancePath }).path)!
    expect(b.xf.t[0]).toBeGreaterThan(a.xf.t[0])
    c.undo()
    c.undo()
    expect(count(store, 'Bolt sizes')).toBe(1)
  })

  it('make unique is refused for a single record (toast) and works for linked records', () => {
    const { c, store, toasts } = makeCtx()
    c.selectFromTree(['i_fx1', 'i_plate'])
    c.makeUnique()
    expect(toasts.at(-1)?.kind).toBe('error')
    expect(toasts.at(-1)?.msg).toMatch(/^Only instance of 'Plate'/)
    c.selectFromTree(['i_fx2'])
    c.makeUnique()
    expect(store.project.root && instanceAtPath(store.project, ['i_fx2'])!.def).not.toBe('d_fixture')
  })
})

describe('commands: delete / purge (§4.6)', () => {
  it('Del on an occurrence removes the record (linked toast) and keeps the def', async () => {
    const { c, store, toasts } = makeCtx()
    c.selectFromTree(['i_fx1', 'i_b1'])
    await c.deleteSelection()
    expect(count(store, 'Bolt')).toBe(6)
    expect(store.project.defs.d_bolt).toBeDefined()
    expect(toasts.map((t) => t.msg)).toContain("Changed 'Fixture' — 2 copies updated")
    expect(sel(store)).toEqual({ kind: 'none' })
    expect(pastLabels(store)).toEqual(['Delete Bolt'])
  })

  it('refuses to delete a def referenced by code, confirms otherwise', async () => {
    const { c, store, toasts, confirm } = makeCtx()
    await c.deleteDefinition('d_bolt')
    expect(toasts.at(-1)).toEqual({ msg: "Can't delete 'Bolt': used by code in 'Bolt sizes'", kind: 'error' })
    expect(confirm).not.toHaveBeenCalled()
    c.selectDef('d_plate')
    await c.deleteSelection()
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: "Delete 'Plate' and its 1 instance (2 copies in the scene)?", ok: 'Delete' }))
    expect(store.project.defs.d_plate).toBeUndefined()
    expect(store.ui.viewMode).toBe('context')
    expect(pastLabels(store)).toEqual(['Delete definition Plate'])
  })

  it('a cancelled confirm changes nothing', async () => {
    const { c, store, confirm } = makeCtx()
    confirm.mockResolvedValueOnce(false)
    await c.deleteDefinition('d_washer')
    expect(store.project.defs.d_washer).toBeDefined()
  })

  it('purges unused defs', async () => {
    const { c, store, toasts } = makeCtx()
    c.purgeUnused()
    expect(toasts.at(-1)?.msg).toBe('Nothing to purge')
    c.selectFromTree(['i_bs'])
    await c.deleteSelection()
    c.purgeUnused()
    expect(toasts.at(-1)?.msg).toBe('Removed 1 unused definition')
    expect(store.project.defs.d_boltsizes).toBeUndefined()
  })
})

describe('commands: rename (§4.7)', () => {
  it('a labeled occurrence edits its label; an unlabeled one renames the def', () => {
    const { c, store } = makeCtx()
    expect(c.commitRename({ kind: 'occ', path: ['i_fx1'] }, 'Left')).toBeNull()
    expect(instanceAtPath(store.project, ['i_fx1'])!.name).toBe('Left')
    expect(store.project.defs.d_fixture.name).toBe('Fixture')
    expect(c.commitRename({ kind: 'occ', path: ['i_bs'] }, 'Rack')).toBeNull()
    expect(store.project.defs.d_boltsizes.name).toBe('Rack')
    expect(pastLabels(store).at(-1)).toBe('Rename Bolt sizes → Rack')
    // empty clears a label
    expect(c.commitRename({ kind: 'occ', path: ['i_fx1'] }, '  ')).toBeNull()
    expect(instanceAtPath(store.project, ['i_fx1'])!.name).toBeUndefined()
  })

  it('def rename rewrites part() and emits codeChanged; invalid names change nothing', () => {
    const { c, ctx, store } = makeCtx()
    const seen: string[][] = []
    ctx.on('codeChanged', (e) => seen.push(e.defIds))
    expect(c.renameDef('d_bolt', 'Screw')).toBeNull()
    const bs = store.project.defs.d_boltsizes
    expect(bs.kind === 'code' && bs.code).toContain("part('Screw'")
    expect(seen).toEqual([['d_boltsizes']])
    const before = store.project
    expect(c.renameDef('d_plate', 'Scene')).toMatch(/reserved/)
    expect(c.renameDef('d_plate', 'Screw')).toMatch(/already used/)
    expect(c.commitRename({ kind: 'def', def: 'd_plate' }, 'a"b')).toMatch(/quotes/)
    expect(store.project).toBe(before)
  })

  it('startRename emits the selection target', () => {
    const { c, ctx } = makeCtx()
    const got: unknown[] = []
    ctx.on('rename', (t) => got.push(t))
    c.selectFromTree(['i_bs'])
    c.startRename()
    c.selectDef('d_bolt')
    c.startRename()
    expect(got).toEqual([{ kind: 'occ', path: ['i_bs'] }, { kind: 'def', def: 'd_bolt' }])
  })
})

describe('commands: drag and drop (§4.8)', () => {
  it('validity: self / subtree / cycles are rejected', () => {
    const { c } = makeCtx()
    expect(c.canDrop({ kind: 'occ', path: ['i_fx1'] }, { parentPath: ['i_fx1'], index: -1 })).toBe(false)
    expect(c.canDrop({ kind: 'occ', path: ['i_fx1'] }, { parentPath: ['i_fx1', 'i_w1'], index: -1 })).toBe(false)
    expect(c.canDrop({ kind: 'occ', path: ['i_fx1'] }, { parentPath: ['i_fx2'], index: -1 })).toBe(false) // Fixture into Fixture
    expect(c.canDrop({ kind: 'def', def: 'd_fixture' }, { parentPath: ['i_fx1'], index: 0 })).toBe(false)
    expect(c.canDrop({ kind: 'def', def: 'd_bolt' }, { parentPath: ['i_fx1', 'i_plate'], index: -1 })).toBe(false) // not a group
    expect(c.canDrop({ kind: 'occ', path: ['i_bs'] }, { parentPath: ['i_fx2'], index: -1 })).toBe(true)
    expect(c.canDrop({ kind: 'def', def: 'd_bolt' }, { parentPath: [], index: 0 })).toBe(true)
  })

  it('a plain drop keeps the world position; Ctrl copies; a Library drop adds at identity', () => {
    const { c, store, toasts } = makeCtx()
    const w0 = worldMatrix(store.project, ['i_bs'])!
    c.drop({ kind: 'occ', path: ['i_bs'] }, { parentPath: ['i_fx2'], index: -1 }, { copy: false })
    expect(pastLabels(store)).toEqual(['Move Bolt sizes'])
    const w1 = worldMatrix(store.project, ['i_fx2', 'i_bs'])!
    w0.forEach((v, i) => expect(w1[i]).toBeCloseTo(v, 6))
    expect(toasts.map((t) => t.msg)).toContain("Changed 'Fixture' — 2 copies updated")
    expect(sel(store)).toEqual({ kind: 'occ', path: ['i_fx2', 'i_bs'] })

    c.drop({ kind: 'occ', path: ['i_fx2', 'i_plate'] }, { parentPath: [], index: 0 }, { copy: true })
    expect(pastLabels(store).at(-1)).toBe('Copy Plate')
    expect(instanceAtPath(store.project, ['i_fx2', 'i_plate'])).toBeDefined()
    expect(count(store, 'Plate')).toBe(3)

    c.drop({ kind: 'def', def: 'd_washer' }, { parentPath: [], index: 1 }, { copy: false })
    expect(pastLabels(store).at(-1)).toBe('Add Washer')
    const root = store.project.defs[store.project.root]
    expect(root.kind === 'group' && root.children[1].def).toBe('d_washer')
  })
})

describe('commands: edits, hide, view', () => {
  it('param overrides coalesce into one step; ↺ removes', () => {
    const { c, store } = makeCtx()
    c.setOverride(['i_bs'], 'count', 3)
    c.setOverride(['i_bs'], 'count', 4)
    expect(pastLabels(store)).toEqual(['Set count'])
    expect(instanceAtPath(store.project, ['i_bs'])!.params).toEqual({ count: 4 })
    c.setOverride(['i_bs'], 'count', undefined)
    expect(instanceAtPath(store.project, ['i_bs'])!.params).toBeUndefined()
  })

  it('transform fields coalesce per field and refuse scale 0', () => {
    const { c, store, toasts } = makeCtx()
    const xf = structuredClone(instanceAtPath(store.project, ['i_bs'])!.xf)
    xf.t[0] = 1
    c.setTransform(['i_bs'], xf, 't0')
    xf.t[0] = 2
    c.setTransform(['i_bs'], xf, 't0')
    expect(pastLabels(store)).toEqual(['Move Bolt sizes'])
    xf.s[2] = 0
    c.setTransform(['i_bs'], xf, 's2')
    expect(toasts.at(-1)).toEqual({ msg: "Scale can't be 0", kind: 'error' })
    c.commitGizmo(['i_bs'], { t: [5, 5, 0], r: [0, 0, 0], s: [1, 1, 1] }, 'translate')
    expect(pastLabels(store).at(-1)).toBe('Move Bolt sizes')
    c.resetTransform(['i_bs'])
    expect(instanceAtPath(store.project, ['i_bs'])!.xf).toEqual({ t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] })
  })

  it('hide toggles with labels, Unhide all clears', () => {
    const { c, store } = makeCtx()
    c.selectFromTree(['i_bs'])
    c.hideToggle()
    c.hideToggle(['i_fx1', 'i_b2'])
    expect(pastLabels(store)).toEqual(['Hide Bolt sizes', 'Hide Bolt'])
    c.unhideAll()
    expect(pastLabels(store).at(-1)).toBe('Unhide all')
    expect(instanceAtPath(store.project, ['i_bs'])!.hidden).toBeUndefined()
  })

  it('selection / view commands only touch ui', () => {
    const { c, store, toasts } = makeCtx()
    c.toggleIsolate()
    expect(toasts.at(-1)?.msg).toBe('Select something to isolate')
    c.selectDef('d_bolt')
    expect(store.ui.viewMode).toBe('isolate')
    c.selectFromTree(['i_fx1', 'i_plate'])
    expect(store.ui.viewMode).toBe('context')
    expect(store.ui.context).toEqual(['i_fx1'])
    c.escape()
    expect(sel(store)).toEqual({ kind: 'occ', path: ['i_fx1'] })
    c.enterGroup()
    expect(store.ui.context).toEqual(['i_fx1'])
    c.toggleExpanded(['i_fx1'])
    expect(store.ui.expanded.i_fx1).toBeUndefined()
    c.setGizmoMode('rotate'); c.toggleSpace(); c.toggleSnap(); c.toggleGhost()
    expect(store.ui).toMatchObject({ gizmoMode: 'rotate', gizmoSpace: 'local', snap: false, ghostOthers: false })
    expect(store.history.labels().past).toEqual([])
  })
})

describe('commands: files (§6)', () => {
  it('save downloads <name>.3dica.json with the camera', async () => {
    const { c, files } = makeCtx()
    c.save()
    const call = vi.mocked(files.downloadBlob).mock.calls[0]
    expect(call[1]).toBe('Bracket kit.3dica.json')
    const text = await (call[0] as Blob).text()
    expect(JSON.parse(text).camera).toEqual({ position: [10, -20, 30], target: [0, 0, 0] })
  })

  it('open: problems dialog on a bad file; code asks before running; history resets', async () => {
    const { c, store, problems, confirm } = makeCtx()
    c.selectFromTree(['i_bs'])
    c.hideToggle()
    await c.open(new File(['{"format":"nope"}'], 'bad.json'))
    expect(problems).toHaveBeenCalledWith("Can't open bad.json", [expect.stringMatching(/Not a 3Dica project/)])
    expect(store.history.labels().past).toEqual(['Hide Bolt sizes'])
    confirm.mockResolvedValueOnce(false)
    const p = sampleProject()
    p.name = 'Other'
    await c.open(new File([serialize(p)], 'other.3dica.json'))
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: 'This file contains code that runs on your computer. Run it?', ok: 'Run code', cancel: 'Open without running' }))
    expect(store.project.name).toBe('Other')
    expect(store.ui.evalPaused).toBe(true)
    expect(store.history.labels().past).toEqual([])
    c.runCode()
    expect(store.ui.evalPaused).toBe(false)
  })

  it('exports the scene as STL when nothing is selected', async () => {
    const { c, client, files } = makeCtx()
    await c.exportStl()
    const items = vi.mocked(client.exportStl).mock.calls[0][0]
    expect(items).toHaveLength(3)
    expect(vi.mocked(files.downloadBlob).mock.calls[0][1]).toBe('Bracket kit-scene.stl')
  })

  it('never re-sends a job whose evaluation already failed (a known infinite loop would block the evaluator 60 s)', async () => {
    const { ctx, c, client, toasts } = makeCtx()
    const bsKey = ctx.controller.current().wanted.resultKeyOf.get('i_bs')!
    const timeout = { kind: 'timeout' as const, def: 'd_boltsizes', defName: 'Bolt sizes', message: 'Timed out after 1.5 s', trace: ['Bolt sizes'] }
    vi.mocked(client.get).mockImplementation(((k: string) => (k === bsKey ? { state: 'failed', error: timeout } : undefined)) as never)
    await c.exportStl()
    const items = vi.mocked(client.exportStl).mock.calls[0][0]
    expect(items.map((i) => i.job.spec.name)).toEqual(['Fixture', 'Fixture'])
    expect(toasts.map((t) => t.msg)).toContain('Skipped because of errors: Bolt sizes')
    // with the failed object selected: refused at once, nothing sent
    c.selectFromTree(['i_bs'])
    await c.exportStl()
    expect(client.exportStl).toHaveBeenCalledTimes(1)
    expect(toasts.map((t) => t.msg)).toContain("Nothing to export ('Bolt sizes' has errors)")
  })

  it('new / sample ask first', async () => {
    const { c, store, confirm } = makeCtx()
    await c.newProject()
    expect(confirm).toHaveBeenCalled()
    expect(Object.keys(store.project.defs)).toEqual(['d_root'])
    expect(store.project.name).toBe('Untitled')
    await c.loadSample()
    expect(store.project.name).toBe('Bracket kit')
    expect(store.ui.expanded).toEqual(SAMPLE_EXPANDED)
  })
})
