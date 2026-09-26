# service-agent

Agent host for mastrocola.dev. Tools are consumed exclusively through MCP; see `docs/architecture/agent-v1.md` and ADR-003.

## Run

```sh
npm ci
echo "ANTHROPIC_API_KEY=..." > .env
npm start -- --agent default "summarize the input"
cat input.md | npm start -- --agent default
```

## CLI contract

The CLI runs one task to completion and exits, mirroring how an application invokes the agent.

- Input: positional argument, or stdin when no argument is given
- Output: final text on stdout; diagnostics on stderr
- Exit code: `0` on `end_turn`; `1` on invalid config, API failure, step limit or any other stop reason

## Agent instances

Each instance lives in `agents/<name>/`:

- `agent.json`: `model`, `maxSteps`, `maxTokens` (strict schema; unknown keys fail)
- `system.md`: system prompt, kept as Markdown for readable diffs

## Decisions

- **Native TypeScript execution.** Node 24 strips types at runtime; no build step. `tsc` runs only as a CI gate. `erasableSyntaxOnly` forbids `enum`, `namespace` and parameter properties.
- **Own control loop.** The loop, its stop conditions and its instrumentation point are the core of this service, so the SDK tool runner is not used.
- **One-shot CLI, not a REPL.** The agent is embedded in applications: a task goes in, a result comes out. The integration contract is `run()`; transports (CLI now, async HTTP or queue later) are thin adapters over it.
- **Minimal dependencies.** `@anthropic-ai/sdk` and `zod` at runtime; CLI built on `node:util` and `node:readline`.