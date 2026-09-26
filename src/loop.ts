import type Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageParam, Tool, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages'
import type { AgentConfig } from './config.ts'

export type Toolbox = {
  definitions: Tool[]
  call: (name: string, input: unknown) => Promise<Pick<ToolResultBlockParam, 'content' | 'is_error'>>
}

export async function run(client: Anthropic, config: AgentConfig, toolbox: Toolbox, messages: MessageParam[]): Promise<Message> {
  for (let step = 0; step < config.maxSteps; step++) {
    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: config.system,
      tools: toolbox.definitions,
      messages,
    })
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason !== 'tool_use') return response

    const calls = response.content.filter((block) => block.type === 'tool_use')
    const results = await Promise.all(
      calls.map(async (call) => ({
        type: 'tool_result' as const,
        tool_use_id: call.id,
        ...(await toolbox.call(call.name, call.input)),
      })),
    )
    messages.push({ role: 'user', content: results })
  }
  throw new Error(`Step limit reached: ${config.maxSteps}`)
}
