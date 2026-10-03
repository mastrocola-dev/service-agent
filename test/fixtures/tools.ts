import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

export function createFixture() {
  const server = new McpServer({ name: 'fixture', version: '0.0.0' })
  server.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({ content: [{ type: 'text', text }] }))
  server.registerTool('write', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: 'written' }] }))
  server.registerTool('slow', { inputSchema: z.object({}) }, () => new Promise(() => {}))
  return server
}
