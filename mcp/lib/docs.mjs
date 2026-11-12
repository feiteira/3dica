// Text the MCP server hands to models: the server instructions (sent at initialize) and the code-API cheat sheet
// (the `help` tool and the resource threedica://docs/code-api). The in-scope function names are read from the installed
// @jscad/modeling in the same namespace order as src/eval/engine.ts FLAT_NAMESPACES (a unit test keeps them equal).
import jscad from '@jscad/modeling'

/** Same list and order as FLAT_NAMESPACES in src/eval/engine.ts. */
export const FLAT_NAMESPACES = ['primitives', 'booleans', 'transforms', 'extrusions', 'hulls', 'expansions', 'colors', 'measurements', 'text', 'utils', 'curves']
/** Same as SHADOWED in src/eval/engine.ts. */
export const SHADOWED = ['self', 'globalThis', 'postMessage', 'importScripts', 'fetch', 'XMLHttpRequest', 'WebSocket']
const FIXED = ['params', 'part', 'jscad', 'Math']

/** { namespace: [names] } exactly as the engine flattens them (first one wins, fixed and shadowed names skipped). */
export function flatNamesByNamespace() {
  const taken = new Set([...FIXED, ...SHADOWED])
  const out = {}
  for (const ns of FLAT_NAMESPACES) {
    out[ns] = []
    for (const k of Object.keys(jscad[ns] ?? {})) {
      if (taken.has(k)) continue
      taken.add(k)
      out[ns].push(k)
    }
  }
  return out
}

export function flatNames() {
  return Object.values(flatNamesByNamespace()).flat()
}

export const INSTRUCTIONS = `3Dica is a browser code-CAD workbench. This server drives the 3Dica tab that is connected to it (the user's own browser tab, or a headless one) and lets you SEE it with the screenshot tool.

Model:
- Units are millimetres. Z is up. The grid is 200 mm across with 10 mm cells, on the XY plane at Z = 0.
- A definition is a reusable named thing. A Code definition is a JavaScript function BODY (not a module, no imports) that returns a JSCAD Geom3 or an array of them; params holds its parameters (defaults merged with the instance's overrides). The functions of the main @jscad/modeling namespaces (primitives, booleans, transforms, extrusions, hulls, expansions, colors, measurements, text, utils, curves) are in scope by their plain names (cuboid, cylinder, union, subtract, translate, rotate, extrudeLinear, …); the rest is reached through jscad (jscad.geometries, jscad.maths, jscad.modifiers). part('Name', { param: value }) returns another definition's geometry (string literal name).
- A Group definition holds child instances and has an op: none (assembly), union, subtract (first child minus the rest) or intersect.
- An instance places a definition inside a group with a transform { t: [x,y,z] mm, r: [x,y,z] degrees applied like OpenSCAD rotate([x,y,z]) (X, then Y, then Z), s: [x,y,z] factors }, optional label, color and parameter overrides. Copies are LINKED: editing a definition (or a child inside a group definition) changes every copy. make_unique or duplicate mode "unique" breaks the link.
- Objects are addressed by instance paths (instance ids from the scene root, e.g. ["i_fx1","i_b1"]); get_scene lists them. Definitions are addressed by name.
- JSCAD primitives are centered on the origin (cuboid, cylinder, sphere); the built-in templates instead sit on Z = 0 (center: [0, 0, height / 2]). JSCAD angles (rotate, rotateZ, twistAngle) are in RADIANS — use degToRad(); instance transforms use degrees.

Recommended loop: make one change → read the returned status and errors (every editing tool waits for evaluation and reports per-definition status, size in mm, warnings and errors with line numbers) → screenshot (view "multi" shows front/right/top/iso at once; pass target to frame one object, isolate: true to see a definition alone) → verify the shape and position against what you intended → fix and repeat. Every change is one step in the app's undo history labelled "MCP: …", so the user can undo it; undo/redo here walk the same shared history. Call help for the code API cheat sheet.`

export function codeApiCheatSheet() {
  const byNs = flatNamesByNamespace()
  const total = Object.values(byNs).reduce((n, l) => n + l.length, 0)
  const nsLines = Object.entries(byNs).map(([ns, names]) => `- ${ns}: ${names.join(', ')}`).join('\n')
  return `# 3Dica code API (JSCAD 2.13)

The code of a Code definition is the BODY of a function. It must \`return\` a Geom3 or an array of Geom3 (nested arrays are flattened). 2D shapes (circle, rectangle, polygon, vectorText…) must be extruded first (extrudeLinear, extrudeRotate).

## In scope
- \`params\` — frozen object: this definition's parameter defaults merged with the instance's overrides.
- \`part(name, overrides?)\` → Geom3[] — another definition's geometry in its own local coordinates, like calling an OpenSCAD module. \`name\` must be a string literal (the dependency is found by a static scan). Overrides are checked against that definition's parameters; groups take none. Renaming a definition rewrites part() calls.
- \`jscad\` — the whole @jscad/modeling library (jscad.maths, jscad.geometries, jscad.modifiers, …).
- \`Math\` — Math.random is seeded per result, so a re-run gives the same shape.
- ${total} functions by plain name:
${nsLines}
- Shadowed as undefined (hygiene, NOT a sandbox): ${SHADOWED.join(', ')}.

## Conventions
- Units mm, Z up. cuboid/cylinder/sphere are centered on [0, 0, 0] unless you pass center; to sit on the XY plane use center: [0, 0, h / 2].
- JSCAD angles are radians: rotate([0, 0, degToRad(30)], shape), rotateZ(Math.PI / 4, shape).
- Instance transforms (create_object / add_instance / update_instance) are { t: [x, y, z] mm, r: [x, y, z] degrees, s: [x, y, z] } with M = T · Rz · Ry · Rx · S, the same as OpenSCAD translate(t) rotate(r) scale(s).
- subtract(a, b, c) removes b and c from a; union / intersect take any number of shapes (or arrays).
- colorize([r, g, b], shape) bakes a color (0–1); otherwise the definition / instance color is used.
- Parameters (ParamDef): { name: identifier, type: "number" | "boolean" | "choice", default, min?, max?, step? (UI hints only), options?: string[] (choice) }.

## Limits
- 2,000,000 triangles per result and 2,000,000 polygons created per evaluation ("Too much geometry" error on the calling line).
- Evaluation timeout 20 s by default (?evalTimeout=<ms> in the app URL). A runaway loop is stopped.
- part() nesting depth 64; scene nesting 32 levels and 5,000 occurrences.

## Errors
Syntax and runtime errors report the line in the code body (line 1 = the first line you wrote). A definition whose part() target fails reports 'depends on "X" (failed)'. The last good mesh stays on screen, tinted red, while the code is broken.

## Example
\`\`\`js
// params: width 30, height 25, thickness 3 (numbers)
const { width, height, thickness } = params
const base = cuboid({ size: [width, 20, thickness], center: [0, 0, thickness / 2] })
const wall = cuboid({ size: [width, thickness, height], center: [0, 10 - thickness / 2, height / 2] })
const hole = cylinder({ radius: 2, height: thickness + 2, center: [0, 0, thickness / 2] })
return subtract(union(base, wall), hole)
\`\`\`

\`\`\`js
// a row of another definition: part() returns that definition's geometry
const out = []
for (let i = 0; i < params.count; i++) out.push(translateX(i * 35, part('Bracket', { width: 30 })))
return out
\`\`\`
`
}
