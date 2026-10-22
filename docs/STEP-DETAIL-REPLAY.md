# Step detail replay and responsive host handoff

Investigated on 2026-10-22, starting at `origin/feat/v0` commit `c6946e5`.
The current failure is in the replay's synchronization and expected values.
The selected step's reading position is retained by the product.

## Three unchanged full runs

All runs used `scripts/replay-step-details.cjs` without `--fields-only`, fresh
Chrome profiles, and the same installed dependencies.

| Run | Seconds | Failing checkpoint | Width | Actual value |
| --- | ---: | --- | ---: | --- |
| 1 | 17.593 | Navigate to `/switching` after fields | 1440 | `net::ERR_ABORTED`; no scroll measurement at this checkpoint |
| 2 | 17.160 | Navigate to `/switching` after fields | 1440 | `net::ERR_ABORTED`; no scroll measurement at this checkpoint |
| 3 | 18.949 | Initial scroll before switching long steps | 1440 | `scrollTop = 999`, assertion expected 1000 |

The field loop left its last phone modal open. Resizing to desktop removed that
modal and triggered its asynchronous `history.back()` cleanup while the runner
started the next navigation. The field loop was added in `2172ccc`.

## Full-replay bisect

`git bisect start c6946e5 b8e1efa` ran only the full replay at each candidate.
A diagnostic wrapper logged time and DOM values on timeout without changing
waits or assertions. The starting endpoint was also tested directly.

| Commit | Seconds | Result |
| --- | ---: | --- |
| `b8e1efa` | 32.337 | Pass, starting endpoint |
| `5b859ec` | 8.242 | Fail: 1180 to 820, actual offset 0, expected 1000 |
| `d271d2d` | 33.660 | Fail: layout at 1440, waits for removed Show all button |
| `5c0e846` | 33.619 | Pass |
| `75316f7` | 33.078 | Fail: layout at 1440, waits for removed Show all button |
| `669dcca` | 32.339 | Pass, immediate parent of first bad commit |

The first bad **full replay** is `75316f7`: it replaced the detail body with a
virtual list but left the runner looking for the old output disclosure. These
historical failures have different causes; this bisect alone does not establish
a current product scroll regression.

## Current rotation timeout

After fixing only the navigation synchronization, a trace reproduced the
reported rotation timeout on the latest product code:

| Event | Width | DOM offset | Saved reading offset |
| --- | ---: | ---: | ---: |
| Requested scroll event | 1180 | 1000 | 0, before its scroll handler |
| Final one-pixel adjustment | 1180 | 999 | 1000, before its scroll handler |
| Resize begins | 820 | 999 | 999 |
| New popover laid out | 820 | 999 | 999 |

The position was already 999 **before** resizing and remained 999 afterward.
The old runner assumed two animation frames completed scrolling, then waited
for the literal 1000 rather than the actual saved baseline. The constant-offset
rotation waits were introduced in `723447c`, after virtual details arrived in
`75316f7`. Increasing a timeout cannot make a correctly retained 999 become 1000.

## Runner changes and regression coverage

- Wait for loaded fonts and the browser's `scrollend` event when positioning
  the reader. These waits use the existing 15-second limit.
- Require the setup to land within one pixel of its requested offset, then
  compare every subsequent offset to that measured baseline with exact equality.
  A reset to zero or another changed position still fails.
- Start the 820 to 600 to 820 sequence at 999 explicitly. This makes a restored
  hard-coded 1000 wait fail regardless of whether Chrome adjusts another setup.
- Record actual offsets before and after resizing, and actual values for live
  output updates. Failed restoration waits print viewport and scroll geometry.
- Close every field panel and wait for its history marker to clear before
  navigating or changing presentation.

A negative control restored just the old 1000 wait against the 999 baseline.
The full replay failed at 600px with actual offset 999 in 40.940 seconds.
The preliminary runner-only fix passed in 85.003 seconds without changing product code.
The separate host handoff investigation below required a product change.

## Reproduction

Install both dependency sets, set `KANBAN_TMP` to the authorized task temporary
directory, then run:

```sh
npm ci --include=dev
npm ci --prefix .showcase --include=dev
export TMPDIR="$KANBAN_TMP"
node scripts/replay-step-details.cjs
node scripts/replay-step-detail-handoff.cjs
npm test
npm run typecheck
npm run typecheck --prefix .showcase
git diff --check
```

