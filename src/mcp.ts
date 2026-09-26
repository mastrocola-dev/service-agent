import type { Tool } from '@anthropic-ai/sdk/resources/messages'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { McpServer } from './config.ts'
import type { Toolbox } from './loop.ts'

async function open(name: string, server: McpServer) {
  const client = new Client({ name: 'service-agent', version: '0.1.0' })
  try {
    await client.connect(new StdioClientTransport({ command: server.command, args: server.args }))
    const { tools } = await client.listTools()
    const missing = server.tools.filter((allowed) => !tools.some((tool) => tool.name === allowed))
    if (missing.length) throw new Error(`Unknown tools on ${name}: ${missing.join(', ')}`)
    return { name, client, tools: tools.filter((tool) => server.tools.includes(tool.name)) }
  } catch (error) {
    await client.close()
    throw error
  }
}

export async function connect(servers: Record<string, McpServer>): Promise<Toolbox & { close: () => Promise<void> }> {
  const settled = await Promise.allSettled(Object.entries(servers).map(([name, server]) => open(name, server)))
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
    async call(name, input) {
      const route = routes.get(name)
      if (!route) return { content: `Tool not allowed: ${name}`, is_error: true }
      const result = await route.client.callTool({ name: route.tool.name, arguments: input as Record<string, unknown> })
      return {
        content: result.content.map((block) => ({
          type: 'text' as const,
          text: block.type === 'text' ? block.text : JSON.stringify(block),
        })),
        is_error: result.isError,
      }
    },
  }
}
