# Developing Clear Chat

[Back to README](../README.md)

Technical notes for contributors. For installing and using Clear Chat, see the [README](../README.md).

## Tool row behaviour

Finished calls open as compact, single-line rows: tool icon, command or file/query summary,
status, and duration when the provider reports one. Running calls spin; failed calls show a
cross, completed calls a check, and canceled calls a separate label. Running, failed and
waiting-for-user calls default to expanded. Click a row to expand or collapse it.
At widths of 744px and above, collapsed rows occupy 26px including their borders and vertical spacing.
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

Long code and command output preview the first 15 lines by default. **Show all N lines** reveals
the complete output, and code's Copy control always copies the full source. Ordinary replies
stay fully expanded. Explicit `wrap_up` calls, including a `ccd_turn` operation marked
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
**Step actions**. The same centered, scrollable menu fits desktop, tablet and
phone viewports; Escape, Android Back or the backdrop closes it. Releasing a
long press does not activate the row's ordinary click action.

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
DOM bounds, clipboard arguments, actual long-press timing and ordinary clicks
at 1440, 1024, 820 and 390px, install the offline harness dependencies with
`npm ci --prefix .showcase --include=dev`, then run:

```sh
TMPDIR="$KANBAN_TMP" node .showcase/verify-step-menu.cjs
```

The verifier bundles the real components in memory and uses headless Google
Chrome with a free debugging port in 9444–9499. Its profile and JSON report stay
in the task's temporary directory; the profile is removed on exit. SDK services
are supplied by the harness. This is a component preview, and iOS, iPadOS and
Android still need a final device check.

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

A directory path opens that directory. A path the daemon cannot stat does nothing.

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

Measured against `@getpaseo/plugin` 0.8.0 and the Paseo 0.8.0 desktop build. Each entry names the
evidence and the workaround this plugin uses.

1. **No file navigation.** Timeline renderer props are exactly `{agentId, theme, host, layout,
timestamp, item}`, and plugin navigation offers only `openSettings`, `openSurface`,
   `openWorkspacePanel`, `openAgentPanel`, `openAgent`, and `openWorkspace`. The host's own file tab
   target (`{kind:"file", path}`, reachable in-app through `?open=file:<path>`) is not exposed, and
   the `paseo://` scheme only carries agent deep links. Workaround: a daemon-side RPC that reveals
   the path in the operating system's file manager.
2. **Some hosts strip prompt attachments.** A host can map a user message to only `text`,
   `messageId`, and `clientMessageId` before transformers run. The plugin cannot recover or count
   attachments removed this way, so it automatically leaves these prompts to the host. When image
   metadata is available, the enhanced bubble keeps available thumbnails and the complete image
   count, including attachments with missing data or failed previews. Other attachment kinds also
   remain with the host.
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
    in `dist/client/contracts.d.ts` provide no appearance font getter. **Follow Paseo** is the
    default choice and falls back to the existing `codeFont` glyph preference (Iosevka with
    ligatures or literal glyphs). It does not read undocumented host CSS or browser storage.
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
