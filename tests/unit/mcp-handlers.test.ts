// src/mcp/handlers.ts — the app side of the MCP tools, against a real Store + controller + core ops, with a fake
// evaluator (results are ready at once; chosen definitions fail) and a fake viewport (no DOM, no WebGL).
import { describe, expect, it } from 'vitest'
import type {
  AppContext, Commands, EvalClientApi, EvalClientStats, EvalStatus, MeshEntry, ResultState, ViewportApi,
} from '../../src/app/context'
import { createEvents, readUrlParams } from '../../src/app/context'
import { createController } from '../../src/app/controller'
import type { Job } from '../../src/core/evalspec'
import type { EvalError } from '../../src/eval/protocol'
import { instanceAtPath, worldMatrix } from '../../src/core/graph'
import { sampleProject, SAMPLE_EXPANDED } from '../../src/core/sample'
import { serialize } from '../../src/core/project-io'
import { Store } from '../../src/state/store'
import { Clipboard } from '../../src/state/clipboard'
import { applyDefaults, createHandlers, mergeXf, toPath, McpError } from '../../src/mcp/handlers'
import type { Box } from '../../src/core/transform'

/** Every wanted job is ready at once (a 10 × 20 × 30 mm box, 12 triangles) unless its def name is in `failing`. */
class FakeClient implements EvalClientApi {
  jobs = new Map<string, Job>()
  failing = new Map<string, EvalError>()
  exported: { job: Job; matrix: number[] }[][] = []
  private changeCbs: ((keys: string[]) => void)[] = []
  want(jobs: Job[]): void {
    for (const j of jobs) this.jobs.set(j.resultKey, j)
    const keys = jobs.map((j) => j.resultKey)
    queueMicrotask(() => { for (const cb of this.changeCbs) cb(keys) })
  }
  get(k: string): ResultState | undefined {
    const j = this.jobs.get(k)
    if (!j) return undefined
    const e = this.failing.get(j.spec.name)
    if (e) return { state: 'failed', error: { ...e, def: j.spec.def, defName: j.spec.name, trace: [j.spec.name] } }
    const bbox = { isEmpty: () => false, min: { x: -5, y: -10, z: 0 }, max: { x: 5, y: 10, z: 30 } }
    return { state: 'ready', entry: { geometries: [], baked: [], tris: 12, bbox, ms: 1, warnings: [] } as unknown as MeshEntry }
  }
  retry(): void {}
  async exportStl(items: { job: Job; matrix: number[] }[]): Promise<{ parts: ArrayBuffer[]; tris: number }> {
    this.exported.push(items)
    const head = new ArrayBuffer(84)
    new DataView(head).setUint32(80, 1, true)
    return { parts: [head, new ArrayBuffer(50)], tris: 1 }
  }
  onChange(cb: (keys: string[]) => void): () => void { this.changeCbs.push(cb); return () => {} }
  onStatus(): () => void { return () => {} }
  status(): EvalStatus { return { queued: 0, alive: true } }
  idle(): Promise<void> { return Promise.resolve() }
  setInUse(): void {}
  stats(): EvalClientStats { return { cacheEntries: 0, entriesInUse: 0, queued: 0, inFlight: 0, failed: 0, spawns: 1, crashes: 0 } }
  dispose(): void {}
}

function setup() {
  const store = new Store(sampleProject(), { expanded: { ...SAMPLE_EXPANDED } })
  const client = new FakeClient()
  const events = createEvents()
  const toasts: string[] = []
  const emitted: string[] = []
  const boxes: Record<string, Box> = {}
  const camera = { position: [100, -100, 100] as [number, number, number], target: [0, 0, 0] as [number, number, number] }
  const viewport = {
    reconcile: () => {},
    occurrenceBox: (path: string[]) => boxes[path.join('/')] ?? null,
    getCamera: () => camera,
    setCamera: (c: typeof camera) => { camera.position = c.position; camera.target = c.target },
    frameAll: () => {}, frameIfNeeded: () => {}, frameSelection: () => {}, viewPreset: () => {},
  } as unknown as ViewportApi
  const ctx: AppContext = {
    store, client, viewport, commands: {} as Commands, controller: null as never, clipboard: new Clipboard(),
    files: { downloadBlob() {}, pickFile: async () => null, pickFiles: async () => [], onWindowDrop: () => () => {} },
    toast: (m) => { toasts.push(m) }, confirm: async () => true, problems() {},
    on: events.on, emit: (t, p) => { emitted.push(t); events.emit(t, p) }, params: readUrlParams('?fresh'),
  }
  ctx.controller = createController(ctx)
  const actions: string[] = []
  const h = createHandlers(ctx, { settleMs: 2000, onAction: (l) => actions.push(l) })
  const call = async (name: string, params: Record<string, unknown> = {}) => (await h[name](params)) as Record<string, any>
  const defNamed = (name: string) => Object.values(store.project.defs).find((d) => d.name === name)!
  return { store, client, ctx, call, toasts, emitted, actions, boxes, defNamed, past: () => store.history.labels().past }
}

