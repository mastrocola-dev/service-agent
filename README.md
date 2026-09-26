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

- `agent.json`: `model`, `maxSteps`, `maxTokens`, `maxToolResultChars` (default 20000) and `mcpServers` (strict schema; unknown keys fail)
- `system.md`: system prompt, kept as Markdown for readable diffs

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
- **Loop depends on a `Toolbox`, not on MCP.** `loop.ts` defines the port; `mcp.ts` implements it. The loop is tested with fakes and knows no protocol.
- **Tool allowlist is mandatory.** Each server declares the tools an instance may call; unknown names fail at startup and calls outside the list never reach the server. Server annotations such as `readOnlyHint` are hints from the server, not a security boundary.
- **Tools namespaced as `<server>__<tool>`.** Avoids collisions across servers; server names are restricted to `[a-z0-9-]`.
- **Tool results are capped per instance.** Results beyond `maxToolResultChars` are truncated with an explicit marker telling the model to narrow the request, so one oversized result cannot exhaust the context window. The cap lives in the loop and applies to any `Toolbox`.
- **Tool errors go back to the model.** MCP reports failures as `isError` results, forwarded as `is_error` so the model can correct itself; transport failures abort the run.
- **Servers do not inherit the environment.** The MCP SDK passes only a safe default set of variables, so `ANTHROPIC_API_KEY` never reaches a tool server.
- **MCP servers run from sibling checkouts, not packages.** Node refuses type stripping inside `node_modules`, so packaging a server would require a build. Locally the host starts servers from their checkouts; in the cloud each server becomes its own Container App over streamable HTTP.
- **Style enforced by tooling.** Biome formats and lints (no semicolons, single quotes); `npm run check` gates CI, `npm run fix` applies it. Version pinned exactly because formatter output may change between releases. `lineWidth: 320` is the author's choice: lines are not wrapped by the formatter.
- **Minimal dependencies.** `@anthropic-ai/sdk`, `@modelcontextprotocol/client` and `zod` at runtime; CLI built on `node:util` and `node:stream`.
