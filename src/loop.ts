import type Anthropic from '@anthropic-ai/sdk'
import type { Message, MessageParam, Tool } from '@anthropic-ai/sdk/resources/messages'
import type { AgentConfig } from './config.ts'
import type { Tracer, Usage } from './trace.ts'

export type ToolResult = { content: string; isError: boolean }

export type Toolbox = {
  definitions: Tool[]
  call: (name: string, input: unknown, signal: AbortSignal) => Promise<ToolResult>
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

const tokens = ({ input, output, cacheWrite, cacheRead }: Usage) => input + output + cacheWrite + cacheRead

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return Promise.race([promise, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
}

async function invoke(toolbox: Toolbox, name: string, input: unknown, deadline: AbortSignal, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = AbortSignal.any([deadline, timeout])
  try {
    return { ...(await abortable(toolbox.call(name, input, signal), signal)), timedOut: false }
  } catch (error) {
    if (!timeout.aborted || deadline.aborted) throw error
    return { content: `Tool timed out after ${timeoutMs}ms`, isError: true, timedOut: true }
  }
}

async function steps({ client, toolbox, tracer }: Runtime, config: AgentConfig, messages: MessageParam[], deadline: AbortSignal): Promise<Message> {
  let used = 0
  for (let step = 0; step < config.maxSteps; step++) {
    const requested = performance.now()
    const request = {
      model: config.model,
      max_tokens: config.maxTokens,
      system: config.system,
      tools: toolbox.definitions,
      messages,
      ...(config.outputSchema && { output_config: { format: { type: 'json_schema' as const, schema: config.outputSchema } } }),
    }
    const response = await abortable(client.messages.create(request, { signal: deadline }), deadline)
    tracer.emit({ type: 'model.call', step, model: response.model, latencyMs: since(requested), stopReason: response.stop_reason, usage: usage(response.usage) })
    used += tokens(usage(response.usage))
    if (config.maxRunTokens && used > config.maxRunTokens) throw new Error(`Token budget exceeded: ${used} of ${config.maxRunTokens}`)
    messages.push({ role: 'assistant', content: response.content })
    if (response.stop_reason !== 'tool_use') return response

    const calls = response.content.filter((block) => block.type === 'tool_use')
    const results = await Promise.all(
      calls.map(async (call) => {
        const called = performance.now()
        const result = await invoke(toolbox, call.name, call.input, deadline, config.toolTimeoutMs)
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
          timedOut: result.timedOut,
        })
        return { type: 'tool_result' as const, tool_use_id: call.id, content, is_error: result.isError }
      }),
    )
    messages.push({ role: 'user', content: results })
  }
  throw new Error(`Step limit reached: ${config.maxSteps}`)
}

export async function run(runtime: Runtime, config: AgentConfig, messages: MessageParam[]): Promise<Message> {
  const deadline = AbortSignal.timeout(config.runTimeoutMs)
  try {
    return await steps(runtime, config, messages, deadline)
  } catch (error) {
    if (deadline.aborted) throw new Error(`Run timed out after ${config.runTimeoutMs}ms`, { cause: error })
    throw error
  }
}

export function output(message: Message, config: AgentConfig): unknown {
  if (message.stop_reason !== 'end_turn') throw new Error(`Run ended with stop reason: ${message.stop_reason}`)
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return config.outputSchema ? JSON.parse(text) : text
}
