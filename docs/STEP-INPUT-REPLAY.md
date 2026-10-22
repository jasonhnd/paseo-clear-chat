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

## Read line numbers, virtual scrolling and clipboard controls

First inspect the read-only projected timeline response, using the same projection
as the host. A tool's `total lines` header describes the source file, not the
amount of content delivered to the plugin. Preserve provider truncation notices
in fixtures and reports. Do not rebuild missing lines from an assistant reply,
read the current file as a substitute, or count a file header as proof that all
file lines reached the renderer.

The captured Hermes read results used for the offset replay were already
truncated upstream. Both projected and canonical responses contained the same
partial strings: the read starting at 150 ended partway through source line 244,
and the whole-file read ended partway through source line 102. Their notices
reported 5742 and 58946 original characters, respectively. Neither response
included the closing fence. Thus these historical results cannot demonstrate
source lines 260 or 1200. This is a missing provider/host payload, independently
of virtual scrolling. The parser removes a recognized numbered wrapper while
retaining the explicit truncation notice, without assigning that notice a file
line number. Copy output contains only the available file content; the detail
list keeps the notice visible so partial content is not mistaken for a complete
file.

For a complete response, check the first and last source numbers against the
actual payload. A constructed complete 1200-line variant of the captured item
shape checks every list row and the complete Copy output string in the component
suite. This control does not replace hosted verification of a complete payload.

The detail body owns its scrolling in `[data-testid="step-detail-scroll"]`.
Send real wheel events over its measured bounds, not over the chat or page.
After each wheel event, allow the virtual list to mount and measure its next
batch. Repeat until `scrollTop + clientHeight` reaches `scrollHeight` and those
values remain stable across another wheel event. Then inspect the last mounted
`step-detail-line-number` and adjacent `step-detail-output`. Initial mounted
rows, or a single large wheel event before content height settles, do not prove
that the list ends there. Copy output uses the full available payload regardless
of which rows are mounted.

For clipboard checks in headless Chrome, grant `clipboardReadWrite` and
`clipboardSanitizedWrite` with `Browser.grantPermissions` for the application
origin. Keep the same attached CDP session. Seed a sentinel, select actual text
with mouse input, and verify `window.getSelection().toString()` before copying.
A nonempty selection and an unchanged clipboard alone do not establish a
product defect. In the macOS headless control, Meta+C key events with the proper
key codes still left the sentinel unchanged. The same selected text copied when
the key-down event included Chromium's editing command:

```js
await cdp.send("Input.dispatchKeyEvent", {
  type: "keyDown", key: "c", code: "KeyC", modifiers: 4,
  windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 8, commands: ["copy"],
});
await cdp.send("Input.dispatchKeyEvent", {
  type: "keyUp", key: "c", code: "KeyC", modifiers: 4,
  windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 8,
});
```

Read the real clipboard after the event and compare it with the selected file
text. Check that the nonselectable gutter is absent. Test the Copy output button
separately: it must include all available file lines, with no upstream truncation
notice, Read header, outer fences or provider numeric prefixes.
