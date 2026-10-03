import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { loadAgent, type McpServer } from './config.ts'
import { output, run, type Toolbox } from './loop.ts'
import { add, cost, type TraceEvent, type Usage } from './trace.ts'

const Job = z.object({
  v: z.literal(1),
  type: z.literal('run'),
  jobId: z.string().min(1),
  instance: z.literal('ask'),
  input: z.object({ question: z.string().trim().min(3).max(500) }),
})

const Answer = z.object({ outOfScope: z.boolean(), answer: z.string().max(1500), sources: z.array(z.string()).max(5) })

const Documents = z.array(z.object({ path: z.string() }))

type Progress = { type: 'started' } | { type: 'step'; kind: 'model' | 'tool'; name?: string } | { type: 'completed'; output: z.infer<typeof Answer>; costUsd: number } | { type: 'failed'; reason: 'timeout' | 'budget' | 'redelivered' | 'error'; costUsd: number }

export type JobEvent = { v: 1; jobId: string; seq: number } & Progress

export type Worker = {
  client: Anthropic
  connect: (servers: Record<string, McpServer>) => Promise<Toolbox & { close: () => Promise<void> }>
  publish: (event: JobEvent) => Promise<void>
  log: (line: string) => void
}

const agents = fileURLToPath(new URL('../agents', import.meta.url))

const text = (error: unknown) => (error instanceof Error ? error.message : String(error))

const reason = (error: unknown) => (/^Run timed out/.test(text(error)) ? 'timeout' : /^Token budget exceeded/.test(text(error)) ? 'budget' : 'error')

async function verified(toolbox: Toolbox, answer: z.infer<typeof Answer>): Promise<z.infer<typeof Answer>> {
  if (answer.outOfScope) return { outOfScope: true, answer: '', sources: [] }
  const listed = await toolbox.call('docs__list_documents', {}, AbortSignal.timeout(10_000))
  const paths = Documents.parse(JSON.parse(listed.content)).map((document) => document.path)
  const unknown = answer.sources.filter((source) => !paths.includes(source))
  if (!answer.sources.length || unknown.length) throw new Error(`Unverified sources: ${unknown.join(', ') || 'none given'}`)
  return answer
}

export const createWorker =
  ({ client, connect, publish, log }: Worker) =>
  async (message: unknown, deliveryCount: number) => {
    const job = Job.safeParse(message)
    if (!job.success) return
    const { jobId, instance, input } = job.data
    const sent: Promise<void>[] = []
    const emit = (event: Progress) => {
      const sending = publish({ v: 1, jobId, seq: sent.length, ...event })
      sending.catch(() => {})
      sent.push(sending)
    }
    if (deliveryCount > 1) return publish({ v: 1, jobId, seq: 0, type: 'failed', reason: 'redelivered', costUsd: 0 })

    const config = await loadAgent(join(agents, instance))
    const usage: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    const spent = () => cost(config.model, usage) ?? 0
    const tracer = {
      emit(event: TraceEvent) {
        log(JSON.stringify({ jobId, ...event, input: undefined }))
        if (event.type === 'tool.call') return emit({ type: 'step', kind: 'tool', name: event.name })
        add(usage, event.usage)
        emit({ type: 'step', kind: 'model' })
      },
    }

    emit({ type: 'started' })
    await sent[0]
    try {
      const toolbox = await connect(config.mcpServers)
      try {
        const question = input.question.replaceAll(/<\/?question>/gi, '')
        const response = await run({ client, toolbox, tracer }, config, [{ role: 'user', content: `<question>${question}</question>` }])
        emit({ type: 'completed', output: await verified(toolbox, Answer.parse(output(response, config))), costUsd: spent() })
      } finally {
        await toolbox.close()
      }
    } catch (error) {
      log(JSON.stringify({ jobId, type: 'run.error', error: text(error) }))
      emit({ type: 'failed', reason: reason(error), costUsd: spent() })
    }
    await Promise.all(sent)
  }
