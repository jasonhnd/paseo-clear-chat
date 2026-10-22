# Developing Clear Chat

[Back to README](../README.md)

Technical notes for contributors. For installing and using Clear Chat, see the [README](../README.md).

## Tool row behaviour

Finished calls open as compact, single-line rows: tool icon, command or file/query summary,
status, and duration when the provider reports one. Running calls spin; failed calls show a
cross, completed calls a check, and canceled calls a separate label. Running, failed and
waiting-for-user calls default to expanded. Press a collapsed row to open step details;
expanded rows still collapse in place. **When a collapsed step is pressed → Expand inline**
restores the original expand/collapse behavior, including saved per-call choices.
At widths of 744px and above, collapsed rows occupy 26px including their borders and vertical spacing.

On web at widths of at least 1024px, a mouse hovering over a collapsed row for
300ms shows its summary, file path when present and the first six output lines.
Projected read results omit their repeated path header and code fences so file
lines receive the same preview budget. Longer results end with an ellipsis.
The preview uses the opaque host surface with a border and shadow in both themes,
including when frosted glass is enabled. Touch and pen input
never trigger this preview, even on a device with an attached mouse. The
preview sits above the row when possible; near the top edge it moves to the
side of the pointer so the next row remains visible beneath it. It accepts no
pointer input. Leaving the row, scrolling, pressing, resizing, switching input
capabilities or leaving the window cancels pending and visible previews.
Opening or replacing a step also removes its preview. Hovering does not change
the saved expansion choice or the row's click and long-press gestures.

After installing the offline harness dependencies below, run
`node .showcase/hover-preview.cjs` with `KANBAN_TMP` set to the task directory.
It checks both themes with glass on and off at 1440, 1024, 820 and 390px,
measures opacity and text contrast, replays the captured read envelope and
checks mouse, touch and step-menu interactions. Its JSON report and desktop
screenshots stay in that directory; inspect the screenshots and delete them.
Touch emulation and native component replays still need device verification.

On web, adjacent collapsed tool rows have a 30px center pitch with the host's
16px timeline gap: `26 + 16 - 12 = 30`. The plugin reads the preceding host
frame's actual gap and applies up to 12px of negative top margin to its own
root, leaving at least 4px of that gap. Expanded tools, replies, messages,
footers and auxiliary content end a compact sequence. Smaller gaps receive
less compensation, so rows never overlap. Host styles are not modified.

Below 744px, the same component uses 11px summary text (never smaller than 11px
at a reduced text setting), smaller icons and horizontal padding, and a 24px
visual footprint. A transparent, centered 28px button extends past the 20px
header slot into the existing gap; the collapsed card allows this overflow.
The button is a real layout box, rather than a clipped `hitSlop` region. With
the existing web gap compensation its center pitch is 28px; the compensation
algorithm and host margins are unchanged. Expanded phone cards use an ordinary
28px header. Native apps retain their host's original inter-item spacing.

Explicit choices, including a manual collapse of an active call, survive reloads and history
navigation. They are saved on the selected host, independently for each host, agent and call;
the timeline timestamp distinguishes reused call IDs. The most recent 1,000 choices are retained.
Writes are merged and debounced, with revision conflicts retried. A storage error appears below
the affected row; toggling it again retries the save.

Long tool output, fenced reply code and enhanced prompts preview the first 15 source lines by
default. **Show all N lines** reveals the complete text. Prompt, code and reply Copy controls
always copy their full source. Prompt and reply-code choices use the same host expansion store,
with separate keys for each message, code block and wrap-up section. Ordinary reply prose
stays fully expanded. See [message folding](MESSAGE-FOLDING.md) for replay commands and limits.
Explicit `wrap_up` calls, including a `ccd_turn` operation marked
`wrap_up`, also render their reply text outside tool and output disclosures. A completed
transform phase alone never identifies a final reply.
Structured wrap-up replies have a **Wrap up** card header. They render `recap` as Markdown,
`ask` as a question, and `actions` as lettered options with each `label` and `message`.
Boolean `blocked: true` displays a prominent **Blocked** alert; false adds no section.
Legacy string options, option descriptions, blocked reasons and JSON string envelopes
remain supported. A recap can stand on its own. Unrecognized or invalid structured
replies remain fully visible as plain text inside the same expanded card.

## Step actions

