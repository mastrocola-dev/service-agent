import { text } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { loadAgent } from './config.ts'
import { output, run } from './loop.ts'
import { connect } from './mcp.ts'

const { values, positionals } = parseArgs({
  options: { agent: { type: 'string', default: 'default' } },
  allowPositionals: true,
})

const config = await loadAgent(`agents/${values.agent}`)
const task = positionals.join(' ') || (process.stdin.isTTY ? '' : await text(process.stdin))
if (!task.trim()) throw new Error('No task provided: pass it as an argument or via stdin')

const toolbox = await connect(config.mcpServers)
const response = await run(new Anthropic(), config, toolbox, [{ role: 'user', content: task }]).finally(toolbox.close)
const result = output(response, config)

console.log(config.outputSchema ? JSON.stringify(result) : result)
