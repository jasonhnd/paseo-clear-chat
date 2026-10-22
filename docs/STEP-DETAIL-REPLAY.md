# Step detail replay and responsive host handoff

Investigated on 2026-10-22, starting at `origin/feat/v0` commit `c6946e5`.
The original constant-offset timeout is caused by replay synchronization and
expected values. The product retained its actual saved offset during that trace.
A separate compact-layout state lifetime defect was later reproduced and fixed.

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
node scripts/replay-step-detail-remount.cjs
node scripts/replay-step-detail-remount.cjs --via-host
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

The exact in-memory production build command used for verification is:

```sh
node <<'JS'
const path = require('node:path');
const { build } = require(path.join(process.cwd(), '.showcase/node_modules/esbuild'));
(async () => {
  const results = await Promise.all([
    build({ entryPoints: ['index.server.ts'], platform: 'node', bundle: true, write: false, external: ['@getpaseo/plugin', '@getpaseo/plugin/*', 'zod'] }),
    build({ entryPoints: ['index.client.tsx'], platform: 'browser', bundle: true, write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-native', '@tanstack/react-query', 'zod', '@getpaseo/plugin', '@getpaseo/plugin/*'] }),
  ]);
  console.log(JSON.stringify(results.map((result, index) => ({ target: ['server', 'client'][index], bytes: result.outputFiles[0].contents.length, errors: result.errors.length }))));
})().catch(error => { console.error(error); process.exitCode = 1; });
JS
```

## Side pane timing and workspace readiness

On the original designated host at `fc6be4f`, two sets of ten cold-page
820 / 1180 / 820 trials all reached the right pane and retained 400 / 400 / 400.
In the second set, immediately sampling after the viewport command found a
centered 680px popover in 9/10 trials. The renderer still held its previous
820px width in those samples. One immediate side pane sample still had DOM
offset 0 while its saved offset was already 400. Waiting for side presentation,
right-edge placement and the restored offset made all ten pass in
56.184–82.045ms, without any failed pane request.
This demonstrates premature sampling in these trials; it does not establish a
persistent side-pane defect in the originally reported workflow.

| Trial | Immediate presentation | Settled offset | Milliseconds to settled pane |
| --- | --- | ---: | ---: |
| 1 | popover | 400 | 76.873 |
| 2 | popover | 400 | 63.715 |
| 3 | side | 400 | 61.660 |
| 4 | popover | 400 | 82.045 |
| 5 | popover | 400 | 61.152 |
| 6 | popover | 400 | 74.278 |
| 7 | popover | 400 | 56.184 |
| 8 | popover | 400 | 58.716 |
| 9 | popover | 400 | 60.467 |
| 10 | popover | 400 | 73.833 |

A separate deterministic regression protects a real readiness gap. The host's
[agent action context](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/plugins/actions.ts)
requires both the agent and matching workspace snapshots. The handoff effect
introduced in `ba27b85` watched the agent workspace ID, but not the independently
published workspace snapshot. If a first request failed while that snapshot was
absent, its arrival did not change an effect dependency; unrelated step changes
could make a later attempt succeed. A public `useWorkspace` subscription now
retries on that explicit state publication. No timer or timeout increase is used.
The real-React component regression passed 0/10 before the fix and passed 10/10
after it, with pane x=741, width=439 and offsets 400 / 400 / 400. No late-workspace
request rejection was observed in the actual-host baseline.

## Compact layout state ownership

The designated Hermes read step reproduced a product failure on `fc6be4f` in
all ten 820 / 600 / 820 trials: the popover began at offset 0, disappeared at 600
(no dialog or body), and stayed absent on return to 820. React fiber identity
confirmed that the host replaced the timeline row while `layout.compact` changed
from false to true. The old row's unmount invoked its Back cleanup.

The open flag introduced in `ba27b85` belonged to that row. The reading state
added in `c93832f` also belonged to the row. Tests ending at `b8e1efa` changed
width without recreating the host timeline, so they did not cover this lifetime.
The new host-shaped test recreates timeline rows at 744px and removes Explorer
when compact. Direct overlay transfer passed 0/10 before repair. The component
replay of the additional 820 / 1180 / 820 / 600 / 820 hosted path also passed
0/10 before its repair.

