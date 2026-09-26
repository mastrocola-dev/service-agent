import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const McpServer = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).default([]),
  tools: z.array(z.string()).min(1),
})

const AgentFile = z.strictObject({
  model: z.string(),
  maxSteps: z.int().positive(),
  maxTokens: z.int().positive(),
  maxToolResultChars: z.int().positive().default(20_000),
  mcpServers: z.record(z.string().regex(/^[a-z0-9-]+$/), McpServer).default({}),
})

export type McpServer = z.infer<typeof McpServer>
export type AgentConfig = z.infer<typeof AgentFile> & { system: string }

export async function loadAgent(dir: string): Promise<AgentConfig> {
  const [raw, system] = await Promise.all([readFile(join(dir, 'agent.json'), 'utf8'), readFile(join(dir, 'system.md'), 'utf8')])
  return { ...AgentFile.parse(JSON.parse(raw)), system }
}
