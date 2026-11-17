// src/agent/tools.ts — the chat's tools: built from the shared catalog (same as the MCP server's), JSON Schemas every
// provider accepts, readable validation errors, and runs through the real handlers with "AI: " history labels.
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentTool, ToolRunContext } from '../../src/agent/types'
import { checkSchema, createChatTools, inputSchemaOf, portableSchema, projectFileName, safeFileName } from '../../src/agent/tools'
import { toolCatalog } from '../../shared/tool-catalog.mjs'
import { setupApp } from './agent-fixtures'

const root = path.resolve(import.meta.dirname, '../..')
const T = await import(/* @vite-ignore */ pathToFileURL(path.join(root, 'mcp/lib/tools.mjs')).href)

const rc = (over: Partial<ToolRunContext> = {}): ToolRunContext => ({ signal: new AbortController().signal, confirm: async () => true, ...over })

function tools(opts: Parameters<typeof createChatTools>[1] = {}) {
  const app = setupApp()
  const list = createChatTools(app.ctx, { settleMs: 2000, ...opts })
  const byName = new Map(list.map((t) => [t.name, t]))
  const tool = (n: string): AgentTool => byName.get(n)!
  /** validate, then run (like the loop does) */
  const call = async (n: string, input: Record<string, unknown> = {}, ctx = rc()) => {
    const v = tool(n).validate(input)
    if (!v.ok) throw new Error(v.error)
    return tool(n).run(v.value, ctx)
  }
  return { ...app, list, tool, call }
}

