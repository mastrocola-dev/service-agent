import assert from 'node:assert/strict'
import { test } from 'node:test'
import type Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { AgentConfig } from '../src/config.ts'
import { output, run, type Toolbox } from '../src/loop.ts'
import type { TraceEvent } from '../src/trace.ts'

const config: AgentConfig = { model: 'test', maxSteps: 2, maxTokens: 100, maxToolResultChars: 20, mcpServers: {}, system: '' }
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const structured: AgentConfig = { ...config, outputSchema: schema }
const toolbox: Toolbox = { definitions: [], call: async (name) => ({ content: `ran ${name}`, isError: false }) }
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null }

const message = (stop_reason: string, content: unknown[] = []) => ({ stop_reason, content, model: 'served', usage }) as unknown as Message
const text = (value: string) => message('end_turn', [{ type: 'text', text: value }])
const toolUse = message('tool_use', [{ type: 'tool_use', id: 't1', name: 'fs__list', input: { path: '.' } }])
const task = (): MessageParam[] => [{ role: 'user', content: 'task' }]

const runtime = (responses: Message[], tools = toolbox) => {
  const requests: Record<string, unknown>[] = []
  const events: TraceEvent[] = []
  const client = {
    messages: {
      create: async (request: Record<string, unknown>) => {
        requests.push(request)
        return responses.shift()
      },
    },
  } as unknown as Anthropic
  return { client, toolbox: tools, tracer: { emit: (event: TraceEvent) => events.push(event) }, requests, events }
}

test('returns on end_turn', async () => {
  const messages = task()
  const response = await run(runtime([message('end_turn')]), config, messages)
  assert.equal(response.stop_reason, 'end_turn')
  assert.equal(messages.length, 2)
})

test('feeds tool results back to the model', async () => {
  const messages = task()
  await run(runtime([toolUse, message('end_turn')]), config, messages)
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ran fs__list', is_error: false }],
  })
})

test('throws on step limit', async () => {
  await assert.rejects(run(runtime([toolUse, toolUse]), config, task()), /Step limit reached: 2/)
})

test('truncates tool results beyond maxToolResultChars', async () => {
  const messages = task()
  const verbose: Toolbox = { definitions: [], call: async () => ({ content: 'x'.repeat(25), isError: false }) }
  await run(runtime([toolUse, message('end_turn')], verbose), config, messages)
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: `${'x'.repeat(20)}\n[truncated: 20 of 25 chars; narrow the request]`, is_error: false }],
  })
})

test('traces every model and tool call', async () => {
  const verbose: Toolbox = { definitions: [], call: async () => ({ content: 'x'.repeat(25), isError: false }) }
  const context = runtime([toolUse, message('end_turn')], verbose)
  await run(context, config, task())
  const events = context.events.map(({ latencyMs, ...event }) => event)
  assert.deepEqual(events, [
    { type: 'model.call', step: 0, model: 'served', stopReason: 'tool_use', usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 } },
    { type: 'tool.call', step: 0, name: 'fs__list', input: { path: '.' }, resultChars: 25, truncated: true, isError: false },
    { type: 'model.call', step: 1, model: 'served', stopReason: 'end_turn', usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 } },
  ])
})

test('requests structured output when the instance has a schema', async () => {
  const context = runtime([message('end_turn')])
  await run(context, structured, task())
  assert.deepEqual(context.requests[0]?.output_config, { format: { type: 'json_schema', schema } })
})

test('omits output_config without a schema', async () => {
  const context = runtime([message('end_turn')])
  await run(context, config, task())
  assert.equal('output_config' in (context.requests[0] ?? {}), false)
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
