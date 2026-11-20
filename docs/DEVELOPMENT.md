# Developing Clear Chat

[Back to README](../README.md)

Contributor notes. Installing and using Clear Chat is in the [README](../README.md).

Clear Chat is a Paseo plugin for the answer card. It does not register timeline transformers, timeline renderers, a sidebar, or a provider.

## Requirements

`paseo-plugin.json` requires Paseo `>=0.16.0`. The development dependency is `@getpaseo/plugin` 0.16.0.

## What the entries register

`index.client.tsx` checks for plugin RPC and `addSettingsScreen`, then registers one settings screen (`chat-presentation`) whose title comes from `settings.title` (**Answer card** in English). It stores unfinished answer drafts in host settings and writes answer progress onto the current composer metadata when that API is present. It does not mount the answer card component.

`client/components/option-card.tsx` is the card. `client/option-questions.ts` decides which replies are questions. `client/option-session.ts` keeps choices, drafts, and whether a later user message counts as an answer. `client/answer-feed.ts` can publish timeline rows into that session, but the plugin entry does not call `startAnswerFeed`.

`index.server.ts` checks for `registerSettings` and `handle`, copies a Beautiful Chat settings file on first start when Clear Chat has none (`server/settings-migration.ts`), and registers the host settings schema in `shared/settings.ts`. Startup does not delete plugin-data files.

The settings schema still accepts keys from the old conversation view. The settings page (`client/settings-page.tsx`) only renders the answer-card switch, saved replies, the installed version, and **Report a problem**. When `showAnswerCard` is absent, the default in `client/preferences.ts` is on. A stored value wins.

## Project structure

```text
clear-chat/
  paseo-plugin.json          # id, description, Paseo requirement, build command
  index.client.tsx           # settings screen only
  index.server.ts            # settings registration and first-run copy
  server/settings-migration.ts
  shared/settings.ts         # host settings schema
  shared/startup-diagnostics.ts
  client/settings-page.tsx
  client/preferences.ts
  client/components/option-card.tsx
  client/option-questions.ts
  client/option-session.ts
  client/answer-feed.ts
  client/locales/            # en, zh-CN, ja
  scripts/install.cjs        # npm ci, then resolve @getpaseo/plugin and zod
```

## Checks

```bash
npm ci
npm test
npx tsc --noEmit
```

Run `npm test` with `PASEO_HOME` pointed at an empty directory so the suite does not read a real host config.

`node scripts/install.cjs` runs `npm ci --include=dev` in the checkout, then resolves `@getpaseo/plugin` and `zod`. It does not install a syntax-highlighting package. Dependency failures use a fixed recovery message.

The manifest requirement is enforced by Paseo before plugin code runs. After load, the client checks `rpc` and `addSettingsScreen`. The server checks `registerSettings` and `handle`. The incompatible-host text names those methods. The SDK does not give the contribution a host version, so the plugin does not guess one.

## Version files

`package.json`, the root `version` fields in `package-lock.json`, and the `vX.Y.Z.W · ` prefix of `paseo-plugin.json` `description` must match. `node scripts/bump-version.cjs <version>` updates those three and prints document lines that still name the old version. It does not rewrite the documents. `npm run manifest:version` rewrites only the manifest description prefix from `package.json`.

## Languages

User-facing strings live in `client/locales/en.json`, `zh-CN.json`, and `ja.json`. The plugin list has no translated description field; it shows the English manifest description.
