import assert from 'node:assert/strict'
import { test } from 'node:test'
import type Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { AgentConfig } from '../src/config.ts'
import { output, run, type Toolbox } from '../src/loop.ts'

const config: AgentConfig = { model: 'test', maxSteps: 2, maxTokens: 100, maxToolResultChars: 20, mcpServers: {}, system: '' }
const toolbox: Toolbox = { definitions: [], call: async (name) => ({ content: `ran ${name}`, isError: false }) }

const message = (stop_reason: string, content: unknown[] = []) => ({ stop_reason, content }) as unknown as Message
const toolUse = message('tool_use', [{ type: 'tool_use', id: 't1', name: 'fs__list', input: {} }])
const scripted = (...responses: Message[]) => ({ messages: { create: async () => responses.shift() } }) as unknown as Anthropic
const task = (): MessageParam[] => [{ role: 'user', content: 'task' }]
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const structured: AgentConfig = { ...config, outputSchema: schema }
const text = (value: string) => message('end_turn', [{ type: 'text', text: value }])

const recording = () => {
  const requests: Record<string, unknown>[] = []
  const client = {
    messages: {
      create: async (request: Record<string, unknown>) => {
        requests.push(request)
        return message('end_turn')
      },
    },
  } as unknown as Anthropic
  return { client, requests }
}

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
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ran fs__list', is_error: false }],
  })
})

test('throws on step limit', async () => {
  await assert.rejects(run(scripted(toolUse, toolUse), config, toolbox, task()), /Step limit reached: 2/)
})

test('truncates tool results beyond maxToolResultChars', async () => {
  const messages = task()
  const verbose: Toolbox = { definitions: [], call: async () => ({ content: 'x'.repeat(25), isError: false }) }
  await run(scripted(toolUse, message('end_turn')), config, verbose, messages)
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: `${'x'.repeat(20)}\n[truncated: 20 of 25 chars; narrow the request]`,
        is_error: false,
      },
    ],
  })
})

test('requests structured output when the instance has a schema', async () => {
  const { client, requests } = recording()
  await run(client, structured, toolbox, task())
  assert.deepEqual(requests[0]?.output_config, { format: { type: 'json_schema', schema } })
})

test('omits output_config without a schema', async () => {
  const { client, requests } = recording()
  await run(client, config, toolbox, task())
  assert.equal('output_config' in (requests[0] ?? {}), false)
})

test('output returns text without a schema', () => {
  assert.equal(output(text('hello'), config), 'hello')
})

test('output parses JSON with a schema', () => {
  assert.deepEqual(output(text('{"ok":true}'), structured), { ok: true })
})

test('output rejects runs that did not end on end_turn', () => {
  assert.throws(() => output(message('max_tokens'), config), /Run ended with stop reason: max_tokens/)
})
