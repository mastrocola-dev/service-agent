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
  maxRunTokens: z.int().positive().optional(),
  runTimeoutMs: z.int().positive().default(120_000),
  toolTimeoutMs: z.int().positive().default(30_000),
  mcpServers: z.record(z.string().regex(/^[a-z0-9-]+$/), McpServer).default({}),
})

const OutputSchema = z.record(z.string(), z.unknown())

export type McpServer = z.infer<typeof McpServer>
export type AgentConfig = z.infer<typeof AgentFile> & { system: string; outputSchema?: z.infer<typeof OutputSchema> }

const optional = (path: string) => readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)))

export async function loadAgent(dir: string): Promise<AgentConfig> {
  const [raw, system, schema] = await Promise.all([readFile(join(dir, 'agent.json'), 'utf8'), readFile(join(dir, 'system.md'), 'utf8'), optional(join(dir, 'output.schema.json'))])
  return {
    ...AgentFile.parse(JSON.parse(raw)),
    system,
    ...(schema && { outputSchema: OutputSchema.parse(JSON.parse(schema)) }),
  }
}
