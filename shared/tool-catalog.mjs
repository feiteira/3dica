// The 3Dica tools: name, title, description, zod input shape and annotations — one list for both front ends:
//   - the MCP server (mcp/lib/tools.mjs, plain Node ESM) registers them and forwards each call to a 3Dica tab;
//   - the in-app chat (src/agent/tools.ts, bundled by Vite) turns them into JSON Schema for the model.
// Both end up in the handlers of src/mcp/handlers.ts. Plain ESM that only imports zod, so Node runs it as is and the
// browser bundle can use it; tool-catalog.d.mts gives the TypeScript side its types.
//
// The texts differ per audience only where the two really differ: how the history labels start ("MCP: " / "AI: "),
// the status tool (bridge info), file tools (the server writes files on disk; the chat downloads them in the browser),
// confirmation of actions that cannot be undone, and the screenshot default size.
import { z } from 'zod'

/** @typedef {'mcp' | 'chat'} Audience */

/** Per audience: the history label prefix and the default screenshot size. */
export const AUDIENCES = {
  mcp: { labelPrefix: 'MCP', screenshot: { width: 800, height: 600 } },
  chat: { labelPrefix: 'AI', screenshot: { width: 768, height: 576 } },
}

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

const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false }

/**
 * Every tool for `audience`, in the MCP registration order (the chat leaves out help — the cheat sheet is in its
 * system prompt — and load_project, since the user opens files with Open).
 * @param {Audience} audience
 */
