# Synthetic background task fixture

This is a no-model ACP agent for later isolated host acceptance. It makes no network or provider calls and creates no real background work. The process keeps two synthetic task states in memory. Its private Unix control socket is a fixture interface, not an ACP method or a claim of host support. Use a private temporary directory and synthetic data only. Do not point it at a live host or real conversations. Host injection and UI behavior are unverified; use them only after an explicit isolated-host handoff.

Run the self-contained check with an existing absolute temporary directory:

```sh
node --test test/background-task-fixture.test.cjs
```

Observed on Linux: 2 tests passed, 0 failed, 0 skipped (exit 0). This checks the fixture protocol, not product acceptance. For manual ACP use, create a private directory, set `BACKGROUND_TASK_FIXTURE_SOCKET` to a nonexistent socket path inside it, and run:

```sh
node test/fixtures/background-task/agent.cjs acp
```

Send one JSON object per line to stdin. These exact requests initialize the agent and create a session (the working directory value is ignored by the fixture):

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":".","mcpServers":[]}}
```

Take `result.sessionId` from response 2 and substitute it for `SESSION` in the next request and commands:

```json
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"SESSION","prompt":[{"type":"text","text":"Run synthetic tasks"}]}}
```

Expected stdout: `session/update` tool calls `synthetic-complete` and `synthetic-fail`, both `in_progress`; then an `agent_message_chunk` saying `Synthetic reply; background tasks are still running.`; then response 3 with `{"stopReason":"end_turn"}`. The process remains alive after that response. From another terminal with the same socket environment, inspect and control it:

```sh
node test/fixtures/background-task/control.cjs '{"action":"status","sessionId":"SESSION"}'
node test/fixtures/background-task/control.cjs '{"action":"progress","sessionId":"SESSION","taskId":"synthetic-complete"}'
node test/fixtures/background-task/control.cjs '{"action":"progress","sessionId":"SESSION","taskId":"synthetic-fail"}'
node test/fixtures/background-task/control.cjs '{"action":"complete","sessionId":"SESSION","taskId":"synthetic-complete"}'
node test/fixtures/background-task/control.cjs '{"action":"status","sessionId":"SESSION"}'
node test/fixtures/background-task/control.cjs '{"action":"fail","sessionId":"SESSION","taskId":"synthetic-fail"}'
node test/fixtures/background-task/control.cjs '{"action":"status","sessionId":"SESSION"}'
```

Expected status responses progress from both `in_progress`, to `completed` and `in_progress`, to `completed` and `failed`. Each progress or terminal command returns its task ID and status; the agent writes a corresponding `session/update` `tool_call_update` to ACP stdout after the prompt response. Progress retains the `in_progress` status and includes a progress message. A command for a finished task returns `task already finished`; an unknown session or task returns an error and emits no update. The CLI exits 1 on a control error. A second session has independent empty state. Only one prompt is accepted per session. EOF on agent stdin closes the socket; state is intentionally not persisted.

The automated test observes all of these ordering, status, and negative controls, and verifies that a missing or relative socket path fails and an existing file is not replaced. It does not exercise a host, its event projection, or the UI. Linux host/UI acceptance, macOS tests, and independent cross-vendor review remain separate gates.
