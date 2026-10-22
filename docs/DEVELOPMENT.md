# Developing Clear Chat

[Back to README](../README.md)

Technical notes for contributors. For installing and using Clear Chat, see the [README](../README.md).

## Tool row behaviour

Finished calls open as compact, single-line rows: tool icon, command or file/query summary,
status, and duration when the provider reports one. Running calls spin; failed calls show a
cross, completed calls a check, and canceled calls a separate label. Running, failed and
waiting-for-user calls default to expanded. Click a row to expand or collapse it.
Collapsed rows occupy 26px including their borders and vertical spacing.
On web, adjacent collapsed tool rows have a 30px center pitch with the host's
16px timeline gap: `26 + 16 - 12 = 30`. The plugin reads the preceding host
frame's actual gap and applies up to 12px of negative top margin to its own
root, leaving at least 4px of that gap. Expanded tools, replies, messages,
footers and auxiliary content end a compact sequence. Smaller gaps receive
less compensation, so rows never overlap. Host styles are not modified.

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
11. **No font registration.** Faces are embedded as data URIs in an injected `@font-face` rule, and
    every surface needs a wrapper that escapes the host's own font cascade.
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

For optional Google Chrome measurements of an existing conversation, see the
[performance script guide](../scripts/perf/README.md). Plugin states are prepared
manually; reports stay local.

Rebuild the screenshots after a visual change:

```bash
esbuild .showcase/showcase.tsx --bundle --outfile=.showcase/showcase.js --jsx=automatic \
  --alias:react-native=react-native-web \
  --alias:@getpaseo/plugin/client/react-native=./.showcase/shims/plugin-react-native.tsx
```

Then serve `.showcase/` and capture each `#shot-*` element.