Touch and hold a tool summary for 500 ms, or right-click it on web, to open
**Step actions**. The scrollable menu opens 4px from the gesture, flipping left
or up when it would reach a viewport edge and keeping an 8px screen margin.
Its Modal escapes the timeline's clipping and transformed ancestors. Web mouse
coordinates use the viewport directly; web touch page coordinates subtract only
document scroll, while native gestures use root coordinates. Toolbar and chat
scroll offsets are not added. Menu bounds are measured after layout so wrapped
actions and font scaling remain inside the screen. Events without coordinates
retain a centered fallback. Escape, Android Back or the backdrop closes it.
Releasing a long press does not activate the row or dismiss the new menu through
a synthetic browser click.

**Copy command**, **Copy path** and **Copy result** use the SDK clipboard on the
current client. Commands and paths retain their original whitespace. Results
come from the complete step payload, independently of output folding or typed
previews: strings stay verbatim, pure text-block results include every block,
and other structured results use full formatted JSON. Empty string results can
also be copied. Steps with no reported result omit **Copy result**; Write file
contents and Edit patch inputs never stand in for a result. Clipboard failure
opens the existing read-only text fallback. Steps without a file path have
neither path action.

**Open in file manager** uses the existing daemon-side file reveal action. It is
available only to web/desktop clients at least 1024px wide with a reveal callback.
Phone and tablet-width web clients, iOS, iPadOS and Android omit it and retain
**Copy path**. Summary text is a nonselectable control so native text selection
does not compete with the long press; expanded detail text keeps its selection.

Run `node --test test/tool-step-menu.test.cjs` for web, iOS, iPadOS-width and
Android component replays using the sanitized real tool fixtures. For measured
DOM bounds, clipboard arguments, actual touch long-press timing and ordinary clicks
at 1440, 1024, 820 and 390px, install the offline harness dependencies with
`npm ci --prefix .showcase --include=dev`, then run:

```sh
TMPDIR="$KANBAN_TMP" node .showcase/verify-step-menu.cjs
```

The verifier includes a 96px host toolbar, a transformed host ancestor, a chat
container scrolled by 600px and a document scrolled by 37px. It measures both
right-click and touch positions within 8px, then moves the row near the bottom
right corner to check flipping and screen bounds at every width. The sanitized
`test/fixtures/real-hermes-step-menu.json` contains the shell and read item
structures from a read-only projected capture; keys, nesting and value types
match the source, while content, paths and identifiers are fictional.

The verifier bundles the real components in memory and uses headless Google
Chrome with a free debugging port in 9444–9499. Its profile and JSON report stay
in the task's temporary directory; the profile is removed on exit. SDK services
are supplied by the harness. This is a component preview, and iOS, iPadOS and
Android still need a final device check.

## Step details

The shared breakpoints in `client/breakpoints.ts` select one presentation from the
window width: below 744px is a bottom sheet, 744–1023px is a centered popover, and
1024px and above is a side panel. All three render the existing `ToolCalloutBody`
from `client/components/tool-callouts.tsx`; file links, output disclosures and
error text use the same implementations as expanded cards.

`client/components/step-detail-panel.tsx` exports the controlled `StepDetailPanel`:

| Prop | Purpose |
| --- | --- |
| `step: ToolCalloutData \| null` | Selected step; null renders nothing. |
| `open: boolean` | Whether its details are visible. |
| `onOpenChange(open)` | Dismiss callback for buttons, backdrop, Back and gestures. |
| `presentation: "sheet" \| "popover" \| "side"` | Current window-width presentation. |
| `tokens`, `onRevealPath?`, `imageFile?` | Existing card theme, file action and image state. |
| `viewState?: StepDetailState` | Transient reading state shared when moving the selected step between the row and host pane. |

Opening details does not change or persist the timeline's folding choice.
The optional `collapsedStepAction` preference accepts `details` (the default) or
`inline`; presentation settings remain at version 2. Version 1.0.1's non-strict
Zod object can read the additional preference without an error, but an older
client saving settings can strip it. It is never imported from browser legacy settings.

### Step keyboard controls

On web and desktop, Tab to a step. Up and Down focus the previous or next mounted,
visible step in the same host and conversation, scrolling it into view. Navigation
stops at the first and last mounted rows; it does not load virtualized history.
The accent outline appears for keyboard focus and clears for pointer or touch
activation. Enter opens the shared details, including for an expanded row, without
changing its saved folding choice. With inline expansion selected, Enter follows
that preference instead. Holding Enter does not repeatedly activate the row.

These keys are handled on the focused row in capture, before the web Pressable's
own activation. Events from child editors, an unfocused row, composition, or
modifier shortcuts are ignored. No document-wide Up, Down or Enter listener is
installed. Escape dismisses the top open detail and restores the opening control's
focus; this also covers the desktop host panel. Panels expose a labeled dialog
or region, and step rows retain their button role and descriptive label.

