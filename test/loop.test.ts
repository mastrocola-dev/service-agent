import assert from 'node:assert/strict'
import { test } from 'node:test'
import type Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { AgentConfig } from '../src/config.ts'
import { output, run, type Toolbox } from '../src/loop.ts'
import type { TraceEvent } from '../src/trace.ts'

const config: AgentConfig = { model: 'test', maxSteps: 2, maxTokens: 100, maxToolResultChars: 20, runTimeoutMs: 1000, toolTimeoutMs: 500, mcpServers: {}, system: '' }
const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
const structured: AgentConfig = { ...config, outputSchema: schema }
const toolbox: Toolbox = { definitions: [], call: async (name) => ({ content: `ran ${name}`, isError: false }) }
const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null }

const message = (stop_reason: string, content: unknown[] = []) => ({ stop_reason, content, model: 'served', usage }) as unknown as Message
const text = (value: string) => message('end_turn', [{ type: 'text', text: value }])
const toolUse = message('tool_use', [{ type: 'tool_use', id: 't1', name: 'fs__list', input: { path: '.' } }])
const task = (): MessageParam[] => [{ role: 'user', content: 'task' }]

const pending = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const alive = setInterval(() => {}, 1_000)
    signal?.addEventListener('abort', () => {
      clearInterval(alive)
      reject(signal.reason)
    })
  })

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
    { type: 'tool.call', step: 0, name: 'fs__list', input: { path: '.' }, resultChars: 25, truncated: true, isError: false, timedOut: false },
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

test('returns a timed-out tool as an error the model can recover from', async () => {
  const hanging: Toolbox = { definitions: [], call: (_name, _input, signal) => pending(signal) }
  const context = runtime([toolUse, message('end_turn')], hanging)
  const messages = task()
  await run(context, { ...config, toolTimeoutMs: 10, maxToolResultChars: 100 }, messages)
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Tool timed out after 10ms', is_error: true }],
  })
  assert.equal(context.events[1]?.type === 'tool.call' && context.events[1].timedOut, true)
})

test('aborts the run when the run deadline passes during a model call', async () => {
  const context = runtime([])
  const client = { messages: { create: (_request: unknown, options: { signal: AbortSignal }) => pending(options.signal) } } as unknown as Anthropic
  await assert.rejects(run({ ...context, client }, { ...config, runTimeoutMs: 20 }, task()), /Run timed out after 20ms/)
})

test('aborts the run when the run deadline passes during a tool call', async () => {
  const hanging: Toolbox = { definitions: [], call: (_name, _input, signal) => pending(signal) }
  await assert.rejects(run(runtime([toolUse], hanging), { ...config, runTimeoutMs: 20, toolTimeoutMs: 500 }, task()), /Run timed out after 20ms/)
})

test('passes an abort signal to the toolbox', async () => {
  let received: AbortSignal | undefined
  const spy: Toolbox = {
    definitions: [],
    call: async (_name, _input, signal) => {
      received = signal
      return { content: 'ok', isError: false }
    },
  }
  await run(runtime([toolUse, message('end_turn')], spy), config, task())
  assert.ok(received instanceof AbortSignal)
})

test('stops when the run exceeds its token budget', async () => {
  await assert.rejects(run(runtime([toolUse, message('end_turn')]), { ...config, maxRunTokens: 20 }, task()), /Token budget exceeded: 30 of 20/)
})
