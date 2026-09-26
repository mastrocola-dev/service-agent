import type Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { AgentConfig } from './config.ts'

export async function run(client: Anthropic, config: AgentConfig, messages: MessageParam[]): Promise<Message> {
  for (let step = 0; step < config.maxSteps; step++) {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: config.system,
      messages,
    })
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason !== 'tool_use') return response
  }
  throw new Error(`Step limit reached: ${config.maxSteps}`)
}
