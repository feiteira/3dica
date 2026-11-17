// The tools the in-app chat offers a model (contract: ./types.ts AgentTool). They come from the same catalog as the
// MCP server's (shared/tool-catalog.mjs) and run through the same handlers (src/mcp/handlers.ts) with history labels
// "AI: …". What differs from MCP: save_project and export_stl download in the browser (named like the Save and STL
// buttons do), load_project is not offered (the user opens files with Open), status has no bridge info, new_project
// and load_sample ask the user first, and screenshots default to 768 × 576.
//
// Schemas: the zod shapes become JSON Schema with z.toJSONSchema, then are narrowed to a plain subset that Anthropic
// and OpenAI-compatible function calling both accept (no $schema, no type arrays, no propertyNames, no ±2^53 integer
// bounds). checkSchema() is the strict sanity check the unit tests run on every tool.
import { z } from 'zod'
import type { AppContext, EvalClientApi } from '../app/context'
import type { AgentTool, JsonSchema, ToolOutput, ToolRunContext, ToolValidation } from './types'
import { AUDIENCES, toolCatalog, type ToolSpec } from '../../shared/tool-catalog.mjs'
import { createHandlers, type Handler } from '../mcp/handlers'
import { stlFileName } from '../core/evalspec'
import { abortable, abortError, isAbortError } from './abort'

export const CHAT_LABEL_PREFIX = 'AI'

export interface ChatToolOptions {
  /** max wait for the evaluator after a change (handlers' default: eval timeout + 5 s) */
  settleMs?: number
  /** called with the history label ("AI: Add Cube") after every call that changed the project */
  onAction?: (label: string) => void
}

// ───────────────────────────── JSON Schema ─────────────────────────────

const SAFE_INT = Number.MAX_SAFE_INTEGER
const KEYWORDS = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', 'minimum', 'maximum', 'minItems', 'maxItems'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Narrow one z.toJSONSchema node to the portable subset (see the file header). Returns a new object. */
export function portableSchema(node: unknown): JsonSchema {
  if (!isObj(node)) return {}
  const out: JsonSchema = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === '$schema' || k === 'propertyNames') continue
    if ((k === 'minimum' && v === -SAFE_INT) || (k === 'maximum' && v === SAFE_INT)) continue
    if (k === 'properties' && isObj(v)) out.properties = Object.fromEntries(Object.entries(v).map(([p, s]) => [p, portableSchema(s)]))
    else if ((k === 'items' || k === 'additionalProperties') && isObj(v)) out[k] = portableSchema(v)
    else if (k === 'anyOf' && Array.isArray(v)) out.anyOf = v.map(portableSchema)
    else out[k] = v
  }
  // type: ['number', 'boolean'] → anyOf: [{ type: 'number' }, { type: 'boolean' }] (not every provider takes type lists)
  if (Array.isArray(out.type)) {
    const types = out.type as string[]
    delete out.type
    out.anyOf = types.map((t) => ({ type: t }))
  }
  // z.string().describe(…).nullable() puts the description inside the first branch: lift it to the field
  if (Array.isArray(out.anyOf) && out.description === undefined) {
    const described = (out.anyOf as JsonSchema[]).filter((b) => typeof b.description === 'string')
    if (described.length === 1) {
      out.description = described[0].description
      delete described[0].description
    }
  }
  // keep `description` first (easier to read in logs and tests)
  if (out.description !== undefined) {
    const { description, ...rest } = out
    return { description, ...rest }
  }
  return out
}

/** The input schema of a tool: an object with additionalProperties false at the root. */
export function inputSchemaOf(shape: Record<string, z.ZodType>): JsonSchema {
  const s = portableSchema(z.toJSONSchema(z.object(shape)))
  return { type: 'object', properties: s.properties ?? {}, ...(Array.isArray(s.required) && s.required.length ? { required: s.required } : {}), additionalProperties: false }
}