Open sessions now belong to the host/agent/step identity. A replacement row reads
the same open flag and reading state synchronously. Replacement pane owners
retain their selected step; a compact row reclaims a hosted selection when
Explorer unmounts. Closing or actually leaving the timeline still releases the
session. Microtasks only evict records after React's commit, allowing replacement
owners to register; they do not refresh UI, poll readiness or delay restoration.
Nine component cases cover replacement rows, replacement panes, compact
Explorer removal and cleanup across web, iOS and Android shims. Both browser
remount modes passed ten consecutive trials with offset 400 throughout.

## Actual host verification

The following self-checks used production code `0a37326` with the
plugin enabled/running. Each trial started from a cold page and waited for the
requested presentation, exact scroll offset and viewport-contained bounds.
The README read is exercised from its initial offset 0; the 200-line output
additionally exercises a nonzero reading position.

| Trial | Hermes 820 / 600 / 820 | Long output 820 / 600 / 820 | Long output 820 / 1180 / 820 |
| --- | --- | --- | --- |
| 1 | Pass: 0 / 0 / 0 | Pass: 400 / 400 / 400 | Pass: 400 / 400 / 400 |
| 2 | Pass: 0 / 0 / 0 | Pass: 400 / 400 / 400 | Pass: 400 / 400 / 400 |
| 3 | Pass: 0 / 0 / 0 | Pass: 400 / 400 / 400 | Pass: 400 / 400 / 400 |
| 4 | Pass: 0 / 0 / 0 | Pass: 400 / 400 / 400 | Pass: 400 / 400 / 400 |
| 5 | Pass: 0 / 0 / 0 | Pass: 400 / 400 / 400 | Pass: 400 / 400 / 400 |
| 6 | Pass: 0 / 0 / 0 | Pass: 400 / 400 / 400 | Pass: 400 / 400 / 400 |
| 7 | Pass: 0 / 0 / 0 | Pass: 400 / 400 / 400 | Pass: 400 / 400 / 400 |
| 8 | Pass: 0 / 0 / 0 | Pass: 400 / 400 / 400 | Pass: 400 / 400 / 400 |
| 9 | Pass: 0 / 0 / 0 | Pass: 400 / 400 / 400 | Pass: 400 / 400 / 400 |
| 10 | Pass: 0 / 0 / 0 | Pass: 400 / 400 / 400 | Pass: 400 / 400 / 400 |

The 600px sheet was fully visible at y=422, height=422, bottom=844. The 1180px
host pane was at x=860, width=320, right=1180. The connected
820 / 1180 / 820 / 600 / 820 sequence also passed with offset 400 at every
checkpoint and nonempty bodies. These are implementation self-checks; the
board's independent review and acceptance remain separate.

## Final verification

Five consecutive raw invocations of `node scripts/replay-step-details.cjs`
passed on production code `0a37326`, including the current read-gutter
and sender-title integrations. Each used a fresh Chrome profile.

| Run | Seconds | 1180 / 820 / 1180 offsets | 820 / 600 / 820 offsets |
| --- | ---: | --- | --- |
| 1 | 84.831 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 2 | 85.390 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 3 | 84.954 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 4 | 87.799 | 1000 / 1000 / 1000 | 999 / 999 / 999 |
| 5 | 87.040 | 1000 / 1000 / 1000 | 999 / 999 / 999 |

All 330 measurements passed, including bounded virtual rendering and full copy
of 10,000-line results at 1440, 1024, 820 and 390px. All six additional offsets
in the 1024 / 1023 / 1024 / 744 / 743 / 744 sequence were 1000. The largest
frame interval was 33.4ms, with no frame, long task or Long Animation Frame
over 50ms. Chrome/156.0.8078.48 used debugging ports within 9444–9499.

| Check | Result |
| --- | --- |
| `npm ci --include=dev` | Pass |
| `npm test` | 1097 passed; 0 failed, skipped or todo |
| Root and showcase typechecks | Pass |
| Production builds in memory | Client 863156 bytes; server 1553429 bytes; 0 errors |
| Workspace hydration browser regression | 10/10; 400 / 400 / 400 |
| Direct remount browser regression | 10/10; 400 / 400 / 400 |
| Hosted remount browser regression | 10/10; all offsets 400 |
| Three detail replay syntax checks | Pass |
| `git diff --check` | Pass |
| Added lines and task commit messages privacy scan | 0 matches |

