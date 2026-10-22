# Step detail replay: scroll completion and measured baselines

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
The preliminary fixed run passed in 85.003 seconds. Product code is unchanged.

## Reproduction

Install both dependency sets, set `KANBAN_TMP` to the authorized task temporary
directory, then run:

```sh
npm ci --include=dev
npm ci --prefix .showcase --include=dev
export TMPDIR="$KANBAN_TMP"
node scripts/replay-step-details.cjs
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

## Final verification

Five consecutive invocations of the unwrapped command
`node scripts/replay-step-details.cjs` passed on runner commit `9476fc3`.
Each run used a fresh Chrome profile. The final rebase onto `27fa30b` changed
only upstream release documentation and replayed this fix as `33f9a7e`; the
runner source blob is identical before and after rebase.

| Run | Seconds | 1180 / 820 / 1180 offsets | 820 / 600 / 820 offsets |
| --- | ---: | --- | --- |
| 1 | 87.956 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 2 | 92.965 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 3 | 91.526 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 4 | 84.391 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 5 | 85.161 | 1000 / 1000 / 1000 | 999 / 999 / 999 |

All six offsets in the 1024 / 1023 / 1024 / 744 / 743 / 744 boundary
sequence were 1000 in every run. Chrome/156.0.8078.48 used debugging port
9444. Each run completed 66 measurements, including full clipboard and virtual
scrolling checks on 10,000-line results at 1440, 1024, 820 and 390px. The largest
recorded frame interval across all five runs was 33.3ms; there were no frames,
long tasks or Long Animation Frame entries over 50ms.

| Check | Result |
| --- | --- |
| `npm ci --include=dev` | Pass |
| `npm test` | 1022 passed; 0 failed, skipped or todo |
| `npm run typecheck` | Pass |
| `npm run typecheck --prefix .showcase` | Pass |
| Production esbuild bundles, in memory | Client 853579 bytes; server 1553429 bytes; 0 errors |
| `node --check scripts/replay-step-details.cjs` | Pass |
| `git diff --check` | Pass |
| Added lines and commit messages privacy scan | 0 matches |
