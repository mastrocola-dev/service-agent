import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createFixture } from './tools.ts'

await createFixture().connect(new StdioServerTransport())
