import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { connect } from '../src/mcp.ts'

const toolbox = await connect({
  fs: { command: 'node_modules/.bin/mcp-server-filesystem', args: ['.'], tools: ['list_directory'] },
})
after(toolbox.close)

test('exposes only allowlisted tools, namespaced by server', () => {
  assert.deepEqual(
    toolbox.definitions.map((tool) => tool.name),
    ['fs__list_directory'],
  )
})

test('calls an allowlisted tool', async () => {
  const result = await toolbox.call('fs__list_directory', { path: '.' })
  assert.match(JSON.stringify(result.content), /README\.md/)
})

test('rejects a tool outside the allowlist without reaching the server', async () => {
  const result = await toolbox.call('fs__write_file', { path: 'x', content: 'x' })
  assert.equal(result.is_error, true)
})

test('fails to connect when the allowlist names an unknown tool', async () => {
  await assert.rejects(connect({ fs: { command: 'node_modules/.bin/mcp-server-filesystem', args: ['.'], tools: ['nope'] } }), /Unknown tools on fs: nope/)
})
