# Replaying step menu, hover and keyboard inputs

Use the same browser environment before comparing revisions. The menu uses
viewport coordinates and flips at viewport edges. Keyboard navigation follows
mounted steps in the current conversation, without wrapping at either end.
Hover previews belong to collapsed steps on a desktop with a fine mouse pointer.

## Local host-shaped replay

Install both dependency sets and set `KANBAN_TMP` and `TMPDIR` to the authorized
untracked task directory, then run:

```sh
npm ci --include=dev
npm ci --prefix .showcase --include=dev
node scripts/replay-step-details.cjs --inputs-only
```

The replay uses the production renderer, a 64px host header, a scrolled chat
container and sanitized real tool shapes. One CDP session sets a 1440 by 900
viewport before navigation and dispatches real mouse and keyboard input.
Five trials check the menu at (720, 420), an opaque hover preview that disappears
on leave, ArrowDown and ArrowUp, Enter and Escape. Reports stay in the temporary
directory. The ordinary full replay remains available without this option.

## Hosted browser procedure

1. Start installed headless Chrome with a new empty temporary profile, a free
   debugging port in 9444 through 9499, `--host-resolver-rules="MAP localhost ~NOTFOUND"`
   and `--disable-features=LocalNetworkAccessChecks`.
2. Keep one CDP session attached for metrics, navigation, input and measurement.
   Enable the Page and Network domains before navigation. Block HTTP and
   WebSocket URLs for localhost and 127.0.0.1 on port 6767. Record
   `Network.requestWillBeSent`, `Network.webSocketCreated` and handshake/error
   events; URL blocking alone does not suppress WebSocket creation events.
3. In the test tool, install a pre-document WebSocket constructor guard for
   those two addresses on port 6767. Preserve every other address and protocol.
   The welcome screen otherwise automatically attempts default-host discovery.
   Retain DNS blocking and the network audit as independent protections.
4. Set desktop device metrics and disable touch emulation before opening the
   conversation. Check `innerWidth`, `innerHeight` and the actual row bounds
   immediately before each measurement. A requested screenshot size does not
   establish the runtime viewport. After a resize, also wait for the plugin's
   expected presentation and bounds: an immediate `innerWidth` read can already
   show the new width while React still renders the previous breakpoint.
5. Open the application welcome page, manually register only the test daemon
   by IP and port, then use History to enter the conversation through the SPA.
   Avoid hard navigation to an agent URL: the host can reconstruct a localhost
   transport despite the registered IP endpoint. Do not relax DNS blocking.
6. Right-click a visible summary row with enough room to its right and below.
   Inspect `[data-testid="tool-step-menu"]`; its top-left should be 4px from
   the pointer in each direction. Near an edge, compare the corresponding
   flipped edge instead. Never activate a file link or file-manager action.
7. Move the mouse outside the row, then onto its summary. After the 300ms delay,
   inspect `[data-testid="tool-hover-preview"]` directly: it must be present,
   opaque and have a nontransparent background. Move outside and require its
   removal. An unrelated transparent drag-and-drop layer is not the preview;
   inspect its pointer-events and the actual hit target before blaming it.
8. Start from a step with a following step. Close any opened detail with Escape,
   verify focus returns to that row, then send ArrowDown and ArrowUp. Check DOM
   element identity and same-conversation step order, rather than title text
   alone. Enter opens details and Escape closes them. ArrowDown on the final
   step and ArrowUp on the first step intentionally leave focus unchanged.
9. Repeat each input check five times. Reset Clear Chat settings to defaults,
   close Chrome and remove its temporary profile after recording aggregates.

## Viewport-owner negative control

A controlled React Native Web probe measured the following:

| State | Browser width | React Native width |
| --- | ---: | ---: |
| Original context | 820 | 820 |
| Attached CDP metrics override | 1440 | 1440 |
| Metrics session detached | 820 | 820 |

Separate short-lived `size`, `click` and `eval` sessions therefore do not provide
a stable viewport. The input replay also failed deliberately with an 820px
metrics override while expecting 1440px; the normal five-trial replay passed.
Do not mark a revision bad for bisect until its measured environment matches
the known-good endpoint. A passing current endpoint supplies no bad bracket.

## Historical comparison and results

The old `c6946e5` hosted control and current `046d86e` hosted control both
passed with persistent metrics and SPA entry. The independent current-version
input check repeated each item five times:

| Check | Actual host result |
| --- | --- |
| Menu, desktop width 1440 | 5/5; pointer-to-menu offset (+4, +4) |
| ArrowDown, shell to read | 5/5; DOM focus index 0 to 1 |
| ArrowUp, read to shell | 5/5; DOM focus index 1 to 0 |
| Enter and Escape | 5/5; detail opens and closes |
| Read hover, sampled after 330ms | 5/5; opacity 1, white background, five lines |
| Pointer leaves read row | 5/5; preview removed |
| ArrowDown from final read row | 5/5; focus stays on index 1 as intended |

The real short conversation has exactly two steps. The earlier successful
keyboard check started at the shell step; the reported failure started at the
last read step. Those are different navigation tests. No keyboard regression
was reproduced. The menu and keyboard sources are byte-identical between
`fc6be4f` and `046d86e`.

The independent hosted menu checks clicked the visible row at y=214 (x=746
initially and x=595 after Explorer opened). The local host-shaped replay checks
the exact fixed point (720, 420) five times at 1440px, yielding (+4, +4).
Changing only that replay's metrics to 820px reproduces the reported menu
rectangle exactly: x=436, y=424, width=280. That is the intended horizontal
edge flip, not a newly introduced coordinate subtraction. Both controls use
the same current product code.

The unrelated drop-files surface has an ancestor with opacity 0 and
pointer-events none. It does not intercept mouse hover. The actual preview's
stable test ID exposes the opaque surface and its removal directly; a broad
preview/tooltip probe that returns the drop surface does not establish failure.

There is no reproducible bad product endpoint for a `fc6be4f..046d86e` bisect.
Accordingly no first-bad product commit is assigned. The environment and
starting-row controls explain the observations without a plugin change.
The earlier historical/current hosted responsive comparison also passed ten
trials per endpoint; split-session immediate reads reproduced the stale popover
ten times. See [the detail replay notes](STEP-DETAIL-REPLAY.md) for that comparison.

The final guarded profile recorded zero forbidden-port HTTP or WebSocket
creation events and only the explicitly registered daemon WebSocket. Two
preliminary welcome-only profiles each recorded one default-discovery
WebSocket creation event before the constructor guard was effective; DNS
blocking prevented connections. These attempts are not reported as zero.
Clear Chat's Reset defaults was activated after the independent checks, and
Chrome and its temporary profile were removed. The installed plugin remained
on `046d86e`.

Verification: 1097 unit/component tests passed, root and showcase typechecks
passed, the full existing browser replay passed, and both production bundles
built in memory without errors. The added input mode passed five trials; its
wrong-viewport and edge-flip negative controls failed the intended assertions.
No README, changelog, plugin runtime code or dependency lock was changed.
