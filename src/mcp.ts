import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { McpServer } from './config.ts'
import type { Toolbox } from './loop.ts'

export type Remote = { url: string; headers?: Record<string, string> }

const maxTimerDelay = 2 ** 31 - 1

const transport = (server: McpServer, remote?: Remote) => (remote ? new StreamableHTTPClientTransport(new URL(remote.url), { requestInit: { headers: remote.headers } }) : new StdioClientTransport({ command: server.command, args: server.args }))

async function open(name: string, server: McpServer, remote?: Remote) {
  const client = new Client({ name: 'service-agent', version: '0.1.0' })
  try {
    await client.connect(transport(server, remote))
    const { tools } = await client.listTools()
    const missing = server.tools.filter((allowed) => !tools.some((tool) => tool.name === allowed))
    if (missing.length) throw new Error(`Unknown tools on ${name}: ${missing.join(', ')}`)
    return { name, client, tools: tools.filter((tool) => server.tools.includes(tool.name)) }
  } catch (error) {
    await client.close()
    throw error
  }
}

export async function connect(servers: Record<string, McpServer>, remotes: Record<string, Remote> = {}): Promise<Toolbox & { close: () => Promise<void> }> {
  const settled = await Promise.allSettled(Object.entries(servers).map(([name, server]) => open(name, server, remotes[name])))
  const connections = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  const close = async () => {
    await Promise.all(connections.map(({ client }) => client.close()))
  }

  const failure = settled.find((result) => result.status === 'rejected')
  if (failure) {
    await close()
    throw failure.reason
  }

  const routes = new Map(connections.flatMap(({ name, client, tools }) => tools.map((tool) => [`${name}__${tool.name}`, { client, tool }])))

  const definitions: Tool[] = [...routes].map(([name, { tool }]) => ({
    name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }))

  return {
    definitions,
    close,
    async call(name, input, signal) {
      const route = routes.get(name)
      if (!route) return { content: `Tool not allowed: ${name}`, isError: true }
      const result = await route.client.callTool({ name: route.tool.name, arguments: input as Record<string, unknown> }, { signal, timeout: maxTimerDelay })
      return {
        content: result.content.map((block) => (block.type === 'text' ? block.text : JSON.stringify(block))).join('\n'),
        isError: result.isError ?? false,
      }
    },
  }
}
