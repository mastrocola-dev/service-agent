import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadAgent } from '../src/config.ts'

const base = { model: 'test', maxSteps: 1, maxTokens: 1 }
const server = { command: 'server', tools: ['tool'] }

const instance = async (agent: object, outputSchema?: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-'))
  await writeFile(join(dir, 'agent.json'), JSON.stringify(agent))
  await writeFile(join(dir, 'system.md'), 'prompt')
  if (outputSchema !== undefined) await writeFile(join(dir, 'output.schema.json'), JSON.stringify(outputSchema))
  return dir
}

test('applies defaults and reads the system prompt', async () => {
  assert.deepEqual(await loadAgent(await instance(base)), {
    ...base,
    maxToolResultChars: 20_000,
    runTimeoutMs: 120_000,
    toolTimeoutMs: 30_000,
    mcpServers: {},
    system: 'prompt',
  })
})

test('defaults server args to empty', async () => {
  const config = await loadAgent(await instance({ ...base, mcpServers: { fs: server } }))
  assert.deepEqual(config.mcpServers.fs?.args, [])
})

test('rejects unknown keys', async () => {
  await assert.rejects(loadAgent(await instance({ ...base, maxStep: 1 })), /maxStep/)
})

test('rejects server names outside [a-z0-9-]', async () => {
  await assert.rejects(loadAgent(await instance({ ...base, mcpServers: { my_fs: server } })), /my_fs|Invalid/)
})

test('rejects an empty tool allowlist', async () => {
  await assert.rejects(loadAgent(await instance({ ...base, mcpServers: { fs: { ...server, tools: [] } } })), /tools/)
})

test('reads the output schema when present', async () => {
  const schema = { type: 'object', properties: {}, additionalProperties: false }
  const config = await loadAgent(await instance(base, schema))
  assert.deepEqual(config.outputSchema, schema)
})

test('rejects an output schema that is not an object', async () => {
  await assert.rejects(loadAgent(await instance(base, ['not', 'an', 'object'])))
})
