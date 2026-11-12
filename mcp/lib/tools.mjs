// The MCP tools of the 3Dica server. Each tool forwards to the connected 3Dica tab over the bridge (the handlers in
// src/mcp/handlers.ts do the work there), except help (local) and the file parts of save_project / load_project /
// export_stl (the server reads and writes the files, so they land on the user's disk, not in a browser download).
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { BridgeError } from './bridge.mjs'
import { codeApiCheatSheet } from './docs.mjs'

// ───────────────────────────── shared schemas ─────────────────────────────

const vec3 = z.array(z.number()).length(3)
const PATH_DOC = 'Instance path: the instance ids from the scene root down to the object, e.g. ["i_fx1", "i_b1"] (a "i_fx1/i_b1" string works too). get_scene lists them.'
export const pathSchema = z.union([z.array(z.string()), z.string()]).describe(PATH_DOC)
export const transformSchema = z.object({
  t: vec3.optional().describe('translation [x, y, z] in mm'),
  r: vec3.optional().describe('rotation [x, y, z] in DEGREES, applied X then Y then Z like OpenSCAD rotate([x, y, z])'),
  s: vec3.optional().describe('scale factors [x, y, z] (no zeros)'),
}).describe('Local transform in the parent group\'s frame; omitted fields keep their value (create/add: identity).')
const paramValue = z.union([z.number(), z.boolean(), z.string()])
export const paramDefSchema = z.object({
  name: z.string().describe('a JavaScript identifier, unique in the definition'),
  type: z.enum(['number', 'boolean', 'choice']),
  default: paramValue.describe('number for "number", true/false for "boolean", one of options for "choice"'),
  min: z.number().optional(), max: z.number().optional(), step: z.number().optional(),
  options: z.array(z.string()).optional().describe('required for "choice"'),
})
const color = z.string().describe('#rrggbb')
const opSchema = z.enum(['none', 'union', 'subtract', 'intersect'])
const targetSchema = z.union([z.string(), z.array(z.string())])

// ───────────────────────────── result helpers ─────────────────────────────

const text = (t) => ({ content: [{ type: 'text', text: t }] })
const json = (v) => text(JSON.stringify(v, null, 2))
const fail = (message) => ({ content: [{ type: 'text', text: `Error: ${message}` }], isError: true })

/** Resolve a file path given by the model: absolute, ~/…, or relative to the server's working directory. */
export function resolveUserPath(p, cwd = process.cwd(), home = process.env.HOME || process.env.USERPROFILE || '') {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path must be a file path')
  let s = p.trim()
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(home, s.slice(1))
  return path.resolve(cwd, s)
}

async function writeFileChecked(abs, data) {
  let existed = false
  try {
    const st = await fs.stat(abs)
    if (st.isDirectory()) throw new Error(`${abs} is a directory — give a file name`)
    existed = true
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e
  }
  try {
    await fs.writeFile(abs, data)
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new Error(`The folder ${path.dirname(abs)} does not exist`)
    throw e
  }
  return existed
}

/**
 * Register every tool on `server` (an McpServer).
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {{ request: (method: string, params?: object, opts?: object) => Promise<any>, info: () => object, connectHint: () => string }} bridge
 * @param {{ cwd?: string, log?: (m: string) => void }} [opts]
 */
