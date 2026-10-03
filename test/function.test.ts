import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import type { InvocationContext } from '@azure/functions'

Object.assign(process.env, {
  ANTHROPIC_API_KEY: 'test',
  AZURE_CLIENT_ID: 'client',
  IDENTITY_ENDPOINT: 'http://identity.test/token',
  IDENTITY_HEADER: 'secret',
  MCP_DOCS_AUDIENCE: 'api://mcp-docs',
  MCP_DOCS_URL: 'https://mcp-docs.test/mcp',
  ServiceBus__fullyQualifiedNamespace: 'bus.test',
})
const { worker } = await import('../src/function.ts')

const context = (deliveryCount: number) => ({ log: () => {}, triggerMetadata: { deliveryCount } }) as unknown as InvocationContext
const job = { v: 1, type: 'run', jobId: 'job-1', instance: 'ask', input: { question: 'Why multi-repo?' } }

const network = (identityStatus = 200, busStatus = 201) => {
  const requests: { url: string; headers: Headers; body: unknown }[] = []
  mock.method(globalThis, 'fetch', async (input: string, init: RequestInit = {}) => {
    requests.push({ url: input, headers: new Headers(init.headers), body: init.body && JSON.parse(String(init.body)) })
    return input.startsWith('http://identity.test') ? Response.json({ access_token: new URL(input).searchParams.get('resource') }, { status: identityStatus }) : new Response(null, { status: busStatus })
  })
  return requests
}

afterEach(() => mock.restoreAll())

test('asks the managed identity for one token per destination', async () => {
  const requests = network()
  await worker({ v: 1, type: 'warm' }, context(1))
  assert.deepEqual(requests.map(({ url }) => url).sort(), ['http://identity.test/token?api-version=2019-08-01&resource=api%3A%2F%2Fmcp-docs&client_id=client', 'http://identity.test/token?api-version=2019-08-01&resource=https%3A%2F%2Fservicebus.azure.net&client_id=client'])
  assert.ok(requests.every(({ headers }) => headers.get('x-identity-header') === 'secret'))
})

test('publishes events to the events queue with the Service Bus token', async () => {
  const requests = network()
  await worker(job, context(2))
  const published = requests.find(({ url }) => url === 'https://bus.test/events/messages')
  assert.equal(published?.headers.get('authorization'), 'Bearer https://servicebus.azure.net')
  assert.deepEqual(published?.body, { v: 1, jobId: 'job-1', seq: 0, type: 'failed', reason: 'redelivered', costUsd: 0 })
})

test('fails the invocation when a token is refused', async () => {
  network(403)
  await assert.rejects(worker(job, context(2)), /Managed identity token for .* failed: 403/)
})

test('fails the invocation when the queue refuses an event', async () => {
  network(200, 401)
  await assert.rejects(worker(job, context(2)), /Publishing to events failed: 401/)
})
