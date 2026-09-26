import Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { loadAgent } from './config.ts'
import { run } from './loop.ts'

const { values } = parseArgs({ options: { agent: { type: 'string', default: 'default' } } })
const config = await loadAgent(`agents/${values.agent}`)
const client = new Anthropic()
const messages: MessageParam[] = []

const text = (message: Message) => message.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')

const rl = createInterface({ input: process.stdin, output: process.stdout })
rl.setPrompt('> ')
rl.prompt()

for await (const line of rl) {
  if (line.trim()) {
    messages.push({ role: 'user', content: line })
    console.log(text(await run(client, config, messages)))
  }
  rl.prompt()
}