export function registerTools(server, bridge, opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const log = opts.log ?? (() => {})

  /** forward a tool call to the app; app/bridge errors become tool errors (isError) the model can read */
  const forward = (method, timeoutMs) => async (args) => {
    try {
      return json(await bridge.request(method, args ?? {}, { timeoutMs }))
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }
  const tool = (name, config, cb) => server.registerTool(name, config, cb)
  const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }

  // ── status & reading ──

  tool('status', {
    title: 'Connection and app status',
    description: 'Is a 3Dica tab connected? Returns the bridge state, and from the tab: project name, number of definitions and occurrences, selection, view mode, evaluator state, error count, the last undo/redo labels and the camera. Call it first; when no tab is connected it explains how to connect one.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const out = { server: bridge.info() }
    try {
      out.app = await bridge.request('status', {}, { timeoutMs: 15_000 })
      out.connected = true
    } catch (e) {
      out.connected = false
      out.hint = e instanceof BridgeError && e.code !== 'no-tab' ? e.message : bridge.connectHint()
    }
    return json(out)
  })

  tool('get_scene', {
    title: 'Scene tree',
    description: 'The occurrence tree of the scene: for every placed object its path (instance ids — use it in other tools), label, definition, kind (code/group) and op, operand role inside a boolean (base/cut/other), local transform {t (mm), r (degrees), s}, color and parameter overrides, hidden flag, evaluation status (idle/pending/ok/error) and world bounding box {min, max, size} in mm. Linked copies appear once per copy (same instance ids under different parents).',
    inputSchema: {
      path: pathSchema.optional().describe('only this subtree'),
      depth: z.number().int().min(1).optional().describe('max depth to list'),
      maxNodes: z.number().int().min(1).max(5000).optional().describe('cap on listed objects (default 500)'),
      bbox: z.boolean().optional().describe('include world bounding boxes (default true)'),
    },
    annotations: RO,
  }, forward('get_scene'))

  tool('list_definitions', {
    title: 'List definitions (the Library)',
    description: 'Every definition: name, kind (code/group), op (groups), params (ParamDef list for code), color, copies (occurrences in the scene), instances (placement records), usedByCode / uses (part() references), status and error {kind, message, line, col}.',
    inputSchema: {},
    annotations: RO,
  }, forward('list_definitions'))

  tool('get_definition', {
    title: 'Read one definition',
    description: 'One definition in full: for code definitions the code and params; for groups the op and the children (instance id, definition, label, transform, overrides, color, hidden); plus color, usage, status and error.',
    inputSchema: { name: z.string().describe('definition name, e.g. "Bolt"') },
    annotations: RO,
  }, forward('get_definition'))

  tool('get_errors', {
    title: 'Evaluation errors',
    description: 'Every definition currently in error: {definition, kind (syntax/runtime/result/cycle/dependency/timeout/crash), message, line, col, in (the inner definition that failed), trace}. Waits for evaluation to finish first.',
    inputSchema: {},
    annotations: RO,
  }, forward('get_errors'))

  tool('help', {
    title: 'Code API cheat sheet',
    description: 'The 3Dica code API: the function-body contract, params, part(), every JSCAD function in scope by plain name, units and angle conventions, limits and an example. Also available as the resource threedica://docs/code-api.',
    inputSchema: {},
    annotations: RO,
  }, async () => text(codeApiCheatSheet()))

  // ── creating and editing (each is one undo step "MCP: …"; the result reports evaluation status and errors) ──

  tool('create_object', {
    title: 'Create a new object',
    description: 'Create a NEW definition and place one instance of it. kind cube/sphere/cylinder/torus start from the toolbar templates (parameters width/depth/height; radius/segments; radius/height/segments; innerRadius/outerRadius), sitting on Z = 0; kind "code" starts from the blank code template unless you pass code; kind "group" makes an empty group (op none/union/subtract/intersect) to fill with add_instance (parent: its name). Without a transform the object is placed to the right of the existing ones, like the toolbar does. Waits for evaluation and returns the new path plus status, size in mm, warnings and errors.',
    inputSchema: {
      kind: z.enum(['cube', 'sphere', 'cylinder', 'torus', 'code', 'group']),
      name: z.string().optional().describe('definition name (unique; default Cube, Cube 2, …)'),
      code: z.string().optional().describe('code kinds: the function body (return a Geom3 or an array)'),
      params: z.array(paramDefSchema).optional().describe('code kinds: replaces the parameter list'),
      defaults: z.record(z.string(), paramValue).optional().describe('code kinds: change the defaults of existing parameters, e.g. {"width": 40, "height": 5}'),
      op: opSchema.optional().describe('group only'),
      parent: z.union([z.array(z.string()), z.string()]).optional().describe('where to place it: an instance path of a group in the scene, or a group definition name (then every copy of that group gets it). Default: the scene root.'),
      transform: transformSchema.optional(),
      color: color.optional(),
    },
    annotations: EDIT,
  }, forward('create_object'))

  tool('update_definition', {
    title: 'Edit a definition',
    description: 'Change a definition — every copy of it updates (linked). code: new function body; params: replace the ParamDef list; defaults: change default values of existing parameters; op: group operation; color (#rrggbb, null clears); rename: new name (part() calls are rewritten). Waits for evaluation and returns status, size, warnings and errors with line numbers (line 1 = first line of the body).',
    inputSchema: {
      name: z.string().describe('current definition name'),
      code: z.string().optional(),
      params: z.array(paramDefSchema).optional(),
      defaults: z.record(z.string(), paramValue).optional(),
      op: opSchema.optional(),
      color: color.nullable().optional(),
      rename: z.string().optional(),
    },
    annotations: EDIT,
  }, forward('update_definition'))

  tool('add_instance', {
    title: 'Place a copy of a definition',
    description: 'Place another instance (a LINKED copy) of an existing definition inside a group. parent: instance path of a group in the scene, or a group definition name; default the scene root. transform defaults to identity (at the parent\'s origin). params are this instance\'s parameter overrides. Returns the new path and the evaluation report.',
    inputSchema: {
      definition: z.string(),
      parent: z.union([z.array(z.string()), z.string()]).optional(),
      transform: transformSchema.optional(),
      params: z.record(z.string(), paramValue).optional().describe('parameter overrides, e.g. {"length": 20}'),
      label: z.string().optional().describe('instance label shown in the tree instead of the definition name'),
      color: color.optional(),
      index: z.number().int().optional().describe('position among the parent\'s children (default: last). In a subtract group child 0 is the base.'),
    },
    annotations: EDIT,
  }, forward('add_instance'))

  tool('update_instance', {
    title: 'Edit one placed object',
    description: 'Change one instance: transform (merged: pass only t, r or s to change just that), params (overrides; a null value removes that override), label (null clears), color (null clears), hidden. Note: an instance inside a group definition exists in every copy of that group, so the change shows in all of them (the result says so).',
    inputSchema: {
      path: pathSchema,
      transform: transformSchema.optional(),
      params: z.record(z.string(), paramValue.nullable()).optional(),
      label: z.string().nullable().optional(),
      color: color.nullable().optional(),
      hidden: z.boolean().optional(),
    },
    annotations: EDIT,
  }, forward('update_instance'))

  tool('move_instance', {
    title: 'Move an object to another group',
    description: 'Re-parent an instance into another group (like dragging it in the tree). Its world position is kept (the local transform is recomputed). toParent: instance path of the target group ([] = scene root). index: position among the target\'s children (default last; in a subtract group index 0 is the base, later children cut).',
    inputSchema: {
      path: pathSchema,
      toParent: z.union([z.array(z.string()), z.string()]).describe('instance path of a group, or [] for the scene root'),
      index: z.number().int().optional(),
    },
    annotations: EDIT,
  }, forward('move_instance'))

  tool('duplicate', {
    title: 'Duplicate an object',
    description: 'Copy an instance next to the original (offset along the parent\'s X by its width + 5 mm unless offset is given). mode "linked" (default) places the SAME definition again (Ctrl+D); "unique" first clones the definition (Ctrl+Shift+D), so the copy can change independently.',
    inputSchema: {
      path: pathSchema,
      mode: z.enum(['linked', 'unique']).optional(),
      offset: z.number().optional().describe('X offset in mm'),
    },
    annotations: EDIT,
  }, forward('duplicate'))

  tool('make_unique', {
    title: 'Make unique',
    description: 'Point this instance at a clone of its definition (one level deep), so it can be edited without changing the other copies. Refused when it is the only instance record; to diverge a child of a linked group, make the group unique first. Returns the new definition name.',
    inputSchema: { path: pathSchema },
    annotations: EDIT,
  }, forward('make_unique'))

  tool('wrap', {
    title: 'Wrap in a group or boolean',
    description: 'Wrap an instance in a new group with op none (plain group), union, subtract or intersect; the instance becomes its first child (for subtract: the base). Add cutters with add_instance / create_object (parent: the new group) or move_instance. Returns the new group path and name.',
    inputSchema: {
      path: pathSchema,
      op: opSchema.optional().describe('default none'),
      name: z.string().optional().describe('name for the new group definition (default Group / Union / Subtract / Intersect)'),
    },
    annotations: EDIT,
  }, forward('wrap'))

  tool('ungroup', {
    title: 'Ungroup',
    description: 'Replace a group instance by copies of its children (world positions kept). The group definition stays in the Library.',
    inputSchema: { path: pathSchema },
    annotations: EDIT,
  }, forward('ungroup'))

  tool('delete', {
    title: 'Delete',
    description: 'Delete one placed object ({path}) — its definition stays — or a whole definition ({definition}). A definition with instances needs cascade: true (all its instances go too); one that other code calls with part() is refused. Undoable with undo.',
    inputSchema: {
      path: pathSchema.optional(),
      definition: z.string().optional(),
      cascade: z.boolean().optional(),
    },
    annotations: DESTRUCTIVE,
  }, forward('delete'))

  tool('undo', {
    title: 'Undo',
    description: 'Undo the last steps of the app\'s shared undo history — the user\'s own edits too, so check the labels it returns (yours start with "MCP: ").',
    inputSchema: { steps: z.number().int().min(1).max(50).optional() },
    annotations: EDIT,
  }, forward('undo'))

  tool('redo', {
    title: 'Redo',
    description: 'Redo steps undone with undo (or Ctrl+Z in the app).',
    inputSchema: { steps: z.number().int().min(1).max(50).optional() },
    annotations: EDIT,
  }, forward('redo'))

  // ── selection and the user's view (UI only; not in the undo history) ──

  tool('select', {
    title: 'Select in the app',
    description: 'Change the user\'s selection: {path} selects a placed object (like a tree click), {definition} selects a Library definition (which shows it isolated, like a Library click), {} clears it. Screenshots do not need a selection — use their target option.',
    inputSchema: { path: pathSchema.optional(), definition: z.string().optional() },
    annotations: EDIT,
  }, forward('select'))

  tool('set_view', {
    title: 'Change the user\'s view',
    description: 'Change what the user sees: mode context/isolate (isolate shows the selection alone), ghost (fade unselected objects), preset camera front/right/top/iso, all (frame everything) or selection (frame it). Screenshots never depend on this — they use their own camera.',
    inputSchema: {
      mode: z.enum(['context', 'isolate']).optional(),
      ghost: z.boolean().optional(),
      preset: z.enum(['front', 'right', 'top', 'iso', 'all', 'selection']).optional(),
    },
    annotations: EDIT,
  }, forward('set_view'))

  // ── projects and files ──

  tool('new_project', {
    title: 'New empty project',
    description: 'Replace the current project with an empty one, without the app\'s confirmation dialog. This is NOT undoable (the undo history is cleared) — save_project first if the user may want the current one back.',
    inputSchema: { name: z.string().optional() },
    annotations: DESTRUCTIVE,
  }, forward('new_project'))

  tool('load_sample', {
    title: 'Load the sample',
    description: 'Replace the current project with the sample "Bracket kit" (two linked fixtures with plates, washers and bolts, and a "Bolt sizes" row made with part()). Not undoable.',
    inputSchema: {},
    annotations: DESTRUCTIVE,
  }, forward('load_sample'))

  tool('save_project', {
    title: 'Save the project to a file',
    description: 'Write the current project as a .3dica.json file at path (absolute, ~/…, or relative to the MCP server\'s working directory). Overwrites an existing file. The folder must exist.',
    inputSchema: { path: z.string().describe('e.g. ./my-part.3dica.json') },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ path: p }) => {
    try {
      const abs = resolveUserPath(p, cwd)
      const r = await bridge.request('save_project', {}, { timeoutMs: 30_000 })
      const existed = await writeFileChecked(abs, r.text)
      return json({ ok: true, path: abs, project: r.name, bytes: Buffer.byteLength(r.text), overwritten: existed })
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  })

  tool('load_project', {
    title: 'Open a project file',
    description: 'Read a .3dica.json file from disk (path absolute, ~/… or relative to the server\'s working directory) and open it in the app, replacing the current project (not undoable). Unlike the app\'s Open, this RUNS the file\'s code without asking "This file contains code that runs on your computer. Run it?" — the request comes from the user\'s own assistant, so only load files you or the user trust.',
    inputSchema: { path: z.string() },
    annotations: DESTRUCTIVE,
  }, async ({ path: p }) => {
    try {
      const abs = resolveUserPath(p, cwd)
      let textIn
      try { textIn = await fs.readFile(abs, 'utf8') } catch (e) { throw new Error(e && e.code === 'ENOENT' ? `No file at ${abs}` : `Can't read ${abs}: ${e?.message ?? e}`) }
      const r = await bridge.request('load_project', { text: textIn, fileName: path.basename(abs) }, { timeoutMs: 90_000 })
      return json({ path: abs, ...r })
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  })

  tool('export_stl', {
    title: 'Export STL',
    description: 'Write a binary STL file at path (absolute, ~/… or relative to the server\'s working directory). target: omitted = the whole visible scene (not just the user\'s selection); an instance path = that object in world position; a definition name = that definition alone at the origin with its defaults. Solids are written as they are (not unioned). Returns the triangle count.',
    inputSchema: {
      path: z.string().describe('e.g. ./plate.stl'),
      target: targetSchema.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ path: p, target }) => {
    try {
      const abs = resolveUserPath(p, cwd)
      const r = await bridge.request('export_stl', target === undefined ? {} : { target }, { timeoutMs: 150_000 })
      const data = Buffer.from(r.base64, 'base64')
      const existed = await writeFileChecked(abs, data)
      const out = { ok: true, path: abs, bytes: data.length, triangles: r.triangles, exported: r.label, overwritten: existed }
      if (r.skipped?.length) out.skipped = r.skipped
      return json(out)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  })

  // ── seeing it ──

  tool('screenshot', {
    title: 'Screenshot the 3D view',
    description: 'Render the model and return a PNG image plus a short text (what is shown, framed box size in mm, triangles, scale, errors). It never moves the user\'s camera or changes their selection. view: "multi" (default; a 2×2 composite of front | right / top | iso, orthographic, with labels, an axis triad and a scale bar), front (looking +Y), right (looking −X), top (looking −Z, +Y up), iso, or current (the user\'s perspective camera). target: an instance path or definition name to frame; with isolate: true it is drawn alone at the origin (a definition with its defaults, a path with that copy\'s overrides). style: "clean" (default: plain materials, no selection highlight, ghosting, boolean operands or gizmo) or "as-seen" (exactly the user\'s materials and selection; view current also shows the gizmo). Size up to 2048 × 2048.',
    inputSchema: {
      view: z.enum(['current', 'front', 'right', 'top', 'iso', 'multi']).optional(),
      target: targetSchema.optional().describe('instance path (["i_fx1","i_plate"] or "i_fx1/i_plate") or definition name'),
      isolate: z.boolean().optional(),
      width: z.number().int().min(16).max(2048).optional().describe('default 800'),
      height: z.number().int().min(16).max(2048).optional().describe('default 600'),
      style: z.enum(['clean', 'as-seen']).optional(),
      grid: z.boolean().optional().describe('draw the 10 mm grid and XY axes (default true)'),
    },
    annotations: RO,
  }, async (args) => {
    try {
      const r = await bridge.request('screenshot', args ?? {}, { timeoutMs: 90_000 })
      return { content: [{ type: 'image', data: r.image, mimeType: r.mimeType ?? 'image/png' }, { type: 'text', text: r.text }] }
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  })

  // ── resource ──
  server.registerResource('code-api', 'threedica://docs/code-api', {
    title: '3Dica code API',
    description: 'Cheat sheet for writing 3Dica code objects (JSCAD 2.13): contract, params, part(), functions in scope, conventions, limits.',
    mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: codeApiCheatSheet() }] }))

  log('tools registered')
}

/** Tool names, in registration order (docs and tests). */
export const TOOL_NAMES = [
  'status', 'get_scene', 'list_definitions', 'get_definition', 'get_errors', 'help',
  'create_object', 'update_definition', 'add_instance', 'update_instance', 'move_instance', 'duplicate', 'make_unique', 'wrap', 'ungroup', 'delete',
  'undo', 'redo', 'select', 'set_view', 'new_project', 'load_sample', 'save_project', 'load_project', 'export_stl', 'screenshot',
]
