import Anthropic from '@anthropic-ai/sdk'
import { app, type InvocationContext } from '@azure/functions'
import { connect } from './mcp.ts'
import { createWorker } from './worker.ts'

const client = new Anthropic()

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

async function bearer(resource: string) {
  const query = new URLSearchParams({ 'api-version': '2019-08-01', resource, client_id: env('AZURE_CLIENT_ID') })
  const response = await fetch(`${env('IDENTITY_ENDPOINT')}?${query}`, { headers: { 'x-identity-header': env('IDENTITY_HEADER') } })
  if (!response.ok) throw new Error(`Managed identity token for ${resource} failed: ${response.status}`)
  const { access_token } = (await response.json()) as { access_token: string }
  return { authorization: `Bearer ${access_token}` }
}

export async function worker(message: unknown, context: InvocationContext) {
  const [serviceBus, docs] = await Promise.all([bearer('https://servicebus.azure.net'), bearer(env('MCP_DOCS_AUDIENCE'))])
  const handle = createWorker({
    client,
    connect: (servers) => connect(servers, { docs: { url: env('MCP_DOCS_URL'), headers: docs } }),
    log: (line) => context.log(line),
    async publish(event) {
      const response = await fetch(`https://${env('ServiceBus__fullyQualifiedNamespace')}/events/messages`, { method: 'POST', headers: { ...serviceBus, 'content-type': 'application/json' }, body: JSON.stringify(event) })
      if (!response.ok) throw new Error(`Publishing to events failed: ${response.status}`)
    },
  })
  await handle(message, Number(context.triggerMetadata?.deliveryCount ?? 1))
}

app.serviceBusQueue('worker', { queueName: 'jobs', connection: 'ServiceBus', handler: worker })
