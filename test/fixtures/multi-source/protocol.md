# Shared timeline concurrency regression

`test/multi-source-fixture.test.cjs` uses Paseo 0.14.0's `AgentManager`, agent
message delivery queue, prompt orchestration, timeline store and projection.
The session and storage are in-memory synthetic boundaries; no model, child
process, network service or real session is used.

The submission fixture starts an active synthetic turn, enqueues source A and
flushes its delivery, then holds its provider admission. While it is held, source
B is separately enqueued and flushed and a human prompt enters through
`sendPromptToAgent`. The expected admission order is A, human, B: the delivery
queue holds B until A completes, and the manager holds the human admission until
A completes. A second scenario holds A at the dispatch boundary before manager
admission and verifies that B cannot overtake A there. Both scenarios compare
provider receipts and projected timeline rows in order, including IDs, senders,
and text. Synthetic loss, duplication, misattribution and reversed receipts
exercise the assertion. The older event-queue scenario additionally checks error
and echo deduplication under a held timeline read.

The test discovers the server from the installed `@getpaseo/server`
devDependency first, then from `paseo` on `PATH`; `PASEO_SERVER_ROOT`, when
set, overrides both. It fails with an installation instruction if the host is
unavailable, and fails on a different version. `npm ci` installs the 0.14.0
server for the full `npm test` suite. Run the targeted test with:

```sh
export TMPDIR="$HOME/cc-test-tmp"
node --test test/multi-source-fixture.test.cjs
```

The fixture controls a specific admission interleaving; it does not prove every
possible scheduling interleaving or exercise a real provider or UI.
