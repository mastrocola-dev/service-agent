import type Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages'
import type { AgentConfig } from './config.ts'
import type { Tracer, Usage } from './trace.ts'

export type ToolResult = { content: string; isError: boolean }

export type Toolbox = {
  definitions: Tool[]
  call: (name: string, input: unknown) => Promise<ToolResult>
}

export type Runtime = { client: Anthropic; toolbox: Toolbox; tracer: Tracer }

const truncate = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}\n[truncated: ${max} of ${text.length} chars; narrow the request]`)

const since = (start: number) => Math.round(performance.now() - start)

const usage = (usage: Message['usage']): Usage => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheWrite: usage.cache_creation_input_tokens ?? 0,
  cacheRead: usage.cache_read_input_tokens ?? 0,
})

export async function run({ client, toolbox, tracer }: Runtime, config: AgentConfig, messages: MessageParam[]): Promise<Message> {
  for (let step = 0; step < config.maxSteps; step++) {
    const requested = performance.now()
    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: config.system,
      tools: toolbox.definitions,
      messages,
      ...(config.outputSchema && { output_config: { format: { type: 'json_schema' as const, schema: config.outputSchema } } }),
    })
    tracer.emit({ type: 'model.call', step, model: response.model, latencyMs: since(requested), stopReason: response.stop_reason, usage: usage(response.usage) })
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason !== 'tool_use') return response

    const calls = response.content.filter((block) => block.type === 'tool_use')
    const results = await Promise.all(
      calls.map(async (call) => {
        const called = performance.now()
        const result = await toolbox.call(call.name, call.input)
        const content = truncate(result.content, config.maxToolResultChars)
        tracer.emit({
          type: 'tool.call',
          step,
          name: call.name,
          input: call.input,
          latencyMs: since(called),
          resultChars: result.content.length,
          truncated: content !== result.content,
          isError: result.isError,
        })
        return { type: 'tool_result' as const, tool_use_id: call.id, content, is_error: result.isError }
      }),
    )
    messages.push({ role: 'user', content: results })
  }
  throw new Error(`Step limit reached: ${config.maxSteps}`)
}

export function output(message: Message, config: AgentConfig): unknown {
  if (message.stop_reason !== 'end_turn') throw new Error(`Run ended with stop reason: ${message.stop_reason}`)
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return config.outputSchema ? JSON.parse(text) : text
}
