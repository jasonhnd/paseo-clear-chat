# SDK 0.13 migration evidence

Development uses `@getpaseo/plugin@0.13.0` and its matching client/protocol peers.
The package version and `paseo-plugin.json` requirement remain unchanged.

Sources: the installed npm packages and the upstream
[0.13.0 release notes](https://github.com/getpaseo/paseo/releases/tag/v0.13.0),
especially the Plugins section. Neither published SDK package contains a README
or CHANGELOG; the upstream `packages/plugin/README.md` also returns 404 at the
release tag. The upstream root CHANGELOG repeats the release notes.

## Deprecated APIs used here

Paths below are relative to `node_modules/@getpaseo/plugin/` in version 0.13.0.
Line numbers identify the SDK's deprecation annotations.

| Deprecated API | Replacement | SDK declaration |
| --- | --- | --- |
| `client/react-native` UI entry point | `client/ui` | `dist/client/react-native.d.ts:1` |
| `useRevealedText` | Render `StreamedText` | `dist/client/react-native.d.ts:3` |
| Agent panel top-level `agentId` | `params.agentId` | `dist/client/contracts.d.ts:119` |
| `addWorkspacePanel({ context: "agent" })` | `addAgentPanel` without `context` | `dist/client/contracts.d.ts:176` |

The host `StreamedText` implementation wraps its internal reveal hook and a native
Text, forwarding text props and applying the supplied style after host defaults:
[`streamed-text.tsx`](https://github.com/getpaseo/paseo/blob/v0.13.0/packages/app/src/plugins/react-native/streamed-text.tsx).
Reasoning retains paragraph cards and uses it for each paragraph, with the active
paragraph receiving the streaming phase. Metadata and the rail now follow incoming
paragraphs; pacing is owned by each paragraph's `StreamedText`, since the new public
API exposes a component rather than the revealed string.

Panel IDs, explorer location, selection state, workspace validation, and opening
options are preserved. Existing tests exercise the right-side panel at >=1024px,
floating popover at 744–1023px, bottom drawer below 744px, and transfers between them.

## Other deprecations in 0.13.0

These have no production usage in this repository:

| Deprecated API | Replacement | SDK declaration |
| --- | --- | --- |
| Workspace/agent panel `context` props | Select context through registration | `dist/client/contracts.d.ts:113,117` |
| Workspace panel registration `context: "workspace"` | Omit `context` | `dist/client/contracts.d.ts:172` |
| `addSurface` | `addScreen` | `dist/client/contracts.d.ts:141` |
| `addSidebarItem` | `addSidebarHeaderItem` | `dist/client/contracts.d.ts:143` |
| `PluginSidebarContribution` | `PluginSidebarItemContribution` | `dist/client/contracts.d.ts:200` |
| `openSurface` | `openScreen` | `dist/client/contracts.d.ts:239` |
| `SettingsGroup` | `SettingsSection` | `dist/client/ui.d.ts:107` |
| Turn-ended hook `timeline` (always empty) | `context.paseo.agents.ref(agent.id).timeline.refetch(...)` | `dist/server/lifecycle.d.ts:54` |

The remaining `client` imports are current hooks or types. `addWorkspacePanel`
itself remains valid for workspace panels; its agent-context overload is deprecated.

## Paseo 0.12.0 compatibility

**This migrated plugin cannot fully load and work on a 0.12.0 host.** The unchanged
`>=0.12.0` manifest requirement therefore overstates its runtime compatibility.

A separate `npm install --prefix node_modules/.cc-sdk-compat --ignore-scripts
@getpaseo/plugin@0.12.0` installed the old SDK inside this worktree. Comparing its
package exports and declarations with 0.13.0 shows:

- `client/ui` already exists in 0.12.0 (`package.json:46–49`), but exposes settings
  and sidebar UI, not the moved `Icon`, `Modal`, `TextInput`, `copyText`, `useToast`,
  or the new `StreamedText`. Those imports all fail a TypeScript probe against
  the old `dist/client/ui.d.ts` with TS2305.
- `PluginClientContext` has `addWorkspacePanel` (`dist/client/contracts.d.ts:115`)
  and no `addAgentPanel`. The probe reports TS2339 for `client.addAgentPanel`.
- `PluginAgentPanelProps` uses top-level `agentId` and `context`
  (`dist/client/contracts.d.ts:90–94`) and has no `params`. The probe reports
  TS2339 for `panel.params`.
- SDK runtime UI modules are placeholders; Paseo injects their implementations.
  Upgrading the development dependency cannot add these APIs to an older host.
  The `addAgentPanel` guard only skips registration on such a host; it cannot
  supply the missing UI exports.

Proposed follow-up: raise `requirements.paseo` to `>=0.13.0` before distribution.
It is intentionally unchanged in this task. Alternatively, retaining 0.12 support
would require feature-detecting `addAgentPanel`, adapting legacy top-level panel
props, and selecting legacy UI implementations (including streaming text) through
a host-compatible runtime adapter. A panel-only fallback would be insufficient.