describe('agent tools: catalog', () => {
  it('the chat gets the MCP tools minus help and load_project, in the same order', () => {
    const mcp = toolCatalog('mcp').map((t) => t.name)
    expect(mcp).toEqual(T.TOOL_NAMES)
    expect(mcp).toHaveLength(26)
    const { list } = tools()
    expect(list.map((t) => t.name)).toEqual(mcp.filter((n: string) => n !== 'help' && n !== 'load_project'))
  })

  it('texts follow the audience: label prefix, file tools, confirmation, screenshot size', () => {
    const by = (a: 'mcp' | 'chat') => new Map(toolCatalog(a).map((t) => [t.name, t]))
    const mcp = by('mcp')
    const chat = by('chat')
    expect(mcp.get('undo')!.description).toContain('yours start with "MCP: "')
    expect(chat.get('undo')!.description).toContain('Undo your own last steps (labelled "AI: …")')
    expect(chat.get('undo')!.description).toMatch(/stops at the user's own edits/)
    expect(chat.get('redo')!.description).toMatch(/Redo your own steps \("AI: …"\)/)
    expect(mcp.get('redo')!.description).toBe('Redo steps undone with undo (or Ctrl+Z in the app).')
    expect(Object.keys(mcp.get('save_project')!.input)).toEqual(['path'])
    expect(Object.keys(chat.get('save_project')!.input)).toEqual(['fileName'])
    expect(Object.keys(chat.get('export_stl')!.input)).toEqual(['target'])
    expect(chat.get('save_project')!.description).toMatch(/browser/)
    expect(chat.get('new_project')!.description).toMatch(/asked to approve/)
    expect(mcp.get('new_project')!.description).toMatch(/without the app's confirmation dialog/)
    expect(chat.get('status')!.description).not.toMatch(/bridge|connected/)
    for (const t of chat.values()) expect(t.description, t.name).not.toMatch(/MCP|working directory|~\//)
    const shot = inputSchemaOf(chat.get('screenshot')!.input) as any
    expect(shot.properties.width.description).toBe('default 768')
    expect(shot.properties.height.description).toBe('default 576')
  })

  it('flags: read-only tools, and the two that cannot be undone need confirmation', () => {
    const { list } = tools()
    expect(list.filter((t) => t.needsConfirm).map((t) => t.name)).toEqual(['new_project', 'load_sample'])
    expect(list.filter((t) => t.readOnly).map((t) => t.name)).toEqual(['status', 'get_scene', 'list_definitions', 'get_definition', 'get_errors', 'screenshot'])
  })
})

describe('agent tools: JSON Schema', () => {
  it('every chat tool has a schema that passes the strict check (Anthropic and OpenAI-compatible function calling)', () => {
    const { list } = tools()
    for (const t of list) {
      expect(checkSchema(t.inputSchema), t.name).toEqual([])
      expect(t.description.length, t.name).toBeGreaterThan(40)
      const text = JSON.stringify(t.inputSchema)
      expect(text, t.name).not.toMatch(/\$schema|\$ref|\$defs|propertyNames|oneOf|allOf|9007199254740991|"type":\[/)
      expect(JSON.parse(text)).toEqual(t.inputSchema) // plain JSON
    }
    // the MCP catalog converts cleanly too (all 26)
    for (const t of toolCatalog('mcp')) expect(checkSchema(inputSchemaOf(t.input)), t.name).toEqual([])
  })

  it('unions, nullables, records and integer bounds come out portable', () => {
    const { tool } = tools()
    const ui = tool('update_instance').inputSchema as any
    expect(ui.required).toEqual(['path'])
    expect(ui.properties.path.anyOf).toEqual([{ type: 'array', items: { type: 'string' } }, { type: 'string' }])
    expect(ui.properties.path.description).toMatch(/^Instance path/)
    expect(ui.properties.params).toEqual({
      type: 'object',
      additionalProperties: { anyOf: [{ type: 'number' }, { type: 'boolean' }, { type: 'string' }, { type: 'null' }] },
    })
    expect(ui.properties.transform.additionalProperties).toBe(false)
    expect(ui.properties.transform.properties.t).toMatchObject({ type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } })
    const ud = tool('update_definition').inputSchema as any
    expect(ud.properties.color).toEqual({ description: '#rrggbb', anyOf: [{ type: 'string' }, { type: 'null' }] })
    const gs = tool('get_scene').inputSchema as any
    expect(gs.properties.depth).toEqual({ description: 'max depth to list', type: 'integer', minimum: 1 })
    expect(tool('undo').inputSchema).toEqual({ type: 'object', properties: { steps: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false })
    expect(tool('status').inputSchema).toEqual({ type: 'object', properties: {}, additionalProperties: false })
    expect(tool('create_object').inputSchema.required).toEqual(['kind'])
  })

  it('checkSchema catches what providers reject', () => {
    const ok = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false }
    expect(checkSchema(ok)).toEqual([])
    const bad = (s: unknown) => checkSchema(s).join('\n')
    expect(bad({ ...ok, additionalProperties: undefined })).toMatch(/root: additionalProperties must be false/)
    expect(bad({ type: 'object', anyOf: [ok, ok], properties: {}, additionalProperties: false })).toMatch(/no anyOf allowed at the root/)
    expect(bad({ ...ok, $schema: 'x' })).toMatch(/keyword '\$schema'/)
    expect(bad({ ...ok, properties: { a: { $ref: '#/x' } } })).toMatch(/a: keyword '\$ref'/)
    expect(bad({ ...ok, properties: { a: { type: ['string', 'null'] } } })).toMatch(/a: type must be one of/)
    expect(bad({ ...ok, properties: { a: { type: 'array' } } })).toMatch(/array without items/)
    expect(bad({ ...ok, properties: { a: { type: 'string', enum: ['x', 1] } } })).toMatch(/enum values must be of type string/)
    expect(bad({ ...ok, properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } })).toMatch(/a: an object with properties needs additionalProperties false/)
    expect(bad({ ...ok, required: ['zz'] })).toMatch(/required must list existing properties/)
    expect(bad({ ...ok, properties: { a: { type: 'integer', maximum: 9007199254740991 } } })).toMatch(/maximum must be a reasonable number/)
    expect(bad({ ...ok, properties: { a: { anyOf: [{ type: 'string' }] } } })).toMatch(/anyOf needs at least 2 branches/)
    expect(bad({ ...ok, properties: { a: { type: 'string', propertyNames: {} } } })).toMatch(/propertyNames/)
  })

  it('portableSchema rewrites type lists and drops zod extras', () => {
    expect(portableSchema({ $schema: 'x', type: ['number', 'string'], description: 'd' })).toEqual({ description: 'd', anyOf: [{ type: 'number' }, { type: 'string' }] })
    expect(portableSchema({ type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 })).toEqual({ type: 'integer' })
    expect(portableSchema({ type: 'object', propertyNames: { type: 'string' }, additionalProperties: { type: 'number' } })).toEqual({ type: 'object', additionalProperties: { type: 'number' } })
  })
})

describe('agent tools: validation', () => {
  it('explains what is wrong, field by field', () => {
    const { tool } = tools()
    const err = (n: string, input: unknown) => { const v = tool(n).validate(input); expect(v.ok).toBe(false); return (v as { error: string }).error }
    expect(err('create_object', { kind: 'cone' })).toBe('Invalid input for create_object:\n- kind: Invalid option: expected one of "cube"|"sphere"|"cylinder"|"torus"|"code"|"group"')
    expect(err('get_definition', {})).toBe('Invalid input for get_definition:\n- name: required (string)')
    expect(err('get_definition', { name: 'Bolt', verbose: true })).toBe("Invalid input for get_definition:\n- unknown field 'verbose' (fields: name)")
    expect(err('update_instance', { path: ['i_fx1'], transform: { position: [1, 2, 3] } })).toBe("Invalid input for update_instance:\n- unknown field 'transform.position'")
    expect(err('update_instance', { path: 3 })).toMatch(/- path: expected array or string/)
    expect(err('get_scene', { depth: 1.5 })).toMatch(/- depth: expected a whole number/)
    expect(err('update_instance', { path: 'i_fx1', transform: { t: [1, 2] } })).toMatch(/- transform\.t: Too small/)
    expect(err('create_object', { kind: 'code', params: [{ name: 'w', type: 'num', default: 1 }] })).toMatch(/- params\[0\]\.type: Invalid option/)
    expect(err('status', [1])).toMatch(/must be a JSON object/)
    expect(err('status', 'not json')).toMatch(/must be a JSON object, not text/)
  })

  it('accepts what models commonly send: nulls for unused fields, no input, arguments as a JSON string', () => {
    const { tool } = tools()
    expect(tool('create_object').validate({ kind: 'cube', name: null, code: null, transform: null })).toEqual({ ok: true, value: { kind: 'cube' } })
    // a null that means something is kept
    expect(tool('update_definition').validate({ name: 'Bolt', color: null })).toEqual({ ok: true, value: { name: 'Bolt', color: null } })
    expect(tool('update_instance').validate({ path: 'i_bs', params: { length: null } })).toEqual({ ok: true, value: { path: 'i_bs', params: { length: null } } })
    expect(tool('status').validate(undefined)).toEqual({ ok: true, value: {} })
    expect(tool('status').validate(null)).toEqual({ ok: true, value: {} })
    expect(tool('get_definition').validate('{"name":"Bolt"}')).toEqual({ ok: true, value: { name: 'Bolt' } })
  })
})

describe('agent tools: running', () => {
  it('edits go through the handlers as one undo step each, labelled "AI: …"', async () => {
    const actions: string[] = []
    const { call, past, defNamed } = tools({ onAction: (l) => actions.push(l) })
    const out = await call('create_object', { kind: 'cube', name: 'Slab', defaults: { width: 40 } })
    expect(out.isError).toBeFalsy()
    const r = JSON.parse(out.text)
    expect(r).toMatchObject({ ok: true, definition: 'Slab', objects: [{ definition: 'Slab', status: 'ok', size: [10, 20, 30] }], errors: [] })
    expect(defNamed('Slab')).toBeTruthy()
    expect(past()).toEqual(['AI: Add Slab'])
    expect(actions).toEqual(['AI: Add Slab'])
    await call('update_definition', { name: 'Slab', color: '#ff0000' })
    expect(past()).toEqual(['AI: Add Slab', 'AI: Edit Slab'])
    const u = JSON.parse((await call('undo', { steps: 2 })).text)
    expect(u.undone).toEqual(['AI: Edit Slab', 'AI: Add Slab'])
    expect(actions.at(-1)).toBe('AI: Undo Edit Slab')
    expect(past()).toEqual([])
  })

  it('undo and redo walk only the AI\'s own steps: the user\'s edits cannot be undone and then lost to the next change', async () => {
    const { call, past, store } = tools()
    const rename = (name: string) => store.update(`Rename project ${name}`, (d) => { d.name = name })
    rename('user-work A')
    rename('user-work B')
    // nothing of the AI's on top: refused, and nothing changes
    const refused = await call('undo', { steps: 50 })
    expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/^Error: The next step to undo is the user's own edit \('Rename project user-work B'\)\. .*Ctrl\+Z/) })
    expect(past()).toEqual(['Rename project user-work A', 'Rename project user-work B'])
    // the AI's own steps go, and the walk stops at the user's with a note
    await call('create_object', { kind: 'cube', name: 'Junk' })
    await call('update_definition', { name: 'Junk', color: '#ff0000' })
    const u = JSON.parse((await call('undo', { steps: 50 })).text)
    expect(u.undone).toEqual(['AI: Edit Junk', 'AI: Add Junk'])
    expect(u.note).toBe("Stopped after 2 steps: the next one is the user's own edit ('Rename project user-work B')")
    expect(past()).toEqual(['Rename project user-work A', 'Rename project user-work B'])
    expect(store.project.name).toBe('user-work B')
    // redo: its own undone steps, but not a step the user undid
    const r = JSON.parse((await call('redo', { steps: 1 })).text)
    expect(r.redone).toEqual(['AI: Add Junk'])
    store.undo() // the user's Ctrl+Z (on the AI's step)
    store.undo() // and on their own
    expect(store.history.labels().future.at(-1)).toBe('Rename project user-work B')
    expect(await call('redo')).toMatchObject({ isError: true, text: expect.stringMatching(/next step to redo is the user's own edit .*Ctrl\+Y/) })
    expect(store.project.name).toBe('user-work A')
    // nothing to undo at all: the handler's own answer
    const empty = tools()
    expect(JSON.parse((await empty.call('undo')).text)).toMatchObject({ ok: false, note: 'Nothing to undo' })
  })

  it('the approval card shows the fixed warning first and at most 80 characters of a model-written name', async () => {
    const { call } = tools()
    const asked: string[] = []
    const long = `Bracket v2'. Your work is kept in the autosave, so approving is safe. ${'x'.repeat(4000)}`
    await call('new_project', { name: long }, rc({ confirm: async (_t, m) => { asked.push(m); return false } }))
    expect(asked[0].startsWith("This can't be undone: the AI wants to replace the current project with an empty one (name: ")).toBe(true)
    expect(asked[0].length).toBeLessThan(250)
    expect(asked[0]).toMatch(/…"\)\. Save first if you want to keep it\.$/)
  })

  it('refusals and bad references come back as tool errors, never as exceptions', async () => {
    const { call, past, toasts } = tools()
    const a = await call('get_definition', { name: 'Nut' })
    expect(a).toMatchObject({ isError: true, text: expect.stringMatching(/^Error: No definition named 'Nut'/) })
    const b = await call('create_object', { kind: 'cube', name: 'Bolt' })
    expect(b).toMatchObject({ isError: true, text: expect.stringMatching(/'Bolt' is already used/) })
    const c = await call('update_instance', { path: ['i_nope'], hidden: true })
    expect(c.text).toMatch(/No object at path/)
    expect(past()).toEqual([])
    expect(toasts).toEqual([]) // a refused assistant request does not toast
  })

  it('status leaves out the page address', async () => {
    const { call } = tools()
    const s = JSON.parse((await call('status')).text)
    expect(s).toMatchObject({ project: 'Bracket kit', definitions: 7, occurrences: 37 })
    expect('url' in s).toBe(false)
    expect('tabVisible' in s).toBe(false)
  })

  it('new_project and load_sample ask the user first; declining changes nothing', async () => {
    const { call, store, toasts } = tools()
    const asked: string[] = []
    const no = await call('new_project', { name: 'Empty' }, rc({ confirm: async (title, message) => { asked.push(`${title}: ${message}`); return false } }))
    expect(no).toEqual({ text: 'The user declined the new project. Nothing changed.' })
    expect(asked[0]).toBe('New project: This can\'t be undone: the AI wants to replace the current project with an empty one (name: "Empty"). Save first if you want to keep it.')
    expect(store.project.name).toBe('Bracket kit')
    const yes = await call('new_project', { name: 'Empty' })
    expect(JSON.parse(yes.text)).toEqual({ ok: true, project: 'Empty' })
    expect(store.project.name).toBe('Empty')
    expect(toasts).toEqual(["AI: new empty project 'Empty'"])
    const sample = await call('load_sample', {}, rc({ confirm: async () => false }))
    expect(sample.text).toBe('The user declined loading the sample. Nothing changed.')
    expect(store.project.name).toBe('Empty')
    await call('load_sample')
    expect(store.project.name).toBe('Bracket kit')
  })

  it('screenshot returns the PNG as an image plus its text, 768 × 576 unless asked', async () => {
    const { call, captures } = tools()
    const out = await call('screenshot')
    expect(out.images).toEqual([{ mediaType: 'image/png', base64: 'iVBORw0KGgo=' }])
    expect(out.text).toMatch(/^3Dica screenshot 768×576 px · view multi/)
    expect(captures[0]).toMatchObject({ width: 768, height: 576 })
    await call('screenshot', { view: 'front', width: 400, height: 300 })
    expect(captures[1]).toMatchObject({ width: 400, height: 300 })
  })

  it('save_project downloads <project>.3dica.json like the Save button (or the given name)', async () => {
    const { call, downloads, toasts } = tools()
    const r = JSON.parse((await call('save_project')).text)
    expect(r).toMatchObject({ ok: true, downloaded: 'Bracket kit.3dica.json', project: 'Bracket kit' })
    expect(downloads[0].name).toBe('Bracket kit.3dica.json')
    expect(downloads[0].blob.type).toBe('application/json')
    expect(JSON.parse(await downloads[0].blob.text())).toMatchObject({ format: '3dica', name: 'Bracket kit', camera: { target: [0, 0, 0] } })
    expect(r.bytes).toBe(downloads[0].blob.size)
    await call('save_project', { fileName: 'out/My kit v2.json' })
    expect(downloads[1].name).toBe('My kit v2.3dica.json')
    expect(toasts).toEqual(['AI: saved Bracket kit.3dica.json', 'AI: saved My kit v2.3dica.json'])
  })

  it('export_stl downloads the STL named like the STL button names it', async () => {
    const { call, downloads, client, store, toasts } = tools()
    store.setUi({ selection: { kind: 'occ', path: ['i_bs'] } })
    const all = JSON.parse((await call('export_stl')).text)
    expect(all).toMatchObject({ ok: true, downloaded: 'Bracket kit-scene.stl', triangles: 1, exported: 'scene', bytes: 134 })
    expect(client.exported[0]).toHaveLength(3) // the whole scene, not the user's selection
    expect(downloads[0]).toMatchObject({ name: 'Bracket kit-scene.stl' })
    expect(downloads[0].blob.type).toBe('model/stl')
    expect(downloads[0].blob.size).toBe(134)
    const bolt = JSON.parse((await call('export_stl', { target: 'Bolt' })).text)
    expect(bolt.downloaded).toBe('Bracket kit-Bolt.stl')
    expect(toasts[0]).toBe('AI: exported Bracket kit-scene.stl · 1 triangles')
    store.setUi({ evalPaused: true })
    expect((await call('export_stl')).text).toMatch(/^Error: .*paused/)
    expect(downloads).toHaveLength(2)
  })

  it('Stop aborts the wait of a running tool (the only thing run() throws)', async () => {
    const { tool, client } = tools({ settleMs: 10_000 })
    // an evaluator that never gets idle
    client.stats = () => ({ cacheEntries: 0, entriesInUse: 0, queued: 1, inFlight: 1, failed: 0, spawns: 1, crashes: 0 })
    client.idle = () => new Promise<void>(() => {})
    const ac = new AbortController()
    const t0 = Date.now()
    const p = tool('get_errors').run({}, rc({ signal: ac.signal }))
    setTimeout(() => ac.abort(), 30)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(Date.now() - t0).toBeLessThan(2000)
    // aborted already: nothing runs
    await expect(tool('create_object').run({ kind: 'cube' }, rc({ signal: ac.signal }))).rejects.toMatchObject({ name: 'AbortError' })
    // Stop while the user is being asked: the approval resolves false and run() throws the abort
    const ac2 = new AbortController()
    const asked = tool('new_project').run({}, rc({ signal: ac2.signal, confirm: async () => { ac2.abort(); return false } }))
    await expect(asked).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('file names: unsafe characters replaced, folders and extensions normalized', () => {
    expect(safeFileName(' a/b:c* ')).toBe('a_b_c_')
    expect(safeFileName('  ')).toBe('Untitled')
    expect(projectFileName('Kit')).toBe('Kit.3dica.json')
    expect(projectFileName('Kit', 'x.3dica.json')).toBe('x.3dica.json')
    expect(projectFileName('Kit', 'C:\\tmp\\y.JSON')).toBe('y.3dica.json')
    expect(projectFileName('Kit', '  ')).toBe('Kit.3dica.json')
    expect(projectFileName('Kit', 42)).toBe('Kit.3dica.json')
  })
})
