import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cost, fileTracer } from '../src/trace.ts'

const usage = { input: 1000, output: 100, cacheWrite: 0, cacheRead: 0 }
const records = async (path: string) =>
  (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))

test('prices usage from the pricing table', () => {
  assert.equal(cost('claude-haiku-4-5', usage), 0.0015)
  assert.equal(cost('claude-haiku-4-5', { input: 0, output: 0, cacheWrite: 1_000_000, cacheRead: 1_000_000 }), 1.35)
})

test('leaves cost empty for models outside the table', () => {
  assert.equal(cost('unknown-model', usage), null)
})

test('writes one JSON line per event with run totals', async () => {
  const tracer = fileTracer(await mkdtemp(join(tmpdir(), 'traces-')), 'docs', 'claude-haiku-4-5')
  tracer.emit({ type: 'model.call', step: 0, model: 'served', latencyMs: 1, stopReason: 'tool_use', usage })
  tracer.emit({ type: 'tool.call', step: 0, name: 'docs__read', input: {}, latencyMs: 1, resultChars: 3, truncated: false, isError: false, timedOut: false })
  tracer.emit({ type: 'model.call', step: 1, model: 'served', latencyMs: 1, stopReason: 'end_turn', usage })
  tracer.end()

  const lines = await records(tracer.path)
  assert.deepEqual(
    lines.map(({ type }) => type),
    ['run.start', 'model.call', 'tool.call', 'model.call', 'run.end'],
  )
  assert.equal(new Set(lines.map(({ runId }) => runId)).size, 1)
  assert.equal(lines[1].costUsd, 0.0015)
  assert.deepEqual(lines[4].usage, { input: 2000, output: 200, cacheWrite: 0, cacheRead: 0 })
  assert.equal(lines[4].costUsd, 0.003)
  assert.equal(lines[4].status, 'ok')
})

test('records the error when a run fails', async () => {
  const tracer = fileTracer(await mkdtemp(join(tmpdir(), 'traces-')), 'docs', 'claude-haiku-4-5')
  tracer.end(new Error('prompt is too long'))
  const end = (await records(tracer.path)).at(-1)
  assert.equal(end.status, 'error')
  assert.match(end.error, /prompt is too long/)
})
