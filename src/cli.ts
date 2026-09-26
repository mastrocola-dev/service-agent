import { text } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import Anthropic from '@anthropic-ai/sdk'
import { loadAgent } from './config.ts'
import { run } from './loop.ts'

const { values, positionals } = parseArgs({
  options: { agent: { type: 'string', default: 'default' } },
  allowPositionals: true,
})

const config = await loadAgent(`agents/${values.agent}`)
const task = positionals.join(' ') || (process.stdin.isTTY ? '' : await text(process.stdin))
if (!task.trim()) throw new Error('No task provided: pass it as an argument or via stdin')

const response = await run(new Anthropic(), config, [{ role: 'user', content: task }])
if (response.stop_reason !== 'end_turn') throw new Error(`Run ended with stop reason: ${response.stop_reason}`)

const output = response.content
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('\n')
console.log(output)