The replay builds the real component preview in memory. Production client and
server bundles are also checked with esbuild's `write: false`, using the external
module lists in `scripts/replay-install-failures.cjs`. There is no npm build script
or CI workflow in this checkout. The offline Chrome harness does not verify
physical native devices or the actual host's Explorer tab layout.

## Host context hydration regression

A second issue concerns the transition from the centered tablet popover to the
host's Explorer pane. Width alone does not make the host ready to open that pane.
The host's [agent action context](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/plugins/actions.ts)
requires both an agent snapshot and its matching workspace snapshot. Those
snapshots are published independently.

The handoff effect introduced in `ba27b85` depended on the selected step, viewport
presentation and agent workspace ID. If the first pane request failed while the
workspace snapshot was absent, its later publication did not change any of those
dependencies. The selected agent fields stayed equal, so their subscriptions did
not trigger another attempt. An unrelated step update could make the handoff
succeed, which explains why this race can depend on timing.

The fix subscribes to the public workspace snapshot with `useWorkspace` and adds
its ID/readiness to the handoff effect's dependencies. A workspace publication
now retries a still-open selection. It does not poll, schedule a refresh, add a
resize timer or change scroll restoration.

The browser component regression uses the actual renderer, React and native-web
Modal, a 200-line result, and a host-shaped pane that reserves space beside chat.
It first publishes the agent, opens the popover at 820px, scrolls to 400, resizes
to 1180px and observes the host's rejected request. It then publishes the workspace
as an external state event. Before the fix, all ten trials remained centered at
x=250 with width 680 and offset 400: **0/10 successful handoffs**. After the fix,
all ten trials transferred to the right pane at x=741 with width 439 and retained
400 on the return to 820px: **10/10 successful handoffs**.

| Trial | Before fix at 1180px | Fixed presentation | 820 / 1180 / 820 offsets |
| --- | --- | --- | --- |
| 1 | Popover, width 680 | Side pane | 400 / 400 / 400 |
| 2 | Popover, width 680 | Side pane | 400 / 400 / 400 |
| 3 | Popover, width 680 | Side pane | 400 / 400 / 400 |
| 4 | Popover, width 680 | Side pane | 400 / 400 / 400 |
| 5 | Popover, width 680 | Side pane | 400 / 400 / 400 |
| 6 | Popover, width 680 | Side pane | 400 / 400 / 400 |
| 7 | Popover, width 680 | Side pane | 400 / 400 / 400 |
| 8 | Popover, width 680 | Side pane | 400 / 400 / 400 |
| 9 | Popover, width 680 | Side pane | 400 / 400 / 400 |
| 10 | Popover, width 680 | Side pane | 400 / 400 / 400 |

This deterministic component regression establishes the missing subscription.
Correlation with the reported intermittent behavior still requires observation
on the designated host; component results alone do not establish that correlation.

## Final verification

Five consecutive invocations of the unwrapped command
`node scripts/replay-step-details.cjs` passed on product commit `6057b96`,
which includes upstream `fc6be4f` and runner fix `0e51b3c`. Each run used a fresh
Chrome profile. This repeats the earlier five successful runner-only runs after
adding the workspace subscription and host-shaped fixture.

| Run | Seconds | 1180 / 820 / 1180 offsets | 820 / 600 / 820 offsets |
| --- | ---: | --- | --- |
| 1 | 96.390 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 2 | 100.541 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 3 | 87.999 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 4 | 86.822 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 5 | 86.158 | 1000 / 1000 / 1000 | 999 / 999 / 999 |

All six offsets in the 1024 / 1023 / 1024 / 744 / 743 / 744 boundary
sequence were 1000 in every run. Chrome/156.0.8078.48 used debugging port
9444. Each run completed 66 measurements, including full clipboard and virtual
scrolling checks on 10,000-line results at 1440, 1024, 820 and 390px. The largest
recorded frame interval across all five runs was 33.3ms; there were no frames,
long tasks or Long Animation Frame entries over 50ms.

| Check | Result |
| --- | --- |
| `npm ci --include=dev` | Pass |
| `npm test` | 1031 passed; 0 failed, skipped or todo |
| `npm run typecheck` | Pass |
| `npm run typecheck --prefix .showcase` | Pass |
| Production esbuild bundles, in memory | Client 857375 bytes; server 1553429 bytes; 0 errors |
| Syntax checks for both detail replay scripts | Pass |
| `node scripts/replay-step-detail-handoff.cjs` | 10/10 passes; offset 400 throughout every round trip |
| `git diff --check` | Pass |
| Added lines and commit messages privacy scan | 0 matches |
