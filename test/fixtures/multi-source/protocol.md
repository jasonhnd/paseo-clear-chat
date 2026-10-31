# Synthetic multi-source control protocol

This standalone fixture uses newline-delimited JSON on stdin and stdout. It is
not ACP, a Paseo endpoint, or a host injection mechanism. It makes no network
requests, starts no model or provider, and uses only the fixed fictional data
in the source. Its events are a test oracle, not evidence of host or UI behavior.

Run from the repository root:

```sh
node test/fixtures/multi-source/fixture.cjs < test/fixtures/multi-source/input.jsonl
node --test test/multi-source-fixture.test.cjs
```

The first command's exact input and expected output are in the adjacent
`input.jsonl` and `output.jsonl`. Every input has an integer `id` and an `op`;
replies echo the `id` with a `result` or `error`. Events have a monotonically
increasing `sequence`. Requests may be pipelined; they are handled in input
order. Each event precedes the reply to the request that caused it.

`start` launches two independently gated tasks. Its reply lists both pending
sources. `human` emits a uniquely identified human message while both tasks
are still pending. `release` takes a `source` and resolves only that task's
gate, emitting its uniquely identified message followed by its finish event.
Both sources emit exactly the same text. `finish` succeeds only after both
tasks finish. The supplied input releases source B before source A so source
identity cannot be inferred from creation order. The alternate order is also
tested. Nothing is emitted spontaneously based on timing.

Positive control: the sample exchange has eight events, in the exact order in
`output.jsonl`, and five successful replies. Both source messages have the same
text but distinct source and message IDs; the human message has a third ID.
The automated test checks the complete transcript, including the pending sets.
Negative controls reject transcripts with a missing or duplicated message,
misattributed source, or reordered delivery. Invalid operations, repeated
releases, unknown sources, early finish and malformed JSON produce errors
without producing additional task or message events.

This control protocol deliberately does not specify how to inject agent
messages or human input into a host. A host owner must provide a safe isolated
injection handoff and map these identities and barriers to actual host inputs
before isolated host and UI acceptance can check for lost, duplicated, or
misattributed messages. Fixture and unit-test success alone do not establish
that acceptance.
