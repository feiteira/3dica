// Text the MCP server hands to models: the server instructions (sent at initialize) and the code-API cheat sheet
// (the `help` tool and the resource threedica://docs/code-api). The texts live in shared/briefing.mjs, which the
// in-app chat's system prompt (src/agent/prompt.ts) reuses.
import { mcpInstructions } from '../../shared/briefing.mjs'

export { FLAT_NAMESPACES, SHADOWED, codeApiCheatSheet, flatNames, flatNamesByNamespace } from '../../shared/briefing.mjs'

export const INSTRUCTIONS = mcpInstructions()
