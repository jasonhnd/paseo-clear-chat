# Synthetic lifecycle provider fixture

This in-memory provider fixture emits SDK protocol events without a model, network,
credentials, subprocesses, timers, or persistent data. It does not register
itself with a daemon. The exported factory returns a provider registration, an
input log, and explicit out-of-band controls; each factory call is isolated.
The tests validate all inputs and events against the development SDK schemas.

The fixture does not implement idle cleanup or a clock. The host's official
one-hour threshold is unchanged. A completed turn with a running tool or a
pending permission is synthetic stimulus, not evidence that a host protects it.
The close refusal is a synthetic `request.failed`, not evidence that a real
provider can veto cleanup or that a host honors the failure. A host integration
must establish whether and how these signals can safely be injected before
using this fixture there; no host registration or configuration is included.

## Reproduction

With dependencies installed and `TMPDIR` set to the prescribed test directory:

```sh
node --test test/idle-lifecycle-fixture.test.cjs
```

Expected: three tests pass, zero fail or skip. Observed on Linux: three pass,
zero fail or skip, exit code 0. These are fixture checks, not daemon or UI
acceptance. The full suite and typecheck results belong in the card report.

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
not enforce protection themselves: a real host must decide whether to close a
target, and that decision is outside this fixture.
