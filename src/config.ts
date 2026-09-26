import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const AgentFile = z.strictObject({
  model: z.string(),
  maxSteps: z.int().positive(),
  maxTokens: z.int().positive(),
})

export type AgentConfig = z.infer<typeof AgentFile> & { system: string }

export async function loadAgent(dir: string): Promise<AgentConfig> {
  const [raw, system] = await Promise.all([readFile(join(dir, 'agent.json'), 'utf8'), readFile(join(dir, 'system.md'), 'utf8')])
  return { ...AgentFile.parse(JSON.parse(raw)), system }
}
