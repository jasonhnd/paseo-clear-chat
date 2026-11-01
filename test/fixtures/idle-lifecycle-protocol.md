# Synthetic lifecycle provider fixture

This in-memory provider fixture emits SDK protocol events without a model, network,
credentials, subprocesses, timers, or persistent data. It does not register
itself with a daemon. The exported factory returns a provider registration, an
input log, and explicit out-of-band controls; each factory call is isolated.
The tests validate all inputs and events against the development SDK schemas.

The fixture does not implement idle cleanup or a clock. Its optional runtime
safety capability reports running synthetic work and a registered live child
process to the host. The close refusal remains a synthetic `request.failed`,
not evidence that a real provider can veto cleanup by refusing a close.

`idle-cleanup-integration.test.cjs` loads the installed Paseo 0.14 server's
plugin bridge, manager eligibility checks and idle cleanup sweep. It connects
this fixture through the bridge and uses a controlled clock; the manager's
storage and close side effects are replaced by a small test adapter. Each
case verifies retention and, after release and another hour, collection. The
child is a real synthetic subprocess, but its status is reported by the fixture:
this does not establish that Paseo discovers arbitrary operating-system child
processes. The pending approval goes through the host's permission handlers.

## Reproduction

With dependencies installed and `TMPDIR` set to the prescribed test directory:

```sh
node --test test/idle-lifecycle-fixture.test.cjs
node --test test/idle-cleanup-integration.test.cjs
```

Each command runs three tests. These checks require the Paseo CLI with the
0.14 server installed and are not daemon or UI acceptance tests. The full
suite and typecheck results belong in the card report.

## Protocol and controls

The test sends these SDK inputs (the child is announced by the fixture):

```json
{"type":"session.open","requestId":"open-parent","sessionId":"parent","config":{"cwd":".","env":{},"mcpServers":{},"settings":{},"persist":false},"history":"skip"}
{"type":"session.prompt","sessionId":"parent","prompt":{"clientMessageId":"turn-1","delivery":"auto","input":{"type":"message","content":[{"type":"text","text":"synthetic"}]}}}
{"type":"session.permission","sessionId":"parent","permissionId":"approval","response":{"behavior":"deny"}}
{"type":"session.close","sessionId":"child","requestId":"refused"}
{"type":"session.close","sessionId":"parent","requestId":"parent-close"}
{"type":"session.permission","sessionId":"child","permissionId":"approval","response":{"behavior":"allow"}}
{"type":"session.close","sessionId":"child","requestId":"accepted"}
```

After connecting and subscribing to events, `startBackground("parent")` emits
a running `timeline.item` with call ID `background`, and
`requestApproval("parent")` emits `session.permission` with ID `approval`.
The prompt emits `session.prompt_result`, then `session.turn` started and
completed; it does not resolve either stimulus. A permission input emits
`session.permission_resolved`; `finishBackground("parent")` emits the same
tool call completed. Duplicate starts and resolutions are rejected.

`openChild("parent", "child")` emits `session.opened` with
`parentSessionId: "parent"`, `toolCallId: "child-call"`, and
`restoration: "parent"`, followed by `session.ready`. Controls can target the
child independently. With `setCloseRefusal("child", true)`, the close input
above emits exactly:

```json
{"type":"request.failed","requestId":"refused","error":{"code":"synthetic_refusal","message":"Synthetic close refusal"}}
```

The child remains present. As negative controls, closing the parent emits
`session.closed` for the parent and `request.completed` for `parent-close`
without closing the child; after the child work and approval resolve,
`setCloseRefusal("child", false)` allows its close and emits the corresponding
closed and completed events. Closing an unknown session fails. A second fixture
instance has independent sessions and events. These controls intentionally do
do not decide cleanup themselves. When explicitly enabled, the separate
`session.can_stop_runtime` capability reports background work and registered
child-process state so the host can make that decision.
