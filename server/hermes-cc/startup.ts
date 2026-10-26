import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { hermesCcSettings } from "../../shared/settings";

/**
 * SDK v0.13.0 packages/plugin/src/server/contracts.ts:30-45 requires synchronous
 * contribution and exposes config only in later handler/hook contexts.
 * server/plugins/plugin-process.ts:283-315
 * publishes the provider list immediately afterwards. Read a startup snapshot;
 * never register providers from an asynchronous settings.read() continuation.
 * Agent config: server/persisted-config.ts:339-341 and
 * server/daemon-config-store.ts:610-633; public-docs/custom-providers.md:161-176.
 * Top-level providers is speech-only (persisted-config.ts:74-79,334).
 * Settings envelope:
 * server/plugins/settings/index.ts:8,91-122; bootstrap.ts:648 and runtime.ts:758-760.
 * Settings/store paths assume the default plugin id "clear-chat": the SDK
 * PluginServerContext exposes neither the plugin id nor a data directory.
 * Changes to config or this setting take effect when the host reloads the plugin.
 */
export function hermesCcStartupConfig(home?: string): { providers: Record<string, unknown>; enabled: boolean } {
  const rawHome = process.env.PASEO_HOME ?? "~/.paseo";
  home ??= resolve(rawHome === "~" ? homedir() : rawHome.startsWith("~/") ? join(homedir(), rawHome.slice(2)) : rawHome);
  let enabled = true;
  try {
    const envelope = JSON.parse(readFileSync(join(home, "plugin-settings", "clear-chat", "hermes-cc.json"), "utf8"));
    enabled = envelope.version === 1 && hermesCcSettings.schema.parse(envelope.values).enabled;
  } catch (error) {
    // Only a missing settings document uses defaults. Invalid/unreadable is OFF.
    enabled = !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
  }
  if (!enabled) return { providers: {}, enabled: false };
  try {
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8").replace(/^\uFEFF/, ""));
    const providers = config?.agents?.providers;
    return { enabled, providers: providers && typeof providers === "object" && !Array.isArray(providers) ? providers : {} };
  } catch {
    console.debug("[clear-chat] hermes_cc: config_unavailable");
    return { enabled: false, providers: {} };
  }
}
