import assert from 'node:assert/strict'
import { test } from 'node:test'
import type Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { AgentConfig } from '../src/config.ts'
import { run, type Toolbox } from '../src/loop.ts'

const config: AgentConfig = { model: 'test', maxSteps: 2, maxTokens: 100, mcpServers: {}, system: '' }
const toolbox: Toolbox = { definitions: [], call: async (name) => ({ content: `ran ${name}` }) }

const message = (stop_reason: string, content: unknown[] = []) => ({ stop_reason, content }) as unknown as Message
const toolUse = message('tool_use', [{ type: 'tool_use', id: 't1', name: 'fs__list', input: {} }])
const scripted = (...responses: Message[]) => ({ messages: { create: async () => responses.shift() } }) as unknown as Anthropic
const task = (): MessageParam[] => [{ role: 'user', content: 'task' }]

test('returns on end_turn', async () => {
  const messages = task()
  const response = await run(scripted(message('end_turn')), config, toolbox, messages)
  assert.equal(response.stop_reason, 'end_turn')
  assert.equal(messages.length, 2)
})

test('feeds tool results back to the model', async () => {
  const messages = task()
  await run(scripted(toolUse, message('end_turn')), config, toolbox, messages)
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ran fs__list' }],
  })
})

test('throws on step limit', async () => {
  await assert.rejects(run(scripted(toolUse, toolUse), config, toolbox, task()), /Step limit reached: 2/)
})
