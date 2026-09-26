import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

const cli = (args: string[], input = '') =>
  spawnSync(process.execPath, ['src/cli.ts', ...args], {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE },
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
