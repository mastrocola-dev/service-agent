# service-agent

Agent host for mastrocola.dev. Tools are consumed exclusively through MCP; see `docs/architecture/agent-v1.md` and ADR-003.

## Run

```sh
npm ci
echo "ANTHROPIC_API_KEY=..." > .env
npm start -- --agent default "summarize the input"
npm start -- --agent adr-index "Index all ADRs"
cat input.md | npm start -- --agent default
```

## CLI contract

The CLI runs one task to completion and exits, mirroring how an application invokes the agent.

- Input: positional argument, or stdin when no argument is given
- Output: final text on stdout, or compact single-line JSON when the instance declares an output schema; diagnostics on stderr
- Exit code: `0` on `end_turn`; `1` on invalid config, API failure, step limit or any other stop reason

## Agent instances

Each instance lives in `agents/<name>/`:

- `agent.json`: `model`, `maxSteps`, `maxTokens`, `maxToolResultChars` (default 20000), `runTimeoutMs` (default 120000), `toolTimeoutMs` (default 30000), optional `maxRunTokens` and `mcpServers` (strict schema; unknown keys fail)
- `system.md`: system prompt, kept as Markdown for readable diffs
- `output.schema.json` (optional): JSON Schema of the result. It is the instance's published contract: consumers can generate types from it. Structured outputs apply the [JSON Schema subset](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#json-schema-limitations) supported by the API; unsupported keywords fail the first call with a 400. Compare `enum` values case-insensitively, since capitalization is not guaranteed.

Each entry in `mcpServers` starts a stdio MCP server and must list the `tools` it may use:

```json
"mcpServers": {
  "docs": { "command": "node", "args": ["../mcp-docs/src/main.ts", "../docs"], "tools": ["read_document"] }
}
```

