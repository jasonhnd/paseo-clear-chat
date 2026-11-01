# Reply elapsed time after history replay: investigation

Verdict: **defect confirmed for the synthetic missing-timestamp Codex replay path**. This is an integration of the installed Paseo 0.14.0 server's actual Codex history reader, legacy hydration method and in-memory timeline store with Clear Chat's registered transformer and reply renderer. It is not an end-to-end daemon, app-server or browser test. It does not establish how frequently actual provider histories lack timing, whether an ordinary restart takes this legacy hydration path, or whether other providers behave the same way. All input is synthetic; no model or login was used.

## Reproduction and result

Install the repository dependencies with `npm ci`, ensure the `paseo` command is the installed 0.14.0 CLI, then run:

```sh
export TMPDIR="$HOME/cc-test-tmp"
node --test scripts/investigations/reply-replay-82.test.cjs
```

1. The probe supplies a synthetic Codex `thread/read` response with a user item and a final assistant item, with no item timestamps and no turn start or completion time. The real Paseo Codex session's `loadPersistedHistory` and `streamHistory` process it. The returned events have no timestamps.
2. The baseline puts those same two items into Paseo's actual timeline store with synthetic timestamps 21,099 ms apart. The registered Clear Chat transformer and renderer render the final reply and its actual footer: **`Worked for 21s`**.
3. The real `AgentManager.primeTimelineFromLegacyProviderHistory` processes the replay events using the actual timeline store. Persistence deletion and manager plumbing are stubs, the client timeline API is a shim, and React Native and React runtime behavior are supplied by the repository's component harness. The regenerated timestamps in the observed run were 0 ms apart. A fresh renderer mount displays **`Worked for 0s`**.
4. As a control, the probe repeats the history read and hydration with turn start and completion timestamps 21,099 ms apart. The rendered output is **`Worked for 21s`**.

The baseline represents a completed live turn using supplied timestamps; the probe does not run a live model or prove the original elapsed time of a real conversation. The fresh mount simulates a remount after hydration, not a browser reload. The test checks the `reply-duration` text produced by the renderer, not merely the input shape.

## Code path

In the installed Paseo 0.14.0 distribution, `agent/providers/codex-app-server-agent.js` lines 1333–1354 and 1571–1578 select item timestamps first and then turn start/end timestamps; if neither is available the event has no timestamp. `agent/agent-manager.js` line 3149 passes that absence through when priming legacy provider history. `agent/agent-timeline-store.js` lines 86–90 supplies the current time for each row lacking one. These paths are relative to the installed server's `dist/server/server` directory and the line numbers refer to the installed 0.14.0 build.

In Clear Chat, `client/live-renderers.tsx` lines 396–408 call `useReplyDuration` and pass the result to the footer. `client/reply-duration.ts` lines 9–23 loads the canonical timeline; `client/canonical-timeline.ts` lines 40–45 and 56–68 read and derive it. `client/reply-timing.ts` lines 43–46, 61 and 64 calculate `max(0, last event timestamp - first user timestamp)` for a completed turn. Lines 20–23 floor milliseconds to whole seconds; `client/components/turn-footer.tsx` lines 115–117 renders the resulting text.

With valid matching reply identity and turn boundaries, a regenerated last timestamp less than 1,000 ms after the regenerated user timestamp displays `0s`; an earlier last timestamp is clamped to zero. Equal timestamps are only one instance of this. Invalid timestamps yield no calculated duration, and genuine subsecond turns also display `0s`. If the replay has preserved timestamps, the calculation can remain correct. A fast replay is not evidence of the original turn duration.

## Separate proposal, not implemented

Prefer retaining the original authoritative timestamps or elapsed duration in Paseo's durable timeline and reuse them on replay. When original timing cannot be recovered, Paseo needs to expose timestamp provenance or an explicit unknown duration so Clear Chat can omit the elapsed label instead of displaying a fabricated replay duration. Clear Chat alone cannot reliably distinguish regenerated timestamps from genuine short turns using the current values. Verify with a real daemon integration that a completed timed turn survives the relevant hydration/restart path; test missing provenance as unknown, preserved timing, real subsecond turns, multiple turns and repeated reloads. No product fix is included in this investigation.

## Checks

- The focused investigation probe passed twice: 1 test passed per run, 0 failed. The recorded replay gap was 0 ms in both runs.
- `npm test`: 1,795 passed, 0 failed, 0 skipped.
- `npx tsc --noEmit`: passed.
- `npm ci`: completed; npm reported 12 dependency audit findings.
