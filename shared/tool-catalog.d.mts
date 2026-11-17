// Types of tool-catalog.mjs for the TypeScript side (src/agent/tools.ts). Keep in step with the .mjs.
import type { ZodType } from 'zod'

/** Who reads the tool texts: the MCP server's clients, or the in-app chat. */
export type Audience = 'mcp' | 'chat'

export interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  openWorldHint: boolean
}

export interface ToolSpec {
  name: string
  title: string
  description: string
  /** zod raw shape of the input object (what McpServer.registerTool takes as inputSchema) */
  input: Record<string, ZodType>
  annotations: ToolAnnotations
}

export const AUDIENCES: Record<Audience, { labelPrefix: string; screenshot: { width: number; height: number } }>

export const pathSchema: ZodType
export const transformSchema: ZodType
export const paramDefSchema: ZodType

/** Every tool for `audience`, in the MCP registration order (the chat has no help and no load_project). */
export function toolCatalog(audience: Audience): ToolSpec[]