The `docs` instance uses [mcp-docs](https://github.com/mastrocola-dev/mcp-docs) and expects sibling checkouts:

```
mastrocola-dev/
├── service-agent/
├── mcp-docs/
└── docs/
```

Never give a tool server access to this repository's root: it holds `.env`.

## Guardrails

| Guardrail | Scope | On breach |
|---|---|---|
| `maxSteps` | model calls per run | run fails |
| `runTimeoutMs` | whole run, including in-flight model and tool calls | run fails |
| `maxRunTokens` | input, output and cache tokens summed across calls; checked after each call | run fails |
| `toolTimeoutMs` | one tool call | the model receives an `is_error` result and may recover |
| `maxToolResultChars` | one tool result | result truncated with a marker |
| tool allowlist | tools each instance may call | call refused before reaching the server |

Human approval for side-effecting tools is not implemented: it needs to pause a run, persist it and resume later, which arrives with state and checkpoints. Until then, **no side-effecting tool may be added to an allowlist**.

## Traces

Every run writes `traces/<runId>.jsonl` (override with `TRACE_DIR`) and prints its path on stderr. One JSON object per line, appended as it happens, so a failed run keeps everything up to the failure:

| Event | Fields |
|---|---|
| `run.start` | `agent`, `model` |
| `model.call` | `step`, served `model`, `latencyMs`, `stopReason`, `usage` (`input`, `output`, `cacheWrite`, `cacheRead`), `costUsd` |
| `tool.call` | `step`, `name`, `input`, `latencyMs`, `resultChars`, `truncated`, `isError`, `timedOut` |
| `run.end` | `status` (`ok` or `error`), `error`, `durationMs`, total `usage`, total `costUsd` |

Prompts, answers and tool results are never written, only their sizes. Cost comes from `pricing.json` (USD per million tokens, with source and retrieval date) at write time; models missing from the table get `costUsd: null`. Update the table when prices change or a new model is adopted.

```sh
jq -c 'select(.type == "tool.call") | [.name, .resultChars, .truncated]' traces/*.jsonl
```

## Test

```sh
npm test
npm run test:coverage
```

MCP client tests run against a minimal fixture server (`test/fixtures/server.ts`). Tests are selected by the explicit glob `test/**/*.test.ts`, since Node's default patterns would also pick up fixtures.

Coverage uses Node's native V8 coverage. It only reports files loaded during tests, so every source file needs at least one test that loads it. CLI tests spawn the process and cover its contract (exit codes, stdin) without reaching the API; the success path after the model call stays uncovered by design.

## Decisions

- **Native TypeScript execution.** Node 24 strips types at runtime; no build step. `tsc` runs only as a CI gate. `erasableSyntaxOnly` forbids `enum`, `namespace` and parameter properties.
- **Own control loop.** The loop, its stop conditions and its instrumentation point are the core of this service, so the SDK tool runner is not used.
- **One-shot CLI, not a REPL.** The agent is embedded in applications: a task goes in, a result comes out. The integration contract is `run()`; transports (CLI now, async HTTP or queue later) are thin adapters over it.
- **Structured results through native JSON outputs.** An instance with `output.schema.json` sends it as `output_config.format`; constrained decoding applies to the final answer only, so tool calls are unaffected. The response is parsed, not validated locally: the API rejects invalid schemas, non-`end_turn` stops already fail the run, and a validator would only turn enum casing variance into a failed run.
- **`output()` owns result extraction.** Stop-reason handling and parsing live next to the loop, so every transport (CLI now, HTTP or queue later) returns results the same way.
- **Traces as JSON Lines through a `Tracer` port.** The loop emits model and tool calls; `trace.ts` appends them synchronously, so each event is on disk before the next step. Cost is computed when written, because a trace is a historical record: recomputing with a later price table would misstate past runs. An OpenTelemetry exporter can replace the file tracer later without touching the loop.
- **Deadlines owned by the loop.** One `AbortSignal` bounds the run; each tool call combines it with its own timeout, so the loop can tell a slow tool (recoverable) from an exhausted run (fatal). Calls are raced against their signal, so a guardrail never depends on a client or server honoring cancellation. The MCP SDK's own request timeout is disabled to keep a single source of deadlines.
- **Token budget, not cost budget.** `maxRunTokens` works for every model, including those missing from `pricing.json`.
- **`run()` takes a `Runtime`.** Client, toolbox and tracer travel together as the set every transport assembles.
- **Loop depends on a `Toolbox`, not on MCP.** `loop.ts` defines the port; `mcp.ts` implements it. The loop is tested with fakes and knows no protocol.
- **Tool allowlist is mandatory.** Each server declares the tools an instance may call; unknown names fail at startup and calls outside the list never reach the server. Server annotations such as `readOnlyHint` are hints from the server, not a security boundary.
- **Tools namespaced as `<server>__<tool>`.** Avoids collisions across servers; server names are restricted to `[a-z0-9-]`.
- **Tool results are capped per instance.** Results beyond `maxToolResultChars` are truncated with an explicit marker telling the model to narrow the request, so one oversized result cannot exhaust the context window. The cap lives in the loop and applies to any `Toolbox`.
- **Tool errors go back to the model.** MCP reports failures as `isError` results, forwarded as `is_error` so the model can correct itself; transport failures abort the run.
- **Servers do not inherit the environment.** The MCP SDK passes only a safe default set of variables, so `ANTHROPIC_API_KEY` never reaches a tool server.
- **MCP servers run from sibling checkouts, not packages.** Node refuses type stripping inside `node_modules`, so packaging a server would require a build. Locally the host starts servers from their checkouts; in the cloud each server becomes its own Container App over streamable HTTP.
- **Style enforced by tooling.** Biome formats and lints (no semicolons, single quotes); `npm run check` gates CI, `npm run fix` applies it. Version pinned exactly because formatter output may change between releases. `lineWidth: 320` is the author's choice: lines are not wrapped by the formatter.
- **Minimal dependencies.** `@anthropic-ai/sdk`, `@modelcontextprotocol/client` and `zod` at runtime; CLI built on `node:util` and `node:stream`.
