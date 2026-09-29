import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const tempDir = () => mkdtempSync(join(tmpdir(), 'traces-'))

const cli = (args: string[], input = '', traces = tempDir()) =>
  spawnSync(process.execPath, ['src/cli.ts', ...args], {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE, TRACE_DIR: traces },
  })

test('exits 1 without a task', () => {
  const { status, stderr } = cli([])
  assert.equal(status, 1)
  assert.match(stderr, /No task provided/)
})

test('exits 1 for an unknown agent', () => {
  const { status, stderr } = cli(['--agent', 'missing', 'task'])
  assert.equal(status, 1)
  assert.match(stderr, /ENOENT/)
})

test('accepts the task from stdin', () => {
  const { status, stderr } = cli([], 'task')
  assert.equal(status, 1)
  assert.doesNotMatch(stderr, /No task provided/)
  assert.match(stderr, /authentication/)
})

test('traces a failed run and reports the trace path on stderr', () => {
  const traces = tempDir()
  const { stderr } = cli(['task'], '', traces)
  const [file] = readdirSync(traces)
  assert.ok(file)
  assert.match(stderr, new RegExp(`trace: ${join(traces, file)}`))
  const events = readFileSync(join(traces, file), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(
    events.map(({ type, status }) => [type, status]),
    [
      ['run.start', undefined],
      ['run.end', 'error'],
    ],
  )
})