The browser implementation also applies to an iPad browser with a hardware
keyboard. Native rows remain focusable buttons with a focus border and the
existing accessibility Escape action. React Native 0.81 View exposes focus/blur
but no raw hardware-key event, and the plugin SDK 0.12 has no keyboard-command
bridge. Consequently, custom Up/Down/Enter/Escape dispatch is **web only**; the
native iPad app still needs a host keyboard bridge for the same guaranteed
shortcuts. Native component replay verifies focusability, activation and
accessibility dismissal, not native hardware-key delivery. Physical iOS,
iPadOS and Android keyboard checks remain pending.

### SDK integration and limits

The initial SDK 0.8.0 check found `addWorkspacePanel`, `openPanel` and a controlled
`Modal`. These contracts remain available after the separate [SDK 0.12.0 upgrade](SDK-0.12.md).
The [0.8.0 SDK contracts](https://github.com/getpaseo/paseo/blob/v0.8.0/packages/plugin/src/client/contracts.ts)
allow an agent panel in the host's `explorer` location. `step-detail-host.tsx`
registers that panel and keeps the selection scoped to host and agent; opening it
reserves host-managed space beside chat instead of positioning a layer over chat.
The selection keeps updating while its timeline row is mounted and remains an
in-memory snapshot if that row is virtualized away.
The host keys `StepDetailPanel` by the selected step's stable identity. Switching
steps remounts its body and starts at the top; new output for the same step keeps
the reader's scroll position. Other hosts that change the selection should use
the same key pattern.
The selected row also supplies a stable `StepDetailState` from
`step-detail-state.ts`. It carries vertical scroll, the sheet's half/full size,
output disclosures and image visibility across presentation-root changes.
Scroll offsets restore after the new scroll viewport and content are laid out;
incoming output for the current step keeps the current offset. Explicitly
selecting another step resets its reading state. These values stay in memory
and never change persisted timeline folding choices. Safe-area measurements
are associated with their window dimensions so rotation cannot reuse a stale
height cap, and a resize cancels any unfinished sheet drag.

The SDK's Modal does not expose presentation breakpoints or snap points. Its
[host implementation](https://github.com/getpaseo/paseo/blob/v0.8.0/packages/app/src/components/adaptive-modal-sheet.tsx)
defaults to 65% and 90%, so the plugin uses **React Native Modal** for its sheet
and popover. The phone sheet starts at half height; dragging its handle snaps to
half or full available height, or dismisses below the lower threshold. Its body
scrolls independently. The handle also supports accessibility adjustments and a
resize button. Modal `onRequestClose` handles Android Back; a downwards handle
drag, a rightwards swipe from the left edge, the backdrop and Close dismiss it.
On web, an extra same-URL history entry makes browser Back dismiss details first.
Safe-area padding bounds the native sheet, and dedicated gesture regions disable
browser touch scrolling so it cannot cancel a drag.

Neither SDK 0.8.0 nor 0.12.0 has a **close-panel API**. Close clears the selected step; the empty
pane explains how to close its host tab to give the space back to chat. Host tab
close also clears the selection. If the workspace is not cached, panel APIs are
unavailable, or opening a panel throws, desktop details fall back to a popover:
that fallback covers part of chat until dismissed. The plugin never edits the
host layout or DOM to manufacture a side panel.

### Replay checks

`test/step-detail-panel.test.cjs` uses the sanitized real Claude fixture through
the registered transformer, schema and live renderer on web, iOS and Android at
1440, 1024, 820 and 390px. It checks opening/closing, half/full/dismiss gestures,
platform Back, left-edge Back, inline fallback and responsive transitions. Native
primitives are stubbed; real-device iPhone, iPad and Android checks remain pending.

For layout measurements and actual browser touch gestures, install the isolated
showcase dependencies and run the offline preview:

```sh
npm ci --include=dev --prefix .showcase
npm run typecheck --prefix .showcase
node scripts/replay-step-details.cjs
```

Set `KANBAN_TMP` to the current task's authorized temporary directory. The runner
builds the preview in memory and uses the installed headless Google Chrome with
a free debugging port from 9444–9499. It blocks external requests, measures all
four required widths plus 1180px with a 64px host header and a chat container already scrolled by
360px, verifies focused Up/Down/Enter/Escape, input/textarea/contenteditable key
pass-through and phone touch focus styling, verifies that the desktop pane does not overlap chat in the host
layout shim, checks A-to-B-to-A switching between long steps at both desktop
widths, preserves scroll during same-step output updates, checks touch drag,
dismissal, browser Back and inline mode, and
writes screenshots and `step-detail-report.json` under that temporary directory.
The host shim includes a fixed 64px header, a separately scrolled chat
container and 16px history-frame gaps with the real compact-spacing installer.
Its Explorer slot follows the desktop breakpoint while its panel
component stays mounted, as a host would keep a selected tab. Continuous
1180 → 820 → 1180 and 820 → 600 → 820 sequences, plus exact 743/744 and
1023/1024 boundary crossings, require exactly one selected detail, retained
scroll position, the correct presentation and no obsolete backdrop. Expanded
output, hidden images and the full-height sheet also survive continuous resizing.
Long code-header wrapping may shift the first visible source line slightly;
the replay requires the same reading region within three lines. Separate
long-path reads, wide images and long code lines check row bounds, control
hit targets and horizontal containment. File-reveal controls are measured
without invoking the host file manager. This simulated Explorer layout does
not replace checks of the actual host's tab layout or native devices.
It never contacts a running Paseo host. Actual Explorer placement and OS gesture
delivery still need host and device verification.

## Image previews

A read of a `.png` carries no bytes through the timeline, so the host draws it as an empty code
block with a language badge. The image card draws the file instead: a picture mark, the path as a
link, the pixel size and file size read from the header, and an eye control that hides the
thumbnail. The bytes come from the plugin's own daemon-side RPC (`file.image`), which is the only
side that can reach the file; PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG are recognised. Local
preview cards appear after a successful read; missing files, read failures and files past 3 MB
produce no card.

Generated images also appear below tool outputs and assistant replies, including image content
blocks, Markdown images, local file paths and remote image URLs. Each preview has a clickable
source address: local files open in the daemon machine's file manager, remote URLs open in the
browser, and embedded images open in an image viewer. Local paths resolve against the agent's
working directory and support filenames with spaces.

- **Images written in a reply** (Markdown images and paths given in the reply text): if one cannot
  be shown, the reply shows the reason and the original address instead of an empty frame.
- **Images in tool output**: a tool row shows an image only when the tool read or wrote that image
  file itself, or reported that it generated one. Image paths that merely appear inside text a tool
  read (for example a README that mentions `images/hero.png`) do not create previews, nor do
  directory listings or ambiguous filename fragments. A failed preview is hidden, including its
  card and source link.

Filesystem and RPC error details are never displayed by image previews. The host must include the
image block or address in the timeline payload for the plugin to show it.

## Opening files

A file name in a read, write, edit, or code block is a link. Pressing it calls the plugin's own
daemon-side RPC (`file.reveal`), which resolves the path against the agent's working directory and
asks the platform shell to show it:

| Platform | Behaviour                                              |
| -------- | ------------------------------------------------------ |
| Windows  | `explorer.exe /select,<file>` selects the file.        |
| macOS    | `open -R <file>` selects the file in Finder.           |
| Other    | `xdg-open <directory>` opens the containing directory. |

A directory path opens that directory. Reply links show a clear error if the path is missing,
inaccessible, or the file manager cannot start; filesystem diagnostics stay private. Relative
paths require the session's working directory and never fall back to the daemon's directory.

Assistant replies recognize absolute paths, home paths, `./` and `../` paths, and relative paths
with a directory and file extension. Bare filenames are linked only in inline code or explicit
Markdown links. Quote paths containing spaces, use inline code, or write
`[Report](<./reports/monthly report.pdf>)` to make the complete target explicit. Rooted paths
with spaces ending in an extension are also recognized in prose. Line selectors such as `:55:3`
are stripped before opening. Ordinary slash phrases such as `and/or` remain text; fenced code
is never linked.

On desktop web (at least 1024px wide), pressing a reply path reveals it on the **host computer**.
On iOS, iPadOS, Android, and narrower web windows, it copies the written path instead and shows
**Path copied. Open it on the host computer.** Native apps cannot open files stored on a remote
host. If clipboard access fails, the existing manual-copy dialog retains the complete path.

## Reply highlights

`==marked text==` draws a theme-tinted highlight in every Markdown variant, including headings,
lists, quotes, and table cells. Both delimiters must touch content. Inline code, fenced code,
escaped equals signs, equality operators, and unfinished marks remain literal. This uses the
existing Assistant markdown setting; it adds no settings fields or version migration.

## Unmapped output

A tool the plugin has no typed adapter for uses the parameter table described
above. Structured output and multiple text blocks are preserved in its preview.
When input and output are empty, the tool name and status remain visible and the
expanded body reports that no output was returned. Failed calls keep their error
visible, and canceled calls retain their canceled status.

All thirteen tool categories have automated component coverage: shell, read, edit,
write, search, fetch, web search, tool discovery, subagent, plan, todo, plain text
and unknown. The [replay fixtures](../test/fixtures/README.md) document sanitized
real timelines and additional synthetic Hermes, Claude and Codex samples. Each
real timeline must have zero empty cards and at most five percent generic calls;
plain-text and unknown cards both count toward that budget. Replays also exercise
assistant replies and explicit wrap-up replies through the real Markdown renderer.

A file link cannot open Paseo's own file editor: see the first limitation below.

## Opening reply links

Markdown links, bare HTTP(S)/`www.` URLs and `mailto:` URLs use the same inline
`Text` press handler. Mail links retain their encoded subject, body and recipient
parameters. Code spans and fenced code remain literal. Selection and long-press
behaviour follow the existing platform rules.

| Client | Opener and arguments |
| --- | --- |
| Browser | `globalThis.open(url, "_blank", "noopener,noreferrer")`, directly during the press |
| Electron | `paseoDesktop.opener.openUrl(url)`, with the browser fallback if the bridge fails |
| iOS and iPadOS | `Linking.openURL(url)` from the host-injected `react-native` module |
| Android | The same `Linking.openURL(url)`, with one URL argument |

The [Paseo 0.12 runtime](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/plugins/evaluate.ts)
injects React Native into plugins. The pinned 0.8 SDK has no external URL helper;
newer hosts expose `openExternalUrl`, but their
[helper accepts only HTTP(S)](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/utils/open-external-url.ts),
so it cannot replace this reply opener's mail support. Android needs no separate
SDK or `sendIntent` call. We call `openURL` directly and handle rejection:
[React Native's Linking reference](https://reactnative.dev/docs/0.81/linking)
documents HTTP(S) and mail on both platforms, and notes that a `canOpenURL`
preflight on Android 11+ can reject without host manifest intent queries.

Run the registered-transformer replay and the offline browser geometry check:

```sh
node --test test/reply-links.test.cjs
npm ci --include=dev --prefix .showcase
KANBAN_TMP="$TMPDIR" npm run test:reply-links --prefix .showcase
```

Set `TMPDIR` to the authorized task directory first. The browser check uses
installed headless Google Chrome, a free debugging port from 9444 to 9499, and
no daemon connection. It replays the unchanged captured replies plus a separate
synthetic mail reply at 1440, 1024, 820 and 390px, in both themes and all three
Markdown variants. It checks every link fragment's viewport bounds and nine
hit-test points, then clicks or taps once and requires the exact opener arguments.
Real Markdown images and the reply footer remain mounted to catch overlap.
External requests are intercepted locally. The report stays in
`KANBAN_TMP/reply-links-report.json`; the browser profile is removed on exit.

Native replay covers `Platform.OS` values `ios`, `android` and `web`, including
`Platform.isPad` on iOS. These tests check dispatch rather than launching real
device applications. Before device sign-off, prepare a disposable test
conversation named **Reply link check** with the two replies from
`test/fixtures/real-assistant-links.json` and the synthetic reply in
`test/helpers/reply-link-cases.cjs`. Keep mail handlers configured on each device.
On an iPhone, iPad and Android device connected to that test host:

1. Open **Reply link check** after the test host's owner has loaded the candidate
   plugin and reloaded the conversation with **Assistant markdown** enabled.
2. In the first reply, tap **Sample guide** and
   `https://example.com/sample/project` once each; return to the conversation
   after each browser or OS handler opens.
3. In the image reply, tap each image address and the project URL below them.
   The adjacent image and Copy control must not intercept the tap.
4. In the synthetic reply, tap **Email support** and the bare `mailto:` URL.
   Each should open a compose view for `hello@example.org`, subject `Reply links`,
   body `One tap & done`. Dismiss the draft without sending. Also tap the `www.`
   and HTTP URLs once each.
5. Repeat the iPad check in portrait and landscape. Confirm that the existing
   selection, long-press and Copy behaviour remains unchanged.

Reserved example domains may show a missing page; this check concerns the
correct browser or mail application receiving the exact URL. Record native OS
and Paseo app versions with the result. Physical-device checks remain pending
until a user performs them; the replay does not certify native gesture handling.


## Plugin SDK limitations found while building this

The current SDK and minimum supported host are 0.12.0. See the
[0.8.0 to 0.12.0 API audit](SDK-0.12.md) for newly available interfaces, feature
applications, compatibility changes, and current spacing/grouping/font limits.

The historical findings below were measured against `@getpaseo/plugin` 0.8.0 and
the Paseo 0.8.0 desktop build. Each entry names the evidence and the workaround
this plugin uses; consult the audit before applying these findings to newer hosts.

1. **No file navigation.** Timeline renderer props are exactly `{agentId, theme, host, layout,
timestamp, item}`. Client navigation offers `openSettings`, `openSurface` and `openPanel`;
   navigable surfaces additionally receive `openAgent` and `openWorkspace`. The host's own file tab
   target (`{kind:"file", path}`, reachable in-app through `?open=file:<path>`) is not exposed, and
   the `paseo://` scheme only carries agent deep links. Workaround: a daemon-side RPC that reveals
   the path in the operating system's file manager.
2. **Some hosts strip prompt attachments.** A host can map a user message to only `text`,
   `messageId`, and `clientMessageId` before transformers run. The plugin cannot recover or count
   attachments removed this way. Text-only items still use the enhanced bubble and its folding
   controls, without inventing an attachment count. When image metadata is available, the bubble
   keeps available thumbnails and the complete reported count, including missing or failed previews.
   Announced non-image or unsupported attachments remain with the host. Disable **Enhanced prompt
   bubble** to use Paseo's own UI when its timeline omits attachment information.
3. **Interception is all or nothing.** A transformer replaces the host item completely. There is no
   way to decorate an item or keep host affordances that the plugin does not reimplement. Returning
   `undefined` is the only opt-out.
4. **Transform results are cached per item.** Changing a preference does not re-run transformers for
   items already on screen. New items follow the change; existing ones need a reload.
5. **Renderers get no workspace.** Props carry `agentId` only, so `cwd` and `workspaceId` need a
   second lookup through `useAgent`.
6. **Token usage is live-only.** Usage is not persisted on timeline items, so a turn this client did
   not observe live shows no figures.
7. **RPC names are validated late.** The host requires `^[a-z][a-z0-9._-]*$`. A camelCase name such
   as `revealPath` typechecks, then fails the whole plugin at install or reload with
   `Invalid plugin RPC method`.
8. **The React Native runtime module is a stub in the package.** `@getpaseo/plugin/client/react-native`
   ships as `export {}`; the host injects the implementations. Bundling or testing plugin UI outside
   Paseo needs a shim, which is what `.showcase/shims` provides.
9. **The theme carries six colours.** `PluginTheme` exposes `surface0`–`surface2`, `border`,
   `foreground`, `foregroundMuted`, `accent`, `accentForeground`, and three status colours. Every
   other surface, including code backgrounds and diff tints, must be derived with alpha; that is what
   `client/components/theme-tokens.ts` exists for.
10. **No CSS escape hatch.** React Native styles drop unknown keys, so `backdrop-filter` is
    impossible through the style API. Frosted glass is a hand-injected `<style>` rule matched by a
    data attribute.
11. **No font registration or host code-font API.** In SDK 0.8.0, `PluginTheme` in
    `dist/contracts.d.ts` exposes only `colors`; `PluginHostProps` and `PluginClientContext`
    in `dist/client/contracts.d.ts` provide no appearance font getter. SDK 0.12.0 still provides
    neither font registration nor a host code-font API; see the
    [API audit](SDK-0.12.md#spacing-grouping-and-fonts). **Default (Iosevka)** is the
    default choice and uses Iosevka with the existing `codeFont` glyph preference
    (ligatures or literal glyphs). The persisted value remains `host` for compatibility;
    it does not synchronize with Paseo appearance or read undocumented host CSS or browser storage.
    `codeFontFamily` is an optional preference in settings version 2. Version 1.0.1 accepts
    extra object keys but strips them when parsing; saving settings from that older client
    can discard the new font-family choice. Existing `codeFont` values remain compatible.
    Web faces are embedded as data URIs in injected `@font-face` rules; aliases try the selected
    local font before bundled literal Iosevka. Every surface needs a wrapper that escapes the
    host's own font cascade. Native directory plugins cannot load those web fonts: code uses
    Menlo on iOS/iPadOS and `monospace` on Android for every family choice. These fallbacks keep
    code, inline code, terminal output and diffs monospaced when the selected face is unavailable.
12. **A closed module allowlist, and no SVG renderer.** Plugin client code may import only
    `react`, `react/jsx-runtime`, `react-native`, `@tanstack/react-query`, `zod`,
    `@getpaseo/plugin`, `@getpaseo/plugin/client`, `@getpaseo/plugin/client/react-native`, and
    `@getpaseo/plugin/client/ui`. Anything else throws
    `Module "x" is not available in plugin client code` when the bundle loads, so
    `react-native-svg` and `lucide-react-native` are out of reach. Lucide icons still work,
    because the host renders them: `Icon` from `@getpaseo/plugin/client/react-native` takes any
    Lucide name. Brand marks are not in Lucide, and React Native's `<Image>` decodes PNG, JPEG,
    GIF, and WebP but never SVG, so a data-URI SVG renders on web and stays blank on iOS and
    Android. Those marks ship as PNG rasters in `client/components/mark-bitmaps.ts`.
13. **Settings are host-scoped only.** `defineSettings` rejects any scope other than `host`, so
    per-workspace or per-agent presentation settings are impossible. This plugin stores explicit
    presentation choices with the SDK's host settings; unset choices use the plugin defaults.
14. **Paseo's chat find cannot reach replaced rows.** Paseo 0.9.1 finds a match by its original
    message id, then waits for a row carrying that id. A transformed row always carries
    `<pluginId>/<itemId>` instead, so Ctrl+F on a styled prompt or reply never reveals the match.
    Workaround: the plugin's own find bar, described in the main README under Features.
15. **No timeline gap or neighbor props.** In the pinned SDK, `layout` exposes only
    `compact` (the device breakpoint) and `platform`; transform results expose only
    replacement items. The [v0.8 host spacing rules](https://github.com/getpaseo/paseo/blob/v0.8.0/packages/app/src/agent-stream/spacing.ts)
    give transformed `plugin` rows the default 16px gap, unlike native tool sequences.
    The web workaround reads the existing history row/frame DOM and adjusts only
    the plugin root between collapsed tools. Unknown layouts, nonconsecutive
    virtual rows and native apps keep host spacing. Controlling those gaps requires
    a host API that supplies the actual gap and adjacent item types.

## Custom accent colours

The settings page uses the same React Native controls on web, iOS, iPadOS and
Android. **Custom** offers wrapping, 44px colour targets and a HEX field with an
explicit **Apply** action (or the keyboard's Done action). A swatch applies at
once. Invalid or partial HEX displays an inline error on Apply without changing
the current colour. `#RGB` and `#RRGGBB` are accepted, surrounding whitespace is
trimmed, and storage normalizes to lowercase `#rrggbb` without alpha.

The optional `customAccent` and `customAccentEnabled` preferences keep settings
at version 2. Defaults are `#8b5cf6` and `false`. Choosing a preset disables the
custom override and retains its HEX; reset clears both. The existing `accent`
enum is unchanged, so version 1.0.1's Zod object ignores the unknown fields and
reads the last selected preset (or the host default). Saving again in 1.0.1
discards those unknown fields; upgrading later then uses the defaults. New
host-only fields are excluded from the legacy browser preference import.

The requested HEX is never rewritten by a theme change. Theme tokens calculate
WCAG sRGB relative luminance and contrast after alpha compositing the plugin's
neutral, code and accent-tinted backgrounds over the host surface. If the
requested colour passes 4.5:1 on those surfaces, it stays exact. Otherwise, the
display colour moves in 1/255 sRGB blend steps towards black on a light surface
or white on a dark surface, stopping at the first passing step. If that
direction has no passing step, the opposite direction is tried. If neither
direction passes on a midtone theme, neutral, code and accent-tinted surfaces
use the solid host background, with whichever of black or white has higher
contrast as the accent. This avoids incompatible light and dark backdrops for
one text colour. Filled accent
buttons choose black or white text, whichever has higher contrast. Host and
preset colours keep their previous behaviour. Existing renderers subscribe to
preferences, so mounted cards receive the new tokens without retransformation.

Run `node --test test/custom-accent.test.cjs` for native component replays,
JSON persistence, malformed input and independent 4.5:1 calculations across
light and dark themes. The browser replay is described in the
[offline harness guide](../.showcase/README.md).

## Project structure

```text
clear-chat/
  paseo-plugin.json          # Manifest: id and Paseo requirement
  index.client.tsx           # Timeline transformers, renderers, settings screen
  index.server.ts            # Host settings migration/registration and daemon-side RPCs
  server/
    settings-migration.ts    # First-run copy of the previous installation's host settings
  shared/
    contracts.ts             # Data contracts shared by client and server
    file-rpc.ts              # file.reveal contract
  client/
    live-renderers.tsx       # Timeline item to component mapping
    tool-call-data.ts        # Normalized tool details to card data
    tool-detail.ts           # Search, fetch, checklist and fallback extraction
    tool-call-legacy.ts      # Existing named-tool adapters
    settings-page.tsx        # Settings screen
    preferences.ts           # Presentation preferences backed by host settings
    components/              # Cards, syntax block, glyphs, motion, theme tokens
      mark-bitmaps.ts        # GENERATED PNG rasters of every brand mark
      devicon-data.ts        # Vendor SVG sources, read only by the generator
      lobe-marks.ts          # Vendor SVG sources, read only by the generator
  .showcase/                 # Offline harness used to capture the screenshots
  docs/images/               # Screenshots in this README
```

## Development

```bash
npm install
npm test
npm run typecheck
paseo plugin reload clear-chat
```

### Installation and startup diagnostics

The manifest runs `node scripts/install.cjs`. It installs with
`npm ci --include=dev` before checking Shiki, the plugin SDK and schema dependencies.
Dependency failures report a fixed recovery message instead of forwarding npm output
or a stack trace. This also covers the missing Shiki dependency reported in
[Beautiful Chat issue 1](https://github.com/ABorakati/beautiful-chat/issues/1).

The manifest's Paseo requirement is enforced by Paseo before plugin code runs.
Once loaded, both contributions check the APIs they need and explain how to update
Paseo if one is absent. Registration failures suggest reloading and backing up settings
before reinstalling. The SDK exposes no host version to the contribution, so the plugin
does not guess a version from a connection error. A host that cannot launch Node.js,
run the build command or load the bundle must report that failure itself.

Settings read, write, format and revision-conflict errors use fixed messages with
recovery steps. The settings page offers **Retry** for loading preferences again;
failed edits must be made again after the storage problem is repaired. Healthy startup
shows no diagnostic. Failed Beautiful Chat settings migration keeps the original data
and logs a safe recovery message on the daemon, without paths or an exception object.

Run the targeted regressions and optional offline layout replay with:

```sh
node --test test/install-failures.test.cjs test/preferences.test.cjs test/settings-migration.test.cjs
npm ci --prefix .showcase --include=dev
node scripts/replay-install-failures.cjs
```

Set `KANBAN_TMP` and `TMPDIR` to an authorized task temporary directory first.
The replay builds the actual client and server bundles in memory, then renders every
diagnostic using the same React Native component at 1440, 1024, 820 and 390 pixels.
Google Chrome runs headlessly with an available debugging port in 9444–9499. Web,
iOS, iPadOS and Android projections check text clipping, horizontal bounds and Retry.
Mobile projections use React Native Web with emulated touch, viewport and user agent;
they do not replace native-device checks. The JSON report stays in `KANBAN_TMP`.

For optional Google Chrome measurements of an existing conversation, see the
[performance script guide](../scripts/perf/README.md). Plugin states are prepared
manually; reports stay local.

Compare tool row density against a release without a live daemon:

```bash
npm ci --include=dev
npm ci --include=dev --prefix .showcase
export TMPDIR="$KANBAN_TMP"
node .showcase/measure-tool-rows.cjs v1.0.1
```

This builds both revisions in memory and replays the 28 tool calls from
`test/fixtures/real-claude-session.json`, folded in their original order, with a
64px top inset and 16px host gaps. Headless Google Chrome measures an 844px-high
viewport at 1440, 1024, 820, 744, 743 and 390px in both themes. The check requires
pixel-identical tablet/desktop captures, more fully visible phone rows, 11px
minimum summary text, 28px buttons, and no overlapping targets or horizontal
overflow. It clicks both edges of phone buttons to check clipping and row
identity. Results and screenshots stay in `KANBAN_TMP/tool-rows`; Chrome uses a
free debugging port from 9444 through 9499 and its temporary profile is removed.
The component tests separately replay phone iOS, phone Android and tablet iOS
layouts; physical iOS, iPadOS and Android verification remains a device check.

Rebuild the screenshots after a visual change:

```bash
esbuild .showcase/showcase.tsx --bundle --outfile=.showcase/showcase.js --jsx=automatic \
  --alias:react-native=react-native-web \
  --alias:@getpaseo/plugin/client/react-native=./.showcase/shims/plugin-react-native.tsx
```

Then serve `.showcase/` and capture each `#shot-*` element.