export function toolCatalog(audience) {
  const mcp = audience === 'mcp'
  const { labelPrefix, screenshot } = AUDIENCES[audience] ?? AUDIENCES.mcp
  /** @type {{ name: string, title: string, description: string, input: Record<string, z.ZodType>, annotations: typeof RO, only?: Audience }[]} */
  const tools = [
    // ── status & reading ──
    {
      name: 'status',
      title: 'Connection and app status',
      description: mcp
        ? 'Is a 3Dica tab connected? Returns the bridge state, and from the tab: project name, number of definitions and occurrences, selection, view mode, evaluator state, error count, the last undo/redo labels and the camera. Call it first; when no tab is connected it explains how to connect one.'
        : 'The app\'s state: project name, number of definitions and occurrences, selection, context group, view mode, ghosting, whether code is paused, evaluator state, error count, the last undo/redo labels and the camera.',
      input: {},
      annotations: RO,
    },
    {
      name: 'get_scene',
      title: 'Scene tree',
      description: 'The occurrence tree of the scene: for every placed object its path (instance ids — use it in other tools), label, definition, kind (code/group) and op, operand role inside a boolean (base/cut/other), local transform {t (mm), r (degrees), s}, color and parameter overrides, hidden flag, evaluation status (idle/pending/ok/error) and world bounding box {min, max, size} in mm. Linked copies appear once per copy (same instance ids under different parents).',
      input: {
        path: pathSchema.optional().describe('only this subtree'),
        depth: z.number().int().min(1).optional().describe('max depth to list'),
        maxNodes: z.number().int().min(1).max(5000).optional().describe('cap on listed objects (default 500)'),
        bbox: z.boolean().optional().describe('include world bounding boxes (default true)'),
      },
      annotations: RO,
    },
    {
      name: 'list_definitions',
      title: 'List definitions (the Library)',
      description: 'Every definition: name, kind (code/group), op (groups), params (ParamDef list for code), color, copies (occurrences in the scene), instances (placement records), usedByCode / uses (part() references), status and error {kind, message, line, col}.',
      input: {},
      annotations: RO,
    },
    {
      name: 'get_definition',
      title: 'Read one definition',
      description: 'One definition in full: for code definitions the code and params; for groups the op and the children (instance id, definition, label, transform, overrides, color, hidden); plus color, usage, status and error.',
      input: { name: z.string().describe('definition name, e.g. "Bolt"') },
      annotations: RO,
    },
    {
      name: 'get_errors',
      title: 'Evaluation errors',
      description: 'Every definition currently in error: {definition, kind (syntax/runtime/result/cycle/dependency/timeout/crash), message, line, col, in (the inner definition that failed), trace}. Waits for evaluation to finish first.',
      input: {},
      annotations: RO,
    },
    {
      name: 'help',
      title: 'Code API cheat sheet',
      description: 'The 3Dica code API: the function-body contract, params, part(), every JSCAD function in scope by plain name, units and angle conventions, limits and an example. Also available as the resource threedica://docs/code-api.',
      input: {},
      annotations: RO,
      only: 'mcp',
    },

    // ── creating and editing (each is one undo step "<prefix>: …"; the result reports evaluation status and errors) ──
    {
      name: 'create_object',
      title: 'Create a new object',
      description: 'Create a NEW definition and place one instance of it. kind cube/sphere/cylinder/torus start from the toolbar templates (parameters width/depth/height; radius/segments; radius/height/segments; innerRadius/outerRadius), sitting on Z = 0; kind "code" starts from the blank code template unless you pass code; kind "group" makes an empty group (op none/union/subtract/intersect) to fill with add_instance (parent: its name). Without a transform the object is placed to the right of the existing ones, like the toolbar does. Waits for evaluation and returns the new path plus status, size in mm, warnings and errors.',
      input: {
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
    },
    {
      name: 'update_definition',
      title: 'Edit a definition',
      description: 'Change a definition — every copy of it updates (linked). code: new function body; params: replace the ParamDef list; defaults: change default values of existing parameters; op: group operation; color (#rrggbb, null clears); rename: new name (part() calls are rewritten). Waits for evaluation and returns status, size, warnings and errors with line numbers (line 1 = first line of the body).',
      input: {
        name: z.string().describe('current definition name'),
        code: z.string().optional(),
        params: z.array(paramDefSchema).optional(),
        defaults: z.record(z.string(), paramValue).optional(),
        op: opSchema.optional(),
        color: color.nullable().optional(),
        rename: z.string().optional(),
      },
      annotations: EDIT,
    },
    {
      name: 'add_instance',
      title: 'Place a copy of a definition',
      description: 'Place another instance (a LINKED copy) of an existing definition inside a group. parent: instance path of a group in the scene, or a group definition name; default the scene root. transform defaults to identity (at the parent\'s origin). params are this instance\'s parameter overrides. Returns the new path and the evaluation report.',
      input: {
        definition: z.string(),
        parent: z.union([z.array(z.string()), z.string()]).optional(),
        transform: transformSchema.optional(),
        params: z.record(z.string(), paramValue).optional().describe('parameter overrides, e.g. {"length": 20}'),
        label: z.string().optional().describe('instance label shown in the tree instead of the definition name'),
        color: color.optional(),
        index: z.number().int().optional().describe('position among the parent\'s children (default: last). In a subtract group child 0 is the base.'),
      },
      annotations: EDIT,
    },
    {
      name: 'update_instance',
      title: 'Edit one placed object',
      description: 'Change one instance: transform (merged: pass only t, r or s to change just that), params (overrides; a null value removes that override), label (null clears), color (null clears), hidden. Note: an instance inside a group definition exists in every copy of that group, so the change shows in all of them (the result says so).',
      input: {
        path: pathSchema,
        transform: transformSchema.optional(),
        params: z.record(z.string(), paramValue.nullable()).optional(),
        label: z.string().nullable().optional(),
        color: color.nullable().optional(),
        hidden: z.boolean().optional(),
      },
      annotations: EDIT,
    },
    {
      name: 'move_instance',
      title: 'Move an object to another group',
      description: 'Re-parent an instance into another group (like dragging it in the tree). Its world position is kept (the local transform is recomputed). toParent: instance path of the target group ([] = scene root). index: position among the target\'s children (default last; in a subtract group index 0 is the base, later children cut).',
      input: {
        path: pathSchema,
        toParent: z.union([z.array(z.string()), z.string()]).describe('instance path of a group, or [] for the scene root'),
        index: z.number().int().optional(),
      },
      annotations: EDIT,
    },
    {
      name: 'duplicate',
      title: 'Duplicate an object',
      description: 'Copy an instance next to the original (offset along the parent\'s X by its width + 5 mm unless offset is given). mode "linked" (default) places the SAME definition again (Ctrl+D); "unique" first clones the definition (Ctrl+Shift+D), so the copy can change independently.',
      input: {
        path: pathSchema,
        mode: z.enum(['linked', 'unique']).optional(),
        offset: z.number().optional().describe('X offset in mm'),
      },
      annotations: EDIT,
    },
    {
      name: 'make_unique',
      title: 'Make unique',
      description: 'Point this instance at a clone of its definition (one level deep), so it can be edited without changing the other copies. Refused when it is the only instance record; to diverge a child of a linked group, make the group unique first. Returns the new definition name.',
      input: { path: pathSchema },
      annotations: EDIT,
    },
    {
      name: 'wrap',
      title: 'Wrap in a group or boolean',
      description: 'Wrap an instance in a new group with op none (plain group), union, subtract or intersect; the instance becomes its first child (for subtract: the base). Add cutters with add_instance / create_object (parent: the new group) or move_instance. Returns the new group path and name.',
      input: {
        path: pathSchema,
        op: opSchema.optional().describe('default none'),
        name: z.string().optional().describe('name for the new group definition (default Group / Union / Subtract / Intersect)'),
      },
      annotations: EDIT,
    },
    {
      name: 'ungroup',
      title: 'Ungroup',
      description: 'Replace a group instance by copies of its children (world positions kept). The group definition stays in the Library.',
      input: { path: pathSchema },
      annotations: EDIT,
    },
    {
      name: 'delete',
      title: 'Delete',
      description: 'Delete one placed object ({path}) — its definition stays — or a whole definition ({definition}). A definition with instances needs cascade: true (all its instances go too); one that other code calls with part() is refused. Undoable with undo.',
      input: {
        path: pathSchema.optional(),
        definition: z.string().optional(),
        cascade: z.boolean().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    {
      name: 'undo',
      title: 'Undo',
      description: mcp
        ? `Undo the last steps of the app's shared undo history — the user's own edits too, so check the labels it returns (yours start with "${labelPrefix}: ").`
        : `Undo your own last steps (labelled "${labelPrefix}: …") in the app's undo history. It stops at the user's own edits: only the user undoes those, with Ctrl+Z. Returns the labels it undid.`,
      input: { steps: z.number().int().min(1).max(50).optional() },
      annotations: EDIT,
    },
    {
      name: 'redo',
      title: 'Redo',
      description: mcp
        ? 'Redo steps undone with undo (or Ctrl+Z in the app).'
        : `Redo your own steps ("${labelPrefix}: …") that were undone with undo or Ctrl+Z. It stops at a step of the user's.`,
      input: { steps: z.number().int().min(1).max(50).optional() },
      annotations: EDIT,
    },

    // ── selection and the user's view (UI only; not in the undo history) ──
    {
      name: 'select',
      title: 'Select in the app',
      description: 'Change the user\'s selection: {path} selects a placed object (like a tree click), {definition} selects a Library definition (which shows it isolated, like a Library click), {} clears it. Screenshots do not need a selection — use their target option.',
      input: { path: pathSchema.optional(), definition: z.string().optional() },
      annotations: EDIT,
    },
    {
      name: 'set_view',
      title: 'Change the user\'s view',
      description: 'Change what the user sees: mode context/isolate (isolate shows the selection alone), ghost (fade unselected objects), preset camera front/right/top/iso, all (frame everything) or selection (frame it). Screenshots never depend on this — they use their own camera.',
      input: {
        mode: z.enum(['context', 'isolate']).optional(),
        ghost: z.boolean().optional(),
        preset: z.enum(['front', 'right', 'top', 'iso', 'all', 'selection']).optional(),
      },
      annotations: EDIT,
    },

    // ── projects and files ──
    {
      name: 'new_project',
      title: 'New empty project',
      description: mcp
        ? 'Replace the current project with an empty one, without the app\'s confirmation dialog. This is NOT undoable (the undo history is cleared) — save_project first if the user may want the current one back.'
        : 'Replace the current project with an empty one. The user is asked to approve it first. This is NOT undoable (the undo history is cleared) — save_project first if the user may want the current one back.',
      input: { name: z.string().optional() },
      annotations: DESTRUCTIVE,
    },
    {
      name: 'load_sample',
      title: 'Load the sample',
      description: mcp
        ? 'Replace the current project with the sample "Bracket kit" (two linked fixtures with plates, washers and bolts, and a "Bolt sizes" row made with part()). Not undoable.'
        : 'Replace the current project with the sample "Bracket kit" (two linked fixtures with plates, washers and bolts, and a "Bolt sizes" row made with part()). The user is asked to approve it first. Not undoable.',
      input: {},
      annotations: DESTRUCTIVE,
    },
    mcp
      ? {
          name: 'save_project',
          title: 'Save the project to a file',
          description: 'Write the current project as a .3dica.json file at path (absolute, ~/…, or relative to the MCP server\'s working directory). Overwrites an existing file. The folder must exist.',
          input: { path: z.string().describe('e.g. ./my-part.3dica.json') },
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        }
      : {
          name: 'save_project',
          title: 'Download the project file',
          description: 'Download the current project as a .3dica.json file in the user\'s browser, like the Save button (the browser puts it in the downloads folder). The user can open it again with Open. Returns the file name and size.',
          input: { fileName: z.string().optional().describe('file name without folders (default: the project name; .3dica.json is added)') },
          annotations: EDIT,
        },
    {
      name: 'load_project',
      title: 'Open a project file',
      description: 'Read a .3dica.json file from disk (path absolute, ~/… or relative to the server\'s working directory) and open it in the app, replacing the current project (not undoable). Unlike the app\'s Open, this RUNS the file\'s code without asking "This file contains code that runs on your computer. Run it?" — the request comes from the user\'s own assistant, so only load files you or the user trust.',
      input: { path: z.string() },
      annotations: DESTRUCTIVE,
      only: 'mcp',
    },
    mcp
      ? {
          name: 'export_stl',
          title: 'Export STL',
          description: 'Write a binary STL file at path (absolute, ~/… or relative to the server\'s working directory). target: omitted = the whole visible scene (not just the user\'s selection); an instance path = that object in world position; a definition name = that definition alone at the origin with its defaults. Solids are written as they are (not unioned). Returns the triangle count.',
          input: {
            path: z.string().describe('e.g. ./plate.stl'),
            target: targetSchema.optional(),
          },
          annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        }
      : {
          name: 'export_stl',
          title: 'Download an STL file',
          description: 'Download a binary STL file in the user\'s browser, named like the STL button names it (<project>-<what>.stl). target: omitted = the whole visible scene (not just the user\'s selection); an instance path = that object in world position; a definition name = that definition alone at the origin with its defaults. Solids are written as they are (not unioned). Returns the file name and the triangle count.',
          input: { target: targetSchema.optional().describe('instance path (["i_fx1","i_plate"] or "i_fx1/i_plate") or definition name; omitted = the whole visible scene') },
          annotations: EDIT,
        },

    // ── seeing it ──
    {
      name: 'screenshot',
      title: 'Screenshot the 3D view',
      description: 'Render the model and return a PNG image plus a short text (what is shown, framed box size in mm, triangles, scale, errors). It never moves the user\'s camera or changes their selection. view: "multi" (default; a 2×2 composite of front | right / top | iso, orthographic, with labels, an axis triad and a scale bar), front (looking +Y), right (looking −X), top (looking −Z, +Y up), iso, or current (the user\'s perspective camera). target: an instance path or definition name to frame; with isolate: true it is drawn alone at the origin (a definition with its defaults, a path with that copy\'s overrides). style: "clean" (default: plain materials, no selection highlight, ghosting, boolean operands or gizmo) or "as-seen" (exactly the user\'s materials and selection; view current also shows the gizmo). Size up to 2048 × 2048.',
      input: {
        view: z.enum(['current', 'front', 'right', 'top', 'iso', 'multi']).optional(),
        target: targetSchema.optional().describe('instance path (["i_fx1","i_plate"] or "i_fx1/i_plate") or definition name'),
        isolate: z.boolean().optional(),
        width: z.number().int().min(16).max(2048).optional().describe(`default ${screenshot.width}`),
        height: z.number().int().min(16).max(2048).optional().describe(`default ${screenshot.height}`),
        style: z.enum(['clean', 'as-seen']).optional(),
        grid: z.boolean().optional().describe('draw the 10 mm grid and XY axes (default true)'),
      },
      annotations: RO,
    },
  ]
  return tools.filter((t) => !t.only || t.only === audience).map(({ only: _only, ...t }) => t)
}
