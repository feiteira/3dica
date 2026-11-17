// Types of briefing.mjs for the TypeScript side (src/agent/prompt.ts). Keep in step with the .mjs.

/** Same list and order as FLAT_NAMESPACES in src/eval/engine.ts. */
export const FLAT_NAMESPACES: string[]
/** Same as SHADOWED in src/eval/engine.ts. */
export const SHADOWED: string[]
/** { namespace: [names] } exactly as the engine flattens them. */
export function flatNamesByNamespace(): Record<string, string[]>
export function flatNames(): string[]
/** How a 3Dica project is built (units, definitions, groups, instances, paths, JSCAD conventions). */
export const MODEL_NOTES: string
/** "Recommended loop: make one change → … → fix and repeat." */
export const RECOMMENDED_LOOP: string
/** The MCP server instructions (sent at initialize). */
export function mcpInstructions(): string
/** The code API cheat sheet (Markdown). */
export function codeApiCheatSheet(): string
