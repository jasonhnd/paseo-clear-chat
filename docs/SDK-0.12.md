# Paseo plugin SDK 0.12.0 compatibility

Clear Chat now builds against `@getpaseo/plugin` **0.12.0** and requires Paseo
**0.12.0 or later**. The SDK's exact client/protocol peers, and their relay
dependency, also resolve to 0.12.0. The plugin version remains 1.0.1; the settings
document remains version 2. No presentation setting or renderer changed for this
upgrade.

The minimum host version is an explicit compatibility policy: this revision is
checked against the 0.12.0 SDK and host compiler. The package itself declares exact
client/protocol peers, but does not declare a minimum daemon version. Raising the
manifest requirement prevents this revision from being installed on older,
unverified hosts; it does not imply that every existing renderer needs a new API.

## Evidence and scope

Compared every distributed declaration and JavaScript file in the npm 0.8.0 and
0.12.0 tarballs. Neither tarball includes a CHANGELOG. The release history comes
from the [host CHANGELOG at v0.12.0](https://github.com/getpaseo/paseo/blob/v0.12.0/CHANGELOG.md),
covering all releases after 0.8.0 through 0.12.0, and the corresponding commits
linked below. The 0.12.0 npm package's `gitHead` is
`cafe4b01c8522ff39560241c5deb01427dc8dc5b`, the host release tag's commit.

The tables distinguish new exports from existing capabilities. Feature references
are: A1 step details, A2 step actions, A3 links, A4 compact rows, A5 tablet layout,
B1 file links, B3 fonts, B5 installation help, C1 hover preview, C2 detail content,
C3 keyboard navigation, D2 host compatibility. They identify possible follow-up
work, not features implemented by this dependency update.

## Spacing, grouping and fonts

| Interface | Change / usage | Applicable work | Limits and pitfalls |
| --- | --- | --- | --- |
| `PluginHostProps.layout` / `PluginTimelineItemProps` | Unchanged: `layout` contains `compact` and `platform`; renderer props also contain `agentId`, `theme`, `host`, `timestamp`, and the replacement `item`. | A4, A5 | No timeline gap, adjacent-row data, available width, or spacing setter. The host's 16px default between plugin rows is still outside this API. Keep the existing bounded web compensation; native spacing remains host-owned. |
| `addTimelineTransformer({ query, transform })` / `PluginTimelineTransformResult.items` | Unchanged: called with **one** source `item` and `phase`. Return `undefined` to keep it, `items: []` to hide it, or an ordered array of plugin rows to replace it. A summary can precede details within that one replacement array. | Grouped steps, C2 | No batch/neighbor input, cross-source merge, or insertion before another source row. Host projection caches each source independently; a stateful accumulator would depend on evaluation order and virtualization. Only the first matching transformer returning a result wins. |
| `PluginTimelineItemProps.timestamp` | Unchanged: a renderer receives the source row's `Date`; all replacements of that source inherit it. Copy a provider-reported `detail.durationMs` into replacement data when available. | C2 | The transform callback has no timestamp argument, and neither transform output nor renderer props have dedicated start/end timestamps. `phase: "complete"` also applies to failed/canceled calls; inspect `item.status`. A provider's optional metadata is not a universal timing contract. |
| `PluginTheme.colors` / `useSettings` | Unchanged: theme provides eleven semantic colors; `useSettings` reads a plugin-defined settings document. | B3 | No public UI-font, code-font, font-size, or appearance-settings hook. `useSettings` cannot read the app's own appearance preferences. Web font inheritance/DOM inspection is not a portable settings API. Keep plugin defaults or explicit font preferences until a host API exists. |

Sources: [client contracts](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/plugin/src/client/contracts.ts),
[shared contracts](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/plugin/src/contracts.ts),
[host projection](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/plugins/timeline/projection.ts),
[transform arbitration](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/plugins/timeline/model.ts),
[host spacing](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/agent-stream/spacing.ts),
and [app appearance application](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/appearance/provider.tsx).
These sources confirm the negative findings; an SDK version bump alone cannot
provide compact native gaps, cross-row grouping, or host-font synchronization.

## New client APIs

Imports are from `@getpaseo/plugin/client` unless another entry is named.

| Interface | Usage | Applicable work | Limits and pitfalls / introducing commit |
| --- | --- | --- | --- |
| `client.addScreen`, `client.openScreen`; `PluginScreenContribution`, `PluginScreenProps`, `PluginScreenTitle`, `PluginScreenParams`, `PluginOpenScreenInput`, `PluginScreenLocation` | Register `{ id, title, Component }`; open with `{ screenId, params }`. The component receives string params; title can be a function of them. | A1/C2 optional full-page details | Navigates to a screen, rather than opening a chat-side preview. Params travel in the URL: use identifiers, not complete tool output. `addSurface` / `openSurface` remain deprecated aliases. [3a930460](https://github.com/getpaseo/paseo/commit/3a9304607cf438cfe328b90b7d6b3a5c24832685) |
| `client.addSidebarHeaderItem`, `client.addSidebarFooterItem`; `PluginSidebarItemContribution`, `PluginSidebarItemProps` | Register `{ id, title, Component }`; props expose `currentScreen`, `openScreen`, and `openPopover(Content)`. | A1/C2 optional persistent entry | Sidebar items belong to the app sidebar, not the workspace Explorer panel. The old `addSidebarItem` / `PluginSidebarContribution` remain deprecated. [3a930460](https://github.com/getpaseo/paseo/commit/3a9304607cf438cfe328b90b7d6b3a5c24832685) |
| `PluginSidebarItemProps.openPopover`, `PluginPopoverProps` | Open a component receiving `close()` and `openScreen()`. The host anchors it on wide layouts and presents a sheet on compact layouts. | A1, C1 as an alternative sidebar entry | This callback exists on sidebar props, not timeline props. It cannot anchor an arbitrary hovered tool row, and exposes no sheet detents or width thresholds. [3a930460](https://github.com/getpaseo/paseo/commit/3a9304607cf438cfe328b90b7d6b3a5c24832685) |
| `SidebarRow`, `SidebarSeparator`, `SidebarRowProps`, `SidebarIcon` (`client/ui`) | Render the host sidebar kit in an item's component. Rows accept icon, label, active state, `onPress`, and a separately pressable trailing slot. | A1/C2 navigation | These components require sidebar-item context. Give multiple rows distinct local `id` values. [3a930460](https://github.com/getpaseo/paseo/commit/3a9304607cf438cfe328b90b7d6b3a5c24832685) |
| `useHosts`, `PluginHostSummary`, `getPaseoClient(serverId)` | List configured hosts and connection status; borrow an online host's `PaseoApi`. | C2 details spanning hosts, D2 diagnostics | Offline hosts can appear in `useHosts`; guard status and handle connection errors. Do not close a borrowed client or persist it beyond installation lifetime. [6ce6f4c9](https://github.com/getpaseo/paseo/commit/6ce6f4c96167a142516d8e1b8aee9219d64b0c57) |
| Optional `navigation.openAgent` / `navigation.openWorkspace` now accept `serverId` | Pass the target host with the agent/workspace ID when navigating from a surface or panel. | A1/C2 links to another agent | `navigation` is optional and absent from timeline renderer props. Hide dependent actions when unavailable. [72e3d695](https://github.com/getpaseo/paseo/commit/72e3d6957a841b941d63c4a486b181928a302b3a) |
| `openExternalUrl`, `ExternalLink` / `ExternalLinkProps` (`client/ui`) | Call `await openExternalUrl(url)` or render `<ExternalLink href={url} onError={...}>`. | A3, B1 web links, B5 help links | Accepts absolute HTTP(S) URLs only. Does not replace the current `mailto:` path or open daemon files. These client exports are host-injected, so offline harnesses need shims. [c7db3c5a](https://github.com/getpaseo/paseo/commit/c7db3c5a8cd997dd87032332b1cb973bbd91015b) |
| Optional `navigation.openBrowser({ url, workspaceId, serverId? })` | Open a workspace-owned local browser tab. | A3/C2 web resources | Electron only; guard the capability. This is a URL browser, not a host file editor or a native mobile opener. [c7db3c5a](https://github.com/getpaseo/paseo/commit/c7db3c5a8cd997dd87032332b1cb973bbd91015b) |
| `client.playAudio({ base64, mimeType })` | Await client-side playback; the Promise resolves when playback ends. | No current presentation feature needs it | Audio payload is base64 and playback is asynchronous; handle rejection. Not an overlay or font API. [42806cdb](https://github.com/getpaseo/paseo/commit/42806cdbf9ee979d3500111b2df17cf60850c131) |

## Existing overlay and panel capabilities

These were already in 0.8.0. They remain useful alongside the new sidebar APIs.

| Interface | Usage | Applicable work | Limits and pitfalls |
| --- | --- | --- | --- |
| `Modal`, `Modal.Content` (`client/react-native`) | Control `open` / `onOpenChange`; set title and optional icon. Content supports `style`, `contentContainerStyle`, and `scrollable`. | A1, A2, C1/C2 | The host chooses modal/sheet presentation. Content padding/gap control applies only inside the modal, not to chat rows. No public `snapPoints`, presentation-breakpoint, arbitrary anchor, or hover-trigger props. |
| `ScrollView`, `FlatList`, `TextInput`, `copyText`, `useToast` (`client/react-native`) | Use host-integrated scrolling/input inside a modal; copy on the **client** and report failure. For long output, disable modal scrolling and provide one bounded list. | A2, C2 | A nested plain RN scroller can compete with sheet gestures. `copyText` rejects when unavailable/denied. `FlatList` requires a bounded body and stable keys. |
| `client.addWorkspacePanel` / `client.openPanel(id, { workspaceId, agentId?, location })` | Register an agent/workspace panel, allow `location: "explorer"`, then open that location. | A1/C2 desktop right-side details | Locations are `"workspace"` or `"explorer"`; this is not a drawer API. Resolve the workspace via `useAgent` and provide a path from the timeline component to the captured client capability. The SDK does not promise the feature's 744/1024 breakpoints. |
| `addHeaderButton`, `addComposerPill` with `behavior: { kind: "popover", Content }` | Open host-owned contextual content from the registered header/pill. | A1/C2 alternative entry | The anchor is the contributed button, not a tool row. There is no general exported `Popover` or `Drawer` component. |

For A1/C1, implement one shared detail body and select the presentation at the
feature's width thresholds: below 744, 744–1023, and 1024 or more. Existing `Modal`
can provide a host-owned sheet, but does not expose half/full-screen detents.
At v0.12.0 the underlying compact modal defaults to 65%/90%; those are private host
implementation details. A half/full-screen requirement and a row-anchored hover
preview need additional plugin UI work. Register an Explorer panel for desktop
details where suitable. Do not treat the new sidebar popover as a complete A1/C1
implementation.

Sources: [React Native SDK](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/plugin/src/client/react-native.ts),
[button contracts](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/plugin/src/client/buttons.ts),
[host modal adapter](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/plugins/react-native/modal.tsx),
[adaptive modal implementation](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/components/adaptive-modal-sheet.tsx),
and [popover implementation](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/app/src/plugins/popover.tsx).

## New server and provider APIs

| Interface | Usage | Applicable work | Limits and pitfalls / source |
| --- | --- | --- | --- |
| `registerSettings` now returns `PluginSettings`; `PluginSettingsState` | `const settings = server.registerSettings(definition)`; call `read()` or retain the cleanup from `subscribe(listener)`. | B3, C2 shared presentation preferences | Handle `status: "invalid"`; reads are async and subscribe must be cleaned up. Still plugin-owned, host-scoped settings, not app fonts. Existing calls that ignore the return remain valid. [0c5f472d](https://github.com/getpaseo/paseo/commit/0c5f472da1e22ea7227bc99769981674d6f7ab04) |
| `server.on("agent.closed", handler)` | Subscribe to agent closure and release agent-specific resources; return the unsubscriber in cleanup. | C2/C3 detail-state cleanup | Not a turn-ended event and supplies no step duration. [5375f43a](https://github.com/getpaseo/paseo/commit/5375f43a051c724d080e41efd73e84ccb6082ff5) |
| `server.registerUsageSource`; `UsageSourceRegistration`, `UsageReport`, `UsageWindow`, `UsageBalance`, `UsageDetail` (`server` / `server/usage`) | Register an input schema, account discovery, and a fetch callback returning available/unavailable/error usage reports. | No current feature; possible future quota UI | Account discovery is scoped to global/session context; account keys must not contain credentials. This is account quota, not per-step tokens or start/end time. [792715e7](https://github.com/getpaseo/paseo/commit/792715e762dd51ab748c39e5c655866fdd5b292c) |
| `UsageAccount`, `UsageScope`, `UsageScopeSchema`, `UsageProblem` (`server/usage`) | Describe account identity, scope, and unavailable reasons for usage sources. | Future quota UI only | Session scope carries provider/model/env; do not display or log that environment. [usage contracts](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/plugin/src/server/usage.ts) |
| `windowFromUsedPct`, `windowFromReportedDuration`, `toneFromUsedPct`, `balanceToneFromRemaining`, `usedPctOf`, `hashAccountKey`, `unavailable` (`server/usage`) | Build normalized quota windows, tones, stable account keys and unavailable reports. | Future quota UI only | Reset time is not window duration. Unknown utilization remains unknown rather than zero. These helpers do not measure tool execution. [usage helpers](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/plugin/src/server/usage.ts) |
| `spawnProcess`, `execCommand`, `terminateProcess` (`server`); `ExecCommandOptions` (`server/process` declarations) | Launch CLIs with Windows command-script handling and await captured output or termination. | B5 diagnostics; future daemon-side helpers | Only the three functions are public barrel exports; `server/process` is not an exported package subpath. Caller owns environment, timeout, and output limits. Existing file-reveal behavior is unchanged. [97602926](https://github.com/getpaseo/paseo/commit/9760292650216e4cb93fa787085251029c882130) |
| `ProviderRegistration.command` / `.status`, `ProviderLaunch` / `ProviderLaunchSchema`, `ProviderStatusRequest`, `ProviderStatus` / `ProviderStatusSchema` (`server/provider`) | Declare default argv and report availability using daemon-resolved `launch`; catalog/connect requests now receive it. | D2 provider compatibility only | Status failure needs a diagnostic. These configure a provider, not chat presentation. [b0c9de0c](https://github.com/getpaseo/paseo/commit/b0c9de0c90b6670186153344c5bf7b7b317b8aef) |
| `ProviderRegistration.requiresConfiguration`; `AcpOptions.workspaceOnlyCatalog` | Opt a provider into explicit configuration; defer project-dependent model discovery until a workspace exists. | D2 provider compatibility only | A workspace-only provider can legitimately have an empty global catalog. [16bb179e](https://github.com/getpaseo/paseo/commit/16bb179e67f361817eda76537381c3b135a8ef75), [7aa3fac0](https://github.com/getpaseo/paseo/commit/7aa3fac069d4d07e64ed7696b0e161058cda6e09) |
| Provider `session.opened.toolCallId`; widened `ProviderSessionConfig.providerOptions` | Associate a child with the spawning call in its direct parent's provider-session namespace; provider option values now accept `unknown`. | C2 subagent links, D2 | Session IDs are not Paseo agent IDs; nested parent links must stay direct. Validate unknown options before using them. [a8a8da04](https://github.com/getpaseo/paseo/commit/a8a8da0472c8a1858c65b8bb3a8c166e6ae9efe1), [provider contracts](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/plugin/src/server/provider.ts) |

## Behavior and host release changes

No production TypeScript change was necessary: the existing registrations,
settings, RPC schemas, and timeline mappings typecheck and both entry points
compile against 0.12.0. Existing card/error/cancellation/attachment fixtures remain
the regression suite. The two added release-contract tests first fail against
0.8.0 and the old manifest, then pass with the upgraded package and host floor.

- ACP updates now preserve one message across chunks without a provider message
  ID ([4be34f05](https://github.com/getpaseo/paseo/commit/4be34f05ef1f56b2965a6730f84f258cfe1fb18b));
  do not interpret a chunk as a new timeline step. Failed/canceled ACP tool
  snapshots are also normalized by the SDK. Clear Chat does not register an ACP
  provider, but still checks failed and canceled projected calls.
- Host 0.12 fixes transformed-prompt outline/find behavior and Escape handling
  for plugin previews, protocol type-import compilation, mobile provider
  readiness, and plugin reload timeouts. These are host fixes, not new renderer
  props. Keep existing prompt IDs, link handling, and find behavior during this
  SDK-only upgrade. See the [0.12 plugin release notes](https://github.com/getpaseo/paseo/releases/tag/v0.12.0).
- Host 0.9 adds npm installation and reviewed source updates; 0.11 adds registry
  installation, manifest metadata, and bundling fixes for npm packages using
  `main`/`module`. Runtime-owned React, RN, Zod, and SDK modules still remain
  external. Internal host imports, including `client/host`, are not plugin APIs.
  See the [versioned compiler](https://github.com/getpaseo/paseo/blob/v0.12.0/packages/server/src/server/plugins/compiler.ts).
- The published client barrel remains a host-injection boundary. Do not replace
  external SDK imports with bundled copies of its empty runtime stubs. The
  offline showcase intentionally supplies its own host shims.

## Rechecking locally

Run `npm ci --include=dev`, `npm test`, `npm run typecheck`, and `git diff --check`.
The release-contract test checks the installed and locked SDK/client/protocol
versions as well as the manifest floor. Compile both `index.client.tsx` and
`index.server.ts` with the v0.12.0 host compiler's `compilePlugin` function; it
validates client/server/shared import boundaries as well as bundling.

For visual regression, use the same offline showcase components and synthetic
fixtures at v1.0.1 and at this revision, constrain the showcase's fixed-width
frames to 1440, 1024, 820, and 390 CSS pixels, and compare light/dark captures of
the thread, folded tools, expanded tools, reasoning, tasks, approval, prompt,
code, and settings. Use installed headless Google Chrome, fixed time, loaded
fonts/images, disabled animations, and blocked external requests. This checks
plugin component appearance; it does not reproduce host virtualization or native
sheet gestures. Replay the sanitized fixtures through iOS/iPadOS and Android
component branches separately. Real iOS, iPadOS, and Android remain pending device
checks.
