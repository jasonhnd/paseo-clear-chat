# Reply timing and synthetic replay

Issue #82 investigated the duration shown under a replaced assistant reply. This
is an investigation and test coverage, not a behavior change.

`client/reply-timing.ts` walks canonical entries in display order. When both
adjacent entries have a turn ID it uses equality to continue the turn; otherwise
it uses a user message as the legacy boundary. A turn with a visible user
message starts at that message's timestamp and closes at the last entry's
timestamp, even when the last entry follows the reply. The difference is
clamped to zero. Only the last eligible reply in a response gets the duration;
running responses do not get a new final duration. Missing or invalid endpoint
timestamps yield no duration. Intermediate timestamps are not sorted. The
footer floors milliseconds to seconds and omits absent durations.

Paseo 0.14.0's [turn timing](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/app/src/timeline/turn-time.ts)
also uses the trigger and final item timestamps and clamps negative results to
zero. Its [turn membership](https://github.com/getpaseo/paseo/blob/v0.14.0/packages/protocol/src/timeline-turn.ts)
recognizes additional trigger types, so this comparison does not assert that
all host and plugin grouping is identical.

The six synthetic tests in `test/reply-timing-replay.test.cjs` use three-item
timelines. With IDs held present and with IDs held absent, a 17-second endpoint
difference yields 17 seconds, a uniform shift preserves it, and equal replay
timestamps yield zero. Changing only the IDs leaves the simple turn unchanged,
while a new identified turn without a prompt has no duration. They cover missing
and invalid endpoints, equal and reversed endpoints, out-of-order and invalid
intermediate timestamps, page splits, and an incomplete initial tail. These
fixtures demonstrate that changed timestamp differences can explain the display
change without a missing turn ID; they do not prove which change caused the
reported host observation.

A zero difference in this API does not say whether a turn was actually fast or
its original timestamps were lost during replay. There is no provenance or
original duration in these inputs to distinguish those cases. Reconstructing a
historical duration would invent timing; suppressing all zero durations would
change the existing host-aligned UI contract for legitimate zero-length turns.
No supported minimal behavior fix was identified. A reliable correction would
need authoritative historical timing or a host-provided indication that timing
is unavailable; otherwise changing the display requires a product decision.

The reported 552 identical projected item objects and unchanged visible grouping
are observations supplied in the issue, not independently recaptured here. The
fixture in that report has no original replay timestamps. No claim is made about
missing IDs causing the observation, a 0.14 regression, real providers, or image
association.

## Verification


- `npm ci`: passed; 364 packages added, 365 audited, zero vulnerabilities;
  npm reported three dependency deprecation warnings.
- `node --test test/reply-timing-replay.test.cjs test/reply-duration.test.cjs test/canonical-timeline.test.cjs`:
  41 passed, 0 failed, 0 skipped.
- `npx tsc --noEmit`: passed.
- `mkdir -p .issue-82-tmp && TMPDIR="$PWD/.issue-82-tmp" npm test`:
  1,752 tests, 1,750 passed, 2 failed, 0 skipped. Both failures were in
  `test/hermes-journal-fixture.test.cjs`: “synthetic completed transcripts
  survive fresh processes with exact native identity and isolated sessions” and
  “explicit state and log locations are mandatory”. Both fail the existing
  assertion `TMPDIR must be outside the repository`, which conflicts with this
  task's workspace restriction. No assertion was changed. An initial `npm test`
  without an explicit TMPDIR was interrupted after discovering it created test
  fixtures in the system temporary directory; it has no final test count.
- Different-vendor review and isolated-host recheck: NOT TESTED; no behavior
  change candidate was proposed. Old-host and real-provider checks: NOT TESTED.
  Image association: NOT TESTED.