describe('mcp handlers: reading', () => {
  it('status summarizes the project, selection and evaluator', async () => {
    const { call } = setup()
    const s = await call('status')
    expect(s).toMatchObject({ app: '3dica 0.1.0', project: 'Bracket kit', definitions: 7, occurrences: 37, selection: null, viewMode: 'context', evalPaused: false, errors: 0 })
    expect(s.evaluator).toMatchObject({ alive: true, queued: 0, fatal: null })
  })

  it('get_scene returns the occurrence tree with paths, kinds, transforms and statuses', async () => {
    const { call, boxes } = setup()
    boxes['i_fx1/i_plate'] = { min: [-30, -20, 0], max: [30, 20, 4] }
    const r = await call('get_scene')
    expect(r.units).toBe('mm, Z up')
    expect(r.tree.map((n: any) => n.path)).toEqual([['i_fx1'], ['i_fx2'], ['i_bs']])
    const fx1 = r.tree[0]
    expect(fx1).toMatchObject({ label: 'Fixture A', definition: 'Fixture', kind: 'group', op: 'none' })
    const plate = fx1.children.find((c: any) => c.definition === 'Plate')
    expect(plate).toMatchObject({ path: ['i_fx1', 'i_plate'], kind: 'code', status: 'ok', bbox: { size: [60, 40, 4] } })
    const washer = fx1.children.find((c: any) => c.definition === 'Washer')
    expect(washer.op).toBe('subtract')
    expect(washer.children.map((c: any) => c.operand)).toEqual(['base', 'cut'])
    expect(r.tree[1].transform).toEqual({ t: [75, 0, 0], r: [0, 0, 15], s: [1, 1, 1] })
    // a subtree, limited
    const sub = await call('get_scene', { path: 'i_fx2', depth: 1, bbox: false })
    expect(sub.tree).toHaveLength(1)
    expect(sub.tree[0].path).toEqual(['i_fx2'])
    expect(sub.tree[0].children).toBeUndefined()
    const capped = await call('get_scene', { maxNodes: 3 })
    expect(capped.truncated).toMatch(/first 3/)
  })

  it('list_definitions and get_definition', async () => {
    const { call } = setup()
    const { definitions } = await call('list_definitions')
    const bolt = definitions.find((d: any) => d.name === 'Bolt')
    expect(bolt).toMatchObject({ kind: 'code', copies: 8, instances: 4, usedByCode: ['Bolt sizes'], status: 'ok' })
    expect(bolt.params.map((p: any) => p.name)).toEqual(['length', 'diameter'])
    expect(definitions.some((d: any) => d.name === 'Scene')).toBe(false)
    const fx = await call('get_definition', { name: 'Fixture' })
    expect(fx.children).toHaveLength(9)
    expect(fx.children[0]).toMatchObject({ id: 'i_plate', definition: 'Plate' })
    const bs = await call('get_definition', { name: 'Bolt sizes' })
    expect(bs.code).toContain("part('Bolt'")
    expect(bs.uses).toEqual(['Bolt'])
    await expect(call('get_definition', { name: 'Nut' })).rejects.toThrow(/No definition named 'Nut'. Definitions: .*Bolt/)
  })
})

