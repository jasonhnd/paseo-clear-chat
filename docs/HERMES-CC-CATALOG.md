# Hermes·CC remembered catalogs

Before a user opens a real session, a command-only provider has no modes or
agent models in the provider/new-agent picker. Explicit source `models` and
`additionalModels` remain available as before. Startup, discovery (including
workspace discovery), and session listing never send `session/new`.

A user-requested `session/new` or `session/load` response supplies the remembered
catalog. Clear Chat ports the mappings from Paseo v0.13.1
[`deriveModesFromACP` and `deriveModelDefinitionsFromACP`](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/server/src/server/agent/providers/acp-agent.ts#L773),
including native-list precedence, grouped config options, descriptions, current
mode/model defaults, and thinking choices. No mode IDs or labels are supplied by
Clear Chat. The host adds the provider identity when converting `ProviderCatalog`.

Discovery returns the remembered modes and default mode. A nonempty source
`models` list replaces agent models; absent or empty `models` retains them.
`additionalModels` merges by ID, preserving order and clearing prior defaults
when an addition declares a default, following
[Paseo's `mergeModels` / `mergeModelAdditions`](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/server/src/server/agent/provider-registry.ts#L371).
Invalid configured model rows are dropped individually with a fixed reason log.

The per-provider document lives in Clear Chat's own
`plugin-data/clear-chat/hermes-cc-catalog/<sha256-provider-id>.json`. It contains a
version, provider ID, and derived catalog only. Writes use a private temporary
file and atomic rename, with a 64 KiB document limit. Reads validate the schema,
version, identity, file type, and size; doubtful documents are ignored. Learning
updates memory immediately and queues persistence without awaiting disk I/O in
the user's open or prompt. Journal and image handling are unchanged.

## FINDINGS

After the first real open, the next catalog request includes the learned modes,
default mode, and merged models. These survive a plugin restart. Paseo's SDK has
no provider catalog-changed event or provider-refresh operation:
[`ProviderRegistration` and `ProviderEvent`](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/plugin/src/server/provider.ts).
An unsolicited `catalog` event would not invalidate the host's provider snapshot.
A catalog-dependent `getCatalogCacheKey` also makes the next host catalog warm-up
bypass the earlier cached catalog (see
[`ProviderSnapshotManager.resolveCatalog`](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/server/src/server/agent/provider-snapshot-manager.ts#L925)).
Existing picker snapshots update on the next **host provider refresh or reload**,
through
[`handleRefreshProvidersSnapshotRequest`](https://github.com/getpaseo/paseo/blob/v0.13.1/packages/server/src/server/session/provider/provider-catalog-session.ts#L433)
and the host's subsequent `fetchCatalog`. Live-session mode changes still follow
the SDK's existing session configuration events.
