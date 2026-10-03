import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { buffer } from 'node:stream/consumers'
import { createMcpHandler } from '@modelcontextprotocol/server'
import { createFixture } from './tools.ts'

export async function listen() {
  const handler = createMcpHandler(createFixture)
  const authorizations: (string | undefined)[] = []
  const server = createServer(async (request, response) => {
    authorizations.push(request.headers.authorization)
    const body = request.method === 'POST' ? await buffer(request) : undefined
    const answer = await handler.fetch(new Request(`http://localhost${request.url}`, { method: request.method, headers: request.headers as Record<string, string>, body }))
    response.writeHead(answer.status, Object.fromEntries(answer.headers)).end(await answer.text())
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  return { url: `http://localhost:${(server.address() as AddressInfo).port}/mcp`, authorizations, close: () => server.close() }
}
