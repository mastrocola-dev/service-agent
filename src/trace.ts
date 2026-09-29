import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import pricing from '../pricing.json' with { type: 'json' }

export type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number }

export type TraceEvent = { type: 'model.call'; step: number; model: string; latencyMs: number; stopReason: string | null; usage: Usage } | { type: 'tool.call'; step: number; name: string; input: unknown; latencyMs: number; resultChars: number; truncated: boolean; isError: boolean }

export type Tracer = { emit: (event: TraceEvent) => void }

const rates: Record<string, Usage | undefined> = pricing.usdPerMTok

export function cost(model: string, usage: Usage) {
  const rate = rates[model]
  if (!rate) return null
  const usd = usage.input * rate.input + usage.output * rate.output + usage.cacheWrite * rate.cacheWrite + usage.cacheRead * rate.cacheRead
  return Number((usd / 1_000_000).toFixed(6))
}

export function fileTracer(dir: string, agent: string, model: string) {
  const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomBytes(4).toString('hex')}`
  const path = join(dir, `${runId}.jsonl`)
  const started = performance.now()
  const total: Usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  const write = (record: object) => appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), runId, ...record })}\n`)

  mkdirSync(dir, { recursive: true })
  write({ type: 'run.start', agent, model })

  return {
    path,
    emit(event: TraceEvent) {
      if (event.type !== 'model.call') return write(event)
      for (const key of Object.keys(total) as (keyof Usage)[]) total[key] += event.usage[key]
      write({ ...event, costUsd: cost(model, event.usage) })
    },
    end(error?: unknown) {
      write({
        type: 'run.end',
        status: error ? 'error' : 'ok',
        ...(error ? { error: String(error) } : {}),
        durationMs: Math.round(performance.now() - started),
        usage: total,
        costUsd: cost(model, total),
      })
    },
  }
}