/**
 * Strict sanity check of a tool input schema: only the portable keywords, one type per node, `required` names real
 * properties, objects close with additionalProperties false (or a schema for records), enums are non-empty lists of
 * one primitive type, unions have ≥ 2 branches. Returns the problems ([] = fine).
 */
export function checkSchema(schema: unknown): string[] {
  const problems: string[] = []
  if (!isObj(schema)) return ['the schema is not an object']
  if (schema.type !== 'object') problems.push('root: type must be "object"')
  if (schema.additionalProperties !== false) problems.push('root: additionalProperties must be false')
  if (!isObj(schema.properties)) problems.push('root: properties missing')
  for (const k of ['anyOf', 'oneOf', 'allOf', 'not', 'enum']) if (k in schema) problems.push(`root: no ${k} allowed at the root`)
  const walk = (n: unknown, at: string) => {
    if (!isObj(n)) { problems.push(`${at}: not a schema object`); return }
    for (const k of Object.keys(n)) if (!KEYWORDS.has(k)) problems.push(`${at}: keyword '${k}' is not allowed`)
    if (n.description !== undefined && (typeof n.description !== 'string' || !n.description)) problems.push(`${at}: description must be text`)
    if (n.anyOf !== undefined) {
      if (n.type !== undefined) problems.push(`${at}: anyOf next to type`)
      if (!Array.isArray(n.anyOf) || n.anyOf.length < 2) problems.push(`${at}: anyOf needs at least 2 branches`)
      else n.anyOf.forEach((b, i) => walk(b, `${at}.anyOf[${i}]`))
      return
    }
    if (typeof n.type !== 'string' || !TYPES.has(n.type)) { problems.push(`${at}: type must be one of ${[...TYPES].join(', ')}`); return }
    for (const k of ['minimum', 'maximum', 'minItems', 'maxItems']) {
      if (n[k] !== undefined && (typeof n[k] !== 'number' || !Number.isFinite(n[k]) || Math.abs(n[k] as number) >= SAFE_INT)) problems.push(`${at}: ${k} must be a reasonable number`)
    }
    if ((n.minimum !== undefined || n.maximum !== undefined) && n.type !== 'number' && n.type !== 'integer') problems.push(`${at}: minimum/maximum on a ${n.type}`)
    if ((n.minItems !== undefined || n.maxItems !== undefined) && n.type !== 'array') problems.push(`${at}: minItems/maxItems on a ${n.type}`)
    if (n.enum !== undefined) {
      if (!Array.isArray(n.enum) || n.enum.length === 0) problems.push(`${at}: enum must be a non-empty list`)
      else if (!n.enum.every((v) => typeof v === (n.type === 'integer' ? 'number' : n.type))) problems.push(`${at}: enum values must be of type ${n.type}`)
    }
    if (n.type === 'array') {
      if (n.items === undefined) problems.push(`${at}: array without items`)
      else walk(n.items, `${at}.items`)
    } else if (n.items !== undefined) problems.push(`${at}: items on a ${n.type}`)
    if (n.type === 'object') {
      const props = n.properties
      if (props !== undefined && !isObj(props)) problems.push(`${at}: properties must be an object`)
      if (isObj(props)) {
        for (const [p, s] of Object.entries(props)) walk(s, `${at}.${p}`)
        if (n.additionalProperties !== false) problems.push(`${at}: an object with properties needs additionalProperties false`)
      } else if (!isObj(n.additionalProperties)) problems.push(`${at}: an object needs properties or an additionalProperties schema`)
      if (isObj(n.additionalProperties)) walk(n.additionalProperties, `${at}.additionalProperties`)
      if (n.required !== undefined) {
        if (!Array.isArray(n.required) || !n.required.every((r) => typeof r === 'string' && isObj(props) && r in props)) problems.push(`${at}: required must list existing properties`)
      }
    } else {
      for (const k of ['properties', 'required', 'additionalProperties']) if (n[k] !== undefined) problems.push(`${at}: ${k} on a ${n.type}`)
    }
  }
  if (isObj(schema.properties)) {
    for (const [p, s] of Object.entries(schema.properties)) walk(s, p)
    if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((r) => typeof r === 'string' && r in (schema.properties as object)))) {
      problems.push('root: required must list existing properties')
    }
  }
  for (const k of Object.keys(schema)) if (!['type', 'properties', 'required', 'additionalProperties', 'description'].includes(k)) problems.push(`root: keyword '${k}' is not allowed`)
  return problems
}