No npm build script or CI workflow is present; both production bundles were
built locally with esbuild. Physical native devices were not exercised.

## Hosted browser environment comparison

The hosted acceptance browser must keep its viewport override alive. Use one
CDP session for setting device metrics, opening the conversation, mouse and key
input, every resize, and every layout measurement. Set the initial viewport
**before** opening the conversation. Disconnecting the session that owns
`Emulation.setDeviceMetricsOverride` removes that override; a later session's
measurements do not establish which width the plugin rendered between sessions.
Record `innerWidth`, `innerHeight`, `data-presentation`, panel bounds and
`step-detail-scroll.scrollTop` together in the same evaluation. Do not infer
side presentation from the browser's requested width alone.

### Connection and entry procedure

1. Start an empty temporary Chrome profile with a free debugging port in
   9444–9499, `--host-resolver-rules="MAP localhost ~NOTFOUND"` and
   `--disable-features=LocalNetworkAccessChecks`. Do not reuse a registered
   browser profile. Enable CDP Network monitoring before application navigation.
2. Block both localhost and the loopback IP on port 6767 with
   `Network.setBlockedURLs`. The welcome page can automatically attempt its
   default host. Enable Page before installing a pre-document WebSocket guard
   that rejects port 6767; retain DNS blocking as well. Log attempted URLs,
   handshake responses and errors separately. An attempted WebSocket event is
   not evidence of a successful connection and must not be reported as zero
   attempts.
3. Open the application home page. Use **Direct connection**, enter the loopback
   IP and test port explicitly, and wait for **History**. Keep this connection
   alive. Use SPA navigation: **History**, then the conversation title. Verify
   that the resulting route is a workspace route and the conversation has a
   matching workspace. Expand Explorer when checking the workspace manually;
   never click file paths or file-manager actions during this replay.
4. Avoid address-bar navigation or full reload of an agent deep link. In this
   investigation, the saved registry retained the explicit IP endpoint, but a
   hard navigation attempted a localhost WebSocket at the test port and left
   the agent loading under DNS blocking. This is a hosted application connection
   limitation, outside the plugin. For cache-cold checks, clear browser caches
   while retaining the active SPA connection, then enter through History.
5. At 820px, click the collapsed long-output shell step using actual CDP mouse
   input. Wait for the popover and set its detail scroller to 400. At 1180px,
   wait for side presentation, nonempty content and restored scroll position;
   measure panel geometry. Close details, return to 820px and repeat ten times.
6. Reset Clear Chat settings with **Reset defaults** after the checks. Close the
   task browser and remove its temporary profile and captured conversation data.

A side panel requires desktop width (at least 1024px), a matching host workspace
snapshot, and a working Explorer panel API. Without a workspace or available
host panel, the plugin deliberately retains a popover; width alone cannot
create a workspace. At 744–1023px a popover is expected, and below 744px a sheet
is expected. Profile-local workspace layout can change Explorer visibility;
it is not a substitute for checking the actual selected workspace.

### Earlier-version control

On `c6946e5`, the procedure above passed ten of ten 820→1180 trials. Every
trial measured popover x=70, width=680 at 820px, then side x=860, width=320 at
1180px. All twenty reading offsets were exactly 400. The viewport height was
900px throughout; navigation was through History into the same workspace.

The same single-session desktop control at 1440×900 also produced:

- A shell-row context click at (746,214), menu origin (750,218): (+4,+4).
- A click near the right edge at (1261,244), menu origin (977,248): the menu
  intentionally flips left to keep its 280px width inside the viewport. A large
  negative horizontal delta at an edge is not itself a positioning failure.
- An opaque read preview after hovering the read row: tooltip x=479, y=113,
  width=420, height=112, background `rgb(255, 255, 255)`.
- ArrowDown moved focus from the shell row to the following read row; Enter
  opened its details and Escape closed them. Test navigation from a row with a
  following sibling; the last row does not wrap to the first.

The transparent host **Drop files here** layer is not the plugin preview.
Locate the visible tooltip associated with the hovered row and check its
nonzero bounds, opacity and background instead of selecting an arbitrary host
overlay. None of these earlier-version controls requires a plugin code change.
