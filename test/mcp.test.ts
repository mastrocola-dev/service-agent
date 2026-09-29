import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { connect } from '../src/mcp.ts'

const fixture = (tools: string[]) => ({ command: 'node', args: ['test/fixtures/server.ts'], tools })

const toolbox = await connect({ fixture: fixture(['echo', 'slow']) })
const signal = new AbortController().signal
after(toolbox.close)

test('exposes only allowlisted tools, namespaced by server', () => {
  assert.deepEqual(
    toolbox.definitions.map((tool) => tool.name),
    ['fixture__echo', 'fixture__slow'],
  )
})

test('calls an allowlisted tool', async () => {
  assert.deepEqual(await toolbox.call('fixture__echo', { text: 'hi' }, signal), { content: 'hi', isError: false })
})

test('rejects a tool outside the allowlist without reaching the server', async () => {
  assert.deepEqual(await toolbox.call('fixture__write', {}, signal), { content: 'Tool not allowed: fixture__write', isError: true })
})

test('forwards server-side tool errors', async () => {
  const result = await toolbox.call('fixture__echo', {}, signal)
  assert.equal(result.isError, true)
})

test('cancels a call when its signal aborts', async () => {
  await assert.rejects(toolbox.call('fixture__slow', {}, AbortSignal.timeout(50)))
})

test('fails to connect when the allowlist names an unknown tool', async () => {
  await assert.rejects(connect({ fixture: fixture(['nope']) }), /Unknown tools on fixture: nope/)
})