describe('mcp handlers: editing (one undo step each, labelled MCP:)', () => {
  it('create_object makes a template def + instance, with defaults, name, color and transform', async () => {
    const { call, store, past, actions, defNamed } = setup()
    const r = await call('create_object', { kind: 'cube', name: 'Slab', defaults: { width: 40, depth: 30, height: 5 }, transform: { t: [0, 60, 0] }, color: '#AA0000' })
    expect(past()).toEqual(['MCP: Add Slab'])
    expect(actions).toEqual(['MCP: Add Slab'])
    const def = defNamed('Slab')
    expect(def.kind === 'code' && def.params.map((p) => p.default)).toEqual([40, 30, 5])
    expect(def.color).toBe('#aa0000')
    expect(r.path).toEqual([r.instanceId])
    expect(instanceAtPath(store.project, r.path)!.xf.t).toEqual([0, 60, 0])
    expect(r.objects[0]).toMatchObject({ definition: 'Slab', status: 'ok', triangles: 12, size: [10, 20, 30], copies: 1 })
    expect(r.errors).toEqual([])
    // a group, then a child placed into it by name
    const g = await call('create_object', { kind: 'group', name: 'Rack', op: 'union' })
    expect(defNamed('Rack')).toMatchObject({ kind: 'group', op: 'union' })
    const c = await call('add_instance', { definition: 'Slab', parent: 'Rack', transform: { t: [5, 0, 0] }, label: 'left' })
    expect(c.path).toEqual([...g.path, c.instanceId])
    expect(instanceAtPath(store.project, c.path)).toMatchObject({ name: 'left', xf: { t: [5, 0, 0] } })
  })

  it('create_object refuses bad input without changing anything', async () => {
    const { call, past } = setup()
    await expect(call('create_object', { kind: 'cone' })).rejects.toThrow(/kind must be one of/)
    await expect(call('create_object', { kind: 'cube', name: 'Bolt' })).rejects.toThrow(/'Bolt' is already used/)
    await expect(call('create_object', { kind: 'cube', defaults: { radius: 3 } })).rejects.toThrow(/has no parameter 'radius'/)
    await expect(call('create_object', { kind: 'group', code: 'return []' })).rejects.toThrow(/A group has no code/)
    await expect(call('create_object', { kind: 'cube', parent: ['i_fx1', 'i_plate'] })).rejects.toThrow(/not a group/)
    await expect(call('create_object', { kind: 'cube', transform: { s: [1, 0, 1] } })).rejects.toThrow(/can't contain 0/)
    expect(past()).toEqual([])
  })

  it('update_definition reports evaluation errors with the line, and the user can undo it', async () => {
    const { call, client, store, past, emitted } = setup()
    client.failing.set('Bolt', { kind: 'runtime', def: '', defName: '', message: 'boom', line: 2, col: 7, trace: [] })
    const r = await call('update_definition', { name: 'Bolt', code: 'const a = 1\nthrow new Error("boom")' })
    expect(past()).toEqual(['MCP: Edit Bolt'])
    expect(emitted).toContain('codeChanged')
    expect(r.objects[0]).toMatchObject({ definition: 'Bolt', status: 'error', error: { kind: 'runtime', message: 'boom', line: 2 } })
    expect(r.errors.map((e: any) => e.definition)).toContain('Bolt')
    client.failing.clear()
    const u = await call('undo')
    expect(u.undone).toEqual(['MCP: Edit Bolt'])
    expect((store.project.defs.d_bolt as { code: string }).code).toContain('hex head')
    const again = await call('redo')
    expect(again.redone).toEqual(['MCP: Edit Bolt'])
  })

  it('update_definition: defaults, rename (rewrites part() calls), color null clears, op for groups', async () => {
    const { call, store, defNamed } = setup()
    await call('update_definition', { name: 'Bolt', defaults: { diameter: 4 } })
    expect((defNamed('Bolt') as { params: { default: unknown }[] }).params[1].default).toBe(4)
    await call('update_definition', { name: 'Bolt', rename: 'Screw', color: null })
    expect(defNamed('Screw').color).toBeUndefined()
    expect((store.project.defs.d_boltsizes as { code: string }).code).toContain("part('Screw'")
    await call('update_definition', { name: 'Washer', op: 'union' })
    expect(defNamed('Washer')).toMatchObject({ op: 'union' })
    await expect(call('update_definition', { name: 'Washer', code: 'return []' })).rejects.toThrow(/is a group and has no code/)
    await expect(call('update_definition', { name: 'Plate', op: 'union' })).rejects.toThrow(/not a group/)
    await expect(call('update_definition', { name: 'Plate' })).rejects.toThrow(/Nothing to change/)
  })

  it('update_instance merges the transform, sets and clears overrides, label, color, hidden; reports linked copies', async () => {
    const { call, store } = setup()
    const path = ['i_fx1', 'i_b1']
    const r = await call('update_instance', { path, params: { length: 16 }, transform: { r: [0, 0, 30] }, label: 'long bolt', color: '#00ff00' })
    const inst = instanceAtPath(store.project, path)!
    expect(inst).toMatchObject({ name: 'long bolt', color: '#00ff00', params: { length: 16 }, xf: { t: [-23, -13, 5], r: [0, 0, 30] } })
    expect(r.linked).toBe("Changed 'Fixture' — 2 copies updated")
    await call('update_instance', { path: 'i_fx1/i_b1', params: { length: null }, label: null, color: null, hidden: true })
    expect(instanceAtPath(store.project, path)).toMatchObject({ hidden: true })
    expect(instanceAtPath(store.project, path)!.params).toBeUndefined()
    expect(instanceAtPath(store.project, path)!.name).toBeUndefined()
    await expect(call('update_instance', { path, params: { pitch: 1 } })).rejects.toThrow(/has no parameter 'pitch'/)
    await expect(call('update_instance', { path: ['i_nope'], hidden: true })).rejects.toThrow(/No object at path/)
  })

  it('wrap (named subtract) + move_instance into it keeps the world position', async () => {
    const { call, store, defNamed } = setup()
    const w = await call('wrap', { path: ['i_bs'], op: 'subtract', name: 'Cut rack' })
    expect(defNamed('Cut rack')).toMatchObject({ kind: 'group', op: 'subtract' })
    expect(w.child).toEqual([...w.path, 'i_bs'])
    const before = worldMatrix(store.project, ['i_fx2'])!
    const m = await call('move_instance', { path: ['i_fx2'], toParent: w.path })
    expect(m.path).toEqual([...w.path, 'i_fx2'])
    const after = worldMatrix(store.project, m.path)!
    after.forEach((v, i) => expect(v).toBeCloseTo(before[i], 6))
    const u = await call('ungroup', { path: w.path })
    expect(u.paths).toHaveLength(2)
  })

  it('duplicate linked / unique and make_unique', async () => {
    const { call, store, defNamed } = setup()
    const d = await call('duplicate', { path: ['i_fx1'], offset: 100 })
    expect(d.definition).toBe('Fixture')
    expect(instanceAtPath(store.project, d.path)!.xf.t).toEqual([100, 0, 0])
    const u = await call('duplicate', { path: ['i_fx1'], mode: 'unique' })
    expect(u.definition).toBe('Fixture 2')
    const mu = await call('make_unique', { path: d.path })
    expect(mu).toMatchObject({ from: 'Fixture', definition: 'Fixture 3' })
    expect(defNamed('Fixture 3').kind).toBe('group')
    await expect(call('make_unique', { path: ['i_bs'] })).rejects.toThrow(/Only instance/)
  })

  it('delete: an object; a definition needs cascade; part() targets are refused', async () => {
    const { call, store, past } = setup()
    await call('delete', { path: ['i_fx2'] })
    expect(store.project.defs.d_root.kind === 'group' && store.project.defs.d_root.children.map((c) => c.id)).toEqual(['i_fx1', 'i_bs'])
    await expect(call('delete', { definition: 'Plate' })).rejects.toThrow(/has 1 instance .* cascade: true/)
    const r = await call('delete', { definition: 'Plate', cascade: true })
    expect(r).toMatchObject({ deleted: 'Plate', removedInstances: 1 })
    await expect(call('delete', { definition: 'Bolt', cascade: true })).rejects.toThrow(/used by code in 'Bolt sizes'/)
    await expect(call('delete', {})).rejects.toThrow(/either path .* or definition/)
    expect(past()).toEqual(['MCP: Delete Fixture B', 'MCP: Delete definition Plate'])
    const u = await call('undo', { steps: 5 })
    expect(u.undone).toEqual(['MCP: Delete definition Plate', 'MCP: Delete Fixture B'])
    expect(u.canUndo).toBe(false)
  })

  it('a refusal neither toasts nor leaves store.onError swapped', async () => {
    const { call, store, toasts } = setup()
    const onError = store.onError
    await expect(call('add_instance', { definition: 'Fixture', parent: 'Fixture' })).rejects.toThrow(/inside itself/)
    expect(toasts).toEqual([])
    expect(store.onError).toBe(onError)
  })
})

describe('mcp handlers: selection, view, files', () => {
  it('select path / definition / none', async () => {
    const { call, store } = setup()
    expect((await call('select', { path: ['i_fx1', 'i_plate'] })).selection).toEqual({ path: ['i_fx1', 'i_plate'] })
    expect(store.ui.context).toEqual(['i_fx1'])
    const d = await call('select', { definition: 'Bolt' })
    expect(d).toMatchObject({ selection: { definition: 'Bolt' }, viewMode: 'isolate' })
    expect((await call('select')).selection).toBeNull()
    expect(store.history.labels().past).toEqual([])
  })

  it('set_view: isolate needs a selection; ghost; iso moves the camera keeping target and distance', async () => {
    const { call, store, ctx } = setup()
    await expect(call('set_view', { mode: 'isolate' })).rejects.toThrow(/Select something first/)
    await call('set_view', { ghost: false })
    expect(store.ui.ghostOthers).toBe(false)
    ctx.viewport.setCamera({ position: [0, -200, 0], target: [10, 0, 0] })
    await call('set_view', { preset: 'iso' })
    const c = ctx.viewport.getCamera()
    expect(c.target).toEqual([10, 0, 0])
    const d = c.position.map((v, i) => v - c.target[i])
    expect(Math.hypot(...d)).toBeCloseTo(Math.hypot(-10, -200, 0), 6)
    expect(d[0]).toBeGreaterThan(0); expect(d[1]).toBeLessThan(0); expect(d[2]).toBeGreaterThan(0)
  })

  it('new_project / save_project / load_project round trip (load runs code, no prompt)', async () => {
    const { call, store } = setup()
    const saved = await call('save_project')
    expect(saved.name).toBe('Bracket kit')
    expect(JSON.parse(saved.text)).toMatchObject({ format: '3dica', name: 'Bracket kit', camera: { target: [0, 0, 0] } })
    await call('new_project', { name: 'Empty' })
    expect(store.project.name).toBe('Empty')
    expect(Object.keys(store.project.defs)).toEqual(['d_root'])
    const r = await call('load_project', { text: saved.text, fileName: 'kit.3dica.json' })
    expect(r).toMatchObject({ ok: true, project: 'Bracket kit', definitions: 7 })
    expect(store.ui.evalPaused).toBe(false)
    await expect(call('load_project', { text: '{"format":"other"}', fileName: 'x.json' })).rejects.toThrow(/Can't open x.json:\n- Not a 3Dica project/)
    expect(serialize(store.project).length).toBeGreaterThan(100)
  })

  it('export_stl: the whole scene (ignoring the selection), a definition at the origin, or one path', async () => {
    const { call, client, store } = setup()
    store.setUi({ selection: { kind: 'occ', path: ['i_bs'] } })
    const all = await call('export_stl')
    expect(all.label).toBe('scene')
    expect(client.exported[0]).toHaveLength(3)
    const bytes = Buffer.from(all.base64, 'base64')
    expect(bytes.length).toBe(84 + 50 * all.triangles)
    const bolt = await call('export_stl', { target: 'Bolt' })
    expect(bolt.label).toBe('Bolt')
    expect(client.exported[1][0].matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const one = await call('export_stl', { target: ['i_fx2', 'i_plate'] })
    expect(one.label).toBe('Plate')
    expect(client.exported[2][0].matrix[12]).toBeCloseTo(75, 6)
    store.setUi({ evalPaused: true })
    await expect(call('export_stl')).rejects.toThrow(/paused/)
  })
})

describe('mcp handlers: helpers', () => {
  it('toPath accepts arrays and "a/b" strings', () => {
    expect(toPath(['i_a', 'i_b'])).toEqual(['i_a', 'i_b'])
    expect(toPath('i_a/ i_b/')).toEqual(['i_a', 'i_b'])
    expect(toPath('')).toEqual([])
    expect(() => toPath(3)).toThrow(McpError)
  })

  it('mergeXf keeps omitted fields and validates', () => {
    const base = { t: [1, 2, 3] as [number, number, number], r: [0, 0, 90] as [number, number, number], s: [1, 1, 1] as [number, number, number] }
    expect(mergeXf(base, { t: [0, 0, 5] })).toEqual({ t: [0, 0, 5], r: [0, 0, 90], s: [1, 1, 1] })
    expect(mergeXf(base, undefined)).toEqual(base)
    expect(() => mergeXf(base, { t: [1, 2] })).toThrow(/three finite numbers/)
    expect(() => mergeXf(base, { p: [1, 2, 3] })).toThrow(/no field 'p'/)
  })

  it('applyDefaults changes defaults of existing parameters only', () => {
    const params = [{ name: 'width', type: 'number' as const, default: 10 }, { name: 'round', type: 'boolean' as const, default: false }]
    expect(applyDefaults(params, { width: 40, round: true }, 'Cube').map((p) => p.default)).toEqual([40, true])
    expect(params[0].default).toBe(10)
    expect(() => applyDefaults(params, { round: 3 }, 'Cube')).toThrow(/default must be true or false/)
  })
})

describe('mcp handlers: OpenSCAD objects', () => {
  it('create_object with language openscad makes an OpenSCAD object whose params come from its code', async () => {
    const { call, defNamed, past } = setup()
    const r = await call('create_object', { kind: 'code', language: 'openscad', name: 'Peg', code: 'h = 10; // [1:50]\ncylinder(r = 2, h = h);\n', defaults: { h: 25 } })
    expect(past()).toEqual(['MCP: Add Peg'])
    const d = defNamed('Peg')
    expect(d).toMatchObject({ kind: 'code', lang: 'openscad', code: 'h = 25; // [1:50]\ncylinder(r = 2, h = h);\n' })
    expect(d.kind === 'code' && d.params).toEqual([{ name: 'h', type: 'number', default: 25, min: 1, max: 50 }])
    expect(r.objects[0]).toMatchObject({ definition: 'Peg', language: 'openscad', status: 'ok' })
    const g = await call('get_definition', { name: 'Peg' })
    expect(g).toMatchObject({ language: 'openscad', files: [], code: 'h = 25; // [1:50]\ncylinder(r = 2, h = h);\n' })
    expect((await call('get_definition', { name: 'Bolt' })).language).toBe('jscad')
    // the blank OpenSCAD template when no code is given
    const t = await call('create_object', { kind: 'code', language: 'openscad' })
    expect(defNamed(t.definition)).toMatchObject({ lang: 'openscad' })
  })

  it('refuses parameter lists for OpenSCAD objects and language on other kinds', async () => {
    const { call, past } = setup()
    await expect(call('create_object', { kind: 'code', language: 'openscad', params: [{ name: 'w', type: 'number', default: 1 }] })).rejects.toThrow(/is an OpenSCAD object: an OpenSCAD object's parameters come from the top-level assignments/)
    await expect(call('create_object', { kind: 'cube', language: 'openscad' })).rejects.toThrow(/language is only for kind "code"/)
    await expect(call('create_object', { kind: 'code', language: 'openscad', defaults: { nope: 1 } })).rejects.toThrow(/has no parameter 'nope'/)
    expect(past()).toEqual([])
  })

  it('update_definition: code re-derives the params, defaults rewrite the code, params are refused with a hint', async () => {
    const { call, defNamed, past, emitted } = setup()
    await call('create_object', { kind: 'code', language: 'openscad', name: 'Box', code: 'w = 10;\ncube(w);\n' })
    await call('update_definition', { name: 'Box', code: 'w = 10;\nh = 2;\ncube([w, w, h]);\n' })
    expect(defNamed('Box').kind === 'code' && (defNamed('Box') as any).params.map((p: any) => p.name)).toEqual(['w', 'h'])
    await call('update_definition', { name: 'Box', defaults: { h: 7 } })
    expect((defNamed('Box') as any).code).toBe('w = 10;\nh = 7;\ncube([w, w, h]);\n')
    expect(emitted).toContain('codeChanged')
    await expect(call('update_definition', { name: 'Box', params: [] })).rejects.toThrow(/Pass the new code with update_definition/)
    expect(past()).toEqual(['MCP: Add Box', 'MCP: Edit Box', 'MCP: Edit Box'])
  })

  it('reports the echo / warning output of an OpenSCAD object', async () => {
    const { call, client } = setup()
    const realGet = client.get.bind(client)
    client.get = (k: string) => {
      const r = realGet(k)
      if (r?.state === 'ready' && client.jobs.get(k)?.spec.name === 'Echo') {
        return { state: 'ready', entry: { ...r.entry, console: [{ level: 'echo', text: '"w =", 10', line: 2, col: 1 }] } as MeshEntry }
      }
      return r
    }
    const r = await call('create_object', { kind: 'code', language: 'openscad', name: 'Echo', code: 'w = 10;\necho("w =", w);\ncube(w);\n' })
    expect(r.objects[0].output).toEqual(['ECHO: "w =", 10 (line 2)'])
  })
})