// ───────────────────────────── validation ─────────────────────────────

type Issue = z.core.$ZodIssue

const where = (path: PropertyKey[]): string => path.reduce<string>((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${String(k)}` : String(k)), '')

function issueText(issue: Issue, fields: string[]): string {
  const at = where(issue.path)
  const msg = issue.message.replace(/^Invalid input: /, '')
  let text: string
  if (issue.code === 'invalid_type' && /received undefined$/.test(issue.message)) text = `required (${issue.expected})`
  else if (issue.code === 'invalid_type' && issue.expected === 'int') text = 'expected a whole number'
  else if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.map((k) => `'${k}'`).join(', ')
    text = `unknown field${issue.keys.length > 1 ? 's' : ''} ${keys}${at ? '' : ` (fields: ${fields.join(', ') || 'none'})`}`
  } else if (issue.code === 'invalid_union') {
    const firsts = issue.errors.map((branch) => branch[0]).filter((x): x is Issue => !!x)
    const types = firsts.every((b) => b.code === 'invalid_type' && b.path.length === 0)
      ? [...new Set(firsts.map((b) => (b as { expected: string }).expected))]
      : null
    text = types ? `expected ${types.join(' or ')}` : `does not match any allowed form (${firsts.map((b) => b.message.replace(/^Invalid input: /, '')).join('; ')})`
  } else text = msg
  return at ? `${at}: ${text}` : text
}

/** "Invalid input for create_object:\n- kind: …" */
export function formatIssues(tool: string, issues: Issue[], fields: string[]): string {
  return `Invalid input for ${tool}:\n- ${issues.map((i) => issueText(i, fields)).join('\n- ')}`
}

/** Keys of `input` objects (at any depth) that zod dropped while parsing — fields the schema does not have. */
export function strippedKeys(input: unknown, parsed: unknown, at = ''): string[] {
  if (Array.isArray(input) && Array.isArray(parsed)) return input.flatMap((v, i) => strippedKeys(v, parsed[i], `${at}[${i}]`))
  if (isObj(input) && isObj(parsed)) {
    const out: string[] = []
    for (const k of Object.keys(input)) {
      const p = at ? `${at}.${k}` : k
      if (!Object.hasOwn(parsed, k)) out.push(p)
      else out.push(...strippedKeys(input[k], parsed[k], p))
    }
    return out
  }
  return []
}

/** A validate() for one catalog tool: strict at the root, unknown nested fields reported too, readable messages. */
export function validatorFor(spec: ToolSpec): (input: unknown) => ToolValidation {
  const schema = z.strictObject(spec.input)
  const fields = Object.keys(spec.input)
  return (input) => {
    let v = input
    if (v === undefined || v === null || v === '') v = {}
    if (typeof v === 'string') {
      // some models send the arguments as a JSON string inside the JSON
      try { v = JSON.parse(v) } catch { return { ok: false, error: `The input of ${spec.name} must be a JSON object, not text` } }
    }
    if (!isObj(v)) return { ok: false, error: `The input of ${spec.name} must be a JSON object like {"name": "Bolt"}` }
    // a null for a field that cannot be null means "not given" (models trained on strict schemas send every field)
    const cleaned: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) {
      if (val === null && (!Object.hasOwn(spec.input, k) || !spec.input[k].safeParse(null).success)) continue
      cleaned[k] = val
    }
    const r = schema.safeParse(cleaned)
    if (!r.success) return { ok: false, error: formatIssues(spec.name, r.error.issues, fields) }
    const unknown = strippedKeys(cleaned, r.data)
    if (unknown.length) return { ok: false, error: `Invalid input for ${spec.name}:\n- unknown field${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')}` }
    return { ok: true, value: r.data as Record<string, unknown> }
  }
}

// ───────────────────────────── running ─────────────────────────────

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** File name without characters that file systems reject (the same rule as the Save and STL buttons, src/app/commands.ts). */
export function safeFileName(name: string): string {
  return (name.trim() || 'Untitled').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
}

/** The .3dica.json name for save_project: the model's fileName (folders dropped, extension normalized) or the project name. */
export function projectFileName(projectName: string, fileName?: unknown): string {
  let base = typeof fileName === 'string' ? fileName.trim().split(/[\\/]/).pop()!.trim() : ''
  base = base.replace(/(\.3dica)?\.json$/i, '').trim()
  return `${safeFileName(base || projectName)}.3dica.json`
}

/** The longest model-written name an approval card shows (the fixed warning comes first, so it is never pushed away). */
const CONFIRM_NAME_MAX = 80

const CONFIRMS: Record<string, { title: string; message: (p: Record<string, unknown>) => string; declined: string }> = {
  new_project: {
    title: 'New project',
    message: (p) => {
      const raw = typeof p.name === 'string' ? p.name.trim() : ''
      const name = raw.length > CONFIRM_NAME_MAX ? `${raw.slice(0, CONFIRM_NAME_MAX - 1)}…` : raw
      return `This can't be undone: the AI wants to replace the current project with an empty one${name ? ` (name: ${JSON.stringify(name)})` : ''}. Save first if you want to keep it.`
    },
    declined: 'The user declined the new project. Nothing changed.',
  },
  load_sample: {
    title: 'Load sample',
    message: () => "This can't be undone: the AI wants to replace the current project with the sample 'Bracket kit'. Save first if you want to keep it.",
    declined: 'The user declined loading the sample. Nothing changed.',
  },
}

const OWN_PREFIX = `${CHAT_LABEL_PREFIX}: `

/**
 * The chat's undo and redo walk only its own steps ("AI: …") and stop at the user's. An AI change right after an undo
 * clears the redo stack, so undoing the user's edits would let the next call make their work unrecoverable, with no
 * approval asked. The user undoes their own edits with Ctrl+Z.
 */
async function ownSteps(ctx: AppContext, stack: 'past' | 'future', p: Record<string, unknown>, h: Handler): Promise<Record<string, unknown>> {
  const verb = stack === 'past' ? 'undo' : 'redo'
  const want = Math.max(1, Math.min(50, typeof p.steps === 'number' ? Math.floor(p.steps) : 1))
  ctx.emit('flushCode', undefined) // a half-typed edit of the user becomes their own step first, and stops the walk
  const next = ctx.store.history.labels()[stack].slice().reverse() // the next step first
  let n = 0
  while (n < want && n < next.length && next[n].startsWith(OWN_PREFIX)) n++
  if (n === 0 && next.length) {
    throw new Error(`The next step to ${verb} is the user's own edit ('${next[0]}'). You can only ${verb} your own "${OWN_PREFIX}…" steps; if it should be ${verb === 'undo' ? 'undone' : 'redone'}, ask the user to press ${verb === 'undo' ? 'Ctrl+Z' : 'Ctrl+Y'}.`)
  }
  const out = (await h({ ...p, steps: Math.max(1, n) })) as Record<string, unknown>
  if (n < want && n < next.length) out.note = `Stopped after ${n} ${n === 1 ? 'step' : 'steps'}: the next one is the user's own edit ('${next[n]}')`
  return out
}

/** The chat's tools for this app (createHandlers with labelPrefix 'AI'). */
export function createChatTools(ctx: AppContext, opts: ChatToolOptions = {}): AgentTool[] {
  const handlerOpts = { labelPrefix: CHAT_LABEL_PREFIX, settleMs: opts.settleMs, onAction: opts.onAction }
  const handlers = createHandlers(ctx, handlerOpts)

  // export_stl: the handler returns the STL as base64 (for the MCP server). Here a client wrapper keeps the worker's
  // ArrayBuffers and hands the handler none, so a large STL is not base64-encoded and decoded again in the tab.
  let stlParts: ArrayBuffer[] | null = null
  const client = ctx.client
  const capturingClient = new Proxy(client, {
    get(target, key) {
      if (key === 'exportStl') {
        return async (items: Parameters<EvalClientApi['exportStl']>[0]) => {
          const r = await target.exportStl(items)
          stlParts = r.parts
          return { parts: [], tris: r.tris }
        }
      }
      const v = Reflect.get(target, key, target) as unknown
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const stlHandlers = createHandlers({ ...ctx, client: capturingClient }, handlerOpts)

  const json = (v: unknown): ToolOutput => ({ text: JSON.stringify(v) })

  /** chat-specific behaviour on top of a handler; the rest return the handler's JSON as is */
  const special: Record<string, (p: Record<string, unknown>, h: Handler) => Promise<ToolOutput>> = {
    async status(p, h) {
      const out = (await h(p)) as Record<string, unknown>
      delete out.url // the page address and tab visibility mean nothing to the chat model
      delete out.tabVisible
      return json(out)
    },

    undo: async (p, h) => json(await ownSteps(ctx, 'past', p, h)),
    redo: async (p, h) => json(await ownSteps(ctx, 'future', p, h)),

    async screenshot(p, h) {
      const size = AUDIENCES.chat.screenshot
      const r = (await h({ width: size.width, height: size.height, ...p })) as { image: string; text: string }
      return { text: r.text, images: [{ mediaType: 'image/png', base64: r.image }] }
    },

    async save_project(p, h) {
      const r = (await h({})) as { name: string; text: string }
      const fileName = projectFileName(r.name, p.fileName)
      const blob = new Blob([r.text], { type: 'application/json' })
      ctx.files.downloadBlob(blob, fileName)
      ctx.toast(`${CHAT_LABEL_PREFIX}: saved ${fileName}`)
      return json({ ok: true, downloaded: fileName, project: r.name, bytes: blob.size, note: 'The browser saves it to the user\'s downloads folder; they can open it again with Open.' })
    },

    async export_stl(p) {
      stlParts = null
      const r = (await stlHandlers.export_stl(p)) as { triangles: number; label: string; project: string; skipped: string[] }
      const parts = stlParts ?? []
      stlParts = null
      const fileName = stlFileName(safeFileName(r.project), r.label)
      const blob = new Blob(parts, { type: 'model/stl' })
      ctx.files.downloadBlob(blob, fileName)
      ctx.toast(`${CHAT_LABEL_PREFIX}: exported ${fileName} · ${r.triangles.toLocaleString('en-US')} triangles`)
      const out: Record<string, unknown> = { ok: true, downloaded: fileName, bytes: blob.size, triangles: r.triangles, exported: r.label }
      if (r.skipped?.length) out.skipped = r.skipped
      return json(out)
    },
  }

  return toolCatalog('chat').map((spec): AgentTool => {
    const handler = handlers[spec.name]
    if (!handler) throw new Error(`No handler for the tool '${spec.name}'`)
    const confirm = CONFIRMS[spec.name]
    return {
      name: spec.name,
      description: spec.description,
      inputSchema: inputSchemaOf(spec.input),
      validate: validatorFor(spec),
      readOnly: spec.annotations.readOnlyHint,
      needsConfirm: !!confirm,
      async run(input: Record<string, unknown>, rc: ToolRunContext): Promise<ToolOutput> {
        if (rc.signal.aborted) throw abortError()
        if (confirm) {
          const ok = await rc.confirm(confirm.title, confirm.message(input))
          if (rc.signal.aborted) throw abortError()
          if (!ok) return { text: confirm.declined }
        }
        try {
          const run = special[spec.name] ? special[spec.name](input, handler) : handler(input).then(json)
          return await abortable(run, rc.signal)
        } catch (e) {
          if (isAbortError(e) && rc.signal.aborted) throw e
          return { isError: true, text: `Error: ${errorText(e)}` }
        }
      },
    }
  })
}
