import { text } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { loadAgent } from './config.ts'
import { output, run } from './loop.ts'
import { connect } from './mcp.ts'
import { fileTracer } from './trace.ts'

const { values, positionals } = parseArgs({
  options: { agent: { type: 'string', default: 'default' } },
  allowPositionals: true,
})

const config = await loadAgent(`agents/${values.agent}`)
const task = positionals.join(' ') || (process.stdin.isTTY ? '' : await text(process.stdin))
if (!task.trim()) throw new Error('No task provided: pass it as an argument or via stdin')

const tracer = fileTracer(process.env.TRACE_DIR ?? 'traces', values.agent, config.model)

try {
  const toolbox = await connect(config.mcpServers)
  const response = await run({ client: new Anthropic(), toolbox, tracer }, config, [{ role: 'user', content: task }]).finally(toolbox.close)
  const result = output(response, config)
  tracer.end()
  console.log(config.outputSchema ? JSON.stringify(result) : result)
} catch (error) {
  tracer.end(error)
  throw error
} finally {
  console.error(`trace: ${tracer.path}`)
}
