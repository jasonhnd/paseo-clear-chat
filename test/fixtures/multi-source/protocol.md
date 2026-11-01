# Shared timeline concurrency regression

`test/multi-source-fixture.test.cjs` uses the installed Paseo 0.14.0 server's
`AgentManager`, timeline store, projection, and session event queue. It registers
an in-memory synthetic session; it starts no model, child process, or network
service. A held timeline read models delayed storage during error deduplication.
While that read is pending, three sources send identical text with distinct
message and sender IDs, a human echo arrives twice, a source event is repeated,
and another identical failure arrives. The assertions inspect the host's shared
projected timeline, including message order, source identity, human echo and
provider ID, and the deduplicated error. They do not compare fixture transcripts.
This is a host integration test, not an end-to-end provider or UI test.

The test discovers the server from `paseo` on `PATH`, or from an explicit
`PASEO_SERVER_ROOT` pointing to the server package. It skips with a reason if
neither exists; a different server version fails. To require the integration test
in an environment without the CLI on `PATH`, install Paseo 0.14.0 and set that
variable before running the suite. Run it directly with:

```sh
export TMPDIR="$HOME/cc-test-tmp"
node --test test/multi-source-fixture.test.cjs
```

For a mutation check, insert this immediately after `registerSession`:

```js
const bypassed = [];
manager.enqueueSessionEvent = (id, event) => {
  bypassed.push(manager.dispatchSessionEvent(manager.agents.get(id), event));
};
manager.drainSessionEvents = async () => { await Promise.all(bypassed); };
```

This bypasses the actual per-agent queue. The held reads then both see the old
state, and the assertion finds two concatenated system errors instead of one.
Remove the mutation and the test passes. The test controls the read boundary;
it does not claim to reproduce a particular production latency or prove all
possible concurrency interleavings.

The previous standalone fixture used a five-second synchronous child-process
timeout, which could fail under load. This replacement launches no child
process and uses a 30-second test timeout as a hang bound. Extreme scheduling
or import delays can still exceed that bound, and other suite tests retain
their own timeouts.
