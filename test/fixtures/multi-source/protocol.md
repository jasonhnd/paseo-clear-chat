# Shared timeline concurrency regression

`test/multi-source-fixture.test.cjs` uses Paseo 0.14.0's `AgentManager`, agent
message delivery queue, prompt orchestration, timeline store and projection.
The session and storage are in-memory synthetic boundaries; no model, child
process, network service or real session is used.

The submission fixture starts an active synthetic turn, enqueues source A and
flushes its delivery, then holds its provider admission. While it is held, source
B is separately enqueued and flushed and a human prompt enters through
`sendPromptToAgent`. Both agent batches use the same recipient-owned delivery
queue and `sendPreparedPromptToAgent`, matching the host dispatch boundary. The
fixture releases admission only after all three submissions have been initiated.
It compares the provider's received IDs, senders and text with the independently
specified expected messages, then checks the projected timeline against the same
expectation. Order is deliberately unconstrained. The synthetic provider injects
loss, duplication and misattribution in separate negative-control runs; each
must make the receipt assertion fail. These controls test the oracle, not a
production provider. The older event-queue scenario additionally checks error
and echo deduplication under a held timeline read.

The test discovers the server from `paseo` on `PATH`, or from an explicit
`PASEO_SERVER_ROOT` pointing to the server package. The test fails with an
installation instruction if the host is unavailable, and fails on a different
version. CI does not currently install the server, so its `npm test` gate fails
loudly until Paseo 0.14.0 is installed or `PASEO_SERVER_ROOT` is set. Run with:

```sh
export TMPDIR="$HOME/cc-test-tmp"
node --test test/multi-source-fixture.test.cjs
```

The fixture controls a specific admission interleaving; it does not prove every
possible scheduling interleaving or exercise a real provider or UI.
