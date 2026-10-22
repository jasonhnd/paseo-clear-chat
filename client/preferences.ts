import { useSyncExternalStore } from "react";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { STARTUP_MESSAGES } from "../shared/startup-diagnostics";
import {
  preferenceOverridesSchema,
  presentationSettings,
  presentationSettingsRpc,
  type PresentationSettings,
  type PreferenceOverrides,
} from "../shared/settings";

export const ACCENT_PRESETS = {
  host: undefined,
  jade: "#10b981",
  violet: "#8b5cf6",
  amber: "#f59e0b",
  rose: "#f43f5e",
} as const;

export type AccentPreset = keyof typeof ACCENT_PRESETS;
export type UiFontPreference = "inter" | "system";
export type CodeFontPreference = "code" | "plain";
export type MarkdownVariantPreference = "document" | "compact" | "terminal";
export type OutputLineLimit = 10 | 15 | 30 | "never";

export const OUTPUT_LINE_OPTIONS = [
  { value: "10", label: "10 lines" },
  { value: "15", label: "15 lines" },
  { value: "30", label: "30 lines" },
  { value: "never", label: "Never" },
] as const;

/** Multiplier applied to every font size the plugin draws. */
export const TEXT_SIZE_OPTIONS = [
  { value: "0.9", label: "Small" },
  { value: "1", label: "Default" },
  { value: "1.15", label: "Large" },
  { value: "1.3", label: "XL" },
] as const;

export interface EnhancerPreferences {
  accent: AccentPreset;
  uiFont: UiFontPreference;
  codeFont: CodeFontPreference;
  /** Scales every text style the plugin renders; 1 is the authored size. */
  textScale: number;
  frostedGlass: boolean;
  /**
   * A light that follows the pointer across a card. Web and desktop only:
   * touch platforms have no hover, so the attribute is inert there.
   */
  pointerGlow: boolean;
  /**
   * Style prompts when the host supplies attachment metadata. Older hosts strip
   * it entirely, so those prompts automatically stay native to preserve images.
   * Turning this off always hands prompts back to the host.
   */
  enhancedUserBubble: boolean;
  /**
   * The Copy / Add to chat bar that follows a highlight. Web and desktop only:
   * iOS and Android route selection through the platform's own menu, which the
   * plugin cannot extend, so the toggle has no effect there.
   */
  selectionActions: boolean;
  /**
   * The plugin's own markdown rendering for assistant replies. Off hands the
   * turn back to Paseo's renderer, which is the safety valve: the plugin
   * cannot import the host markdown pipeline, so its version is a reasonable
   * subset rather than a superset.
   */
  assistantMarkdown: boolean;
  /** Which look the markdown renderer uses. */
  markdownVariant: MarkdownVariantPreference;
  foldFinishedSteps: boolean;
  foldLongOutputAfter: OutputLineLimit;
}

const STORAGE_KEY = "paseo/clear-chat/preferences/v1";
const LEGACY_STORAGE_KEY = "paseo/beautiful-chat/preferences/v1";

export const DEFAULT_PREFERENCES: Readonly<EnhancerPreferences> = {
  accent: "host",
  uiFont: "inter",
  codeFont: "code",
  textScale: 1,
  frostedGlass: true,
  pointerGlow: true,
  enhancedUserBubble: true,
  selectionActions: true,
  assistantMarkdown: true,
  markdownVariant: "document",
  foldFinishedSteps: true,
  foldLongOutputAfter: 15,
};

const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  const candidate = globalThis as typeof globalThis & { localStorage?: Storage };
  return candidate.localStorage;
}

function migrateBrowserPreferences(): string | null | undefined {
  try {
    const browserStorage = storage();
    if (!browserStorage) return undefined;
    const current = browserStorage.getItem(STORAGE_KEY);
    // Even an empty or invalid new value is an existing choice and takes precedence.
    if (current !== null) return current;
    const legacy = browserStorage.getItem(LEGACY_STORAGE_KEY);
    // localStorage has no cross-tab compare-and-swap: this best-effort snapshot
    // copy can race another tab's first write. Host settings remain authoritative,
    // with revision-checked writes; this snapshot cannot replace saved host choices.
    if (legacy !== null) browserStorage.setItem(STORAGE_KEY, legacy);
    return legacy;
  } catch {
    // Unavailable storage or a failed copy must not consume the host's migration
    // marker. A later browser initialization can retry; the old key stays intact.
    return undefined;
  }
}

function loadLegacyPreferences(): PreferenceOverrides | undefined {
  const stored = migrateBrowserPreferences();
  if (stored === undefined) return undefined;
  if (!stored) return {};
  try {
    const candidate: unknown = JSON.parse(stored);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
    const valid: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(preferenceOverridesSchema.shape)) {
      // New host-only preferences must never come from a browser import snapshot.
      if (key === "textScale" || key === "foldFinishedSteps" || key === "foldLongOutputAfter") continue;
      const parsed = schema.safeParse((candidate as Record<string, unknown>)[key]);
      if (parsed.success && parsed.data !== undefined) valid[key] = parsed.data;
    }
    return preferenceOverridesSchema.parse(valid);
  } catch {
    return {};
  }
}

let preferences: EnhancerPreferences = { ...DEFAULT_PREFERENCES };
let invoke: PluginClientContext["rpc"] | undefined;
let pending = Promise.resolve();
let localVersion = 0;
let ready = false;
let storageError: string | null = null;

class SettingsFailure extends Error {}

function parseSettings(values: unknown): PresentationSettings {
  const parsed = presentationSettings.schema.safeParse(values);
  if (!parsed.success) throw new SettingsFailure(STARTUP_MESSAGES.settingsInvalid);
  return parsed.data;
}

function publish(): void {
  for (const listener of listeners) listener();
}

export function getEnhancerPreferences(): EnhancerPreferences {
  return preferences;
}

export function areEnhancerPreferencesReady(): boolean {
  return ready;
}

export function getEnhancerPreferencesError(): string | null {
  return storageError;
}

async function savePreferences(
  change: (values: PresentationSettings) => PresentationSettings,
): Promise<PresentationSettings> {
  if (!invoke) throw new SettingsFailure(STARTUP_MESSAGES.incompatibleHost);
  // Every write merges against a fresh revision. Retry bounded conflicts so
  // another client's unrelated changes are retained rather than overwritten.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await invoke(presentationSettingsRpc.read, {}).catch(() => {
      throw new SettingsFailure(STARTUP_MESSAGES.settingsRead);
    });
    if (result.status !== "ready") throw new SettingsFailure(STARTUP_MESSAGES.settingsInvalid);
    const current = parseSettings(result.values);
    const next = change(current);
    if (next === current) return current;
    const saved = await invoke(presentationSettingsRpc.write, {
      revision: result.revision,
      values: next,
    }).catch(() => { throw new SettingsFailure(STARTUP_MESSAGES.settingsWrite); });
    if (saved.status === "saved") return parseSettings(saved.values);
    if (saved.status === "invalid") throw new SettingsFailure(STARTUP_MESSAGES.settingsInvalid);
  }
  throw new SettingsFailure(STARTUP_MESSAGES.settingsConflict);
}

function enqueue(change: (values: PresentationSettings) => PresentationSettings): Promise<void> {
  const version = localVersion;
  pending = pending.then(async () => {
    const values = await savePreferences(change);
    // A queued edit must not be replaced by an older read/write response.
    if (version === localVersion) preferences = { ...DEFAULT_PREFERENCES, ...values.preferences };
    ready = true;
    storageError = null;
    publish();
  }).catch((error: unknown) => {
    storageError = error instanceof SettingsFailure ? error.message : STARTUP_MESSAGES.settingsRead;
    publish();
  });
  return pending;
}

export function initializeEnhancerPreferences(rpc: PluginClientContext["rpc"]): Promise<void> {
  invoke = rpc;
  // Copy the browser key even if host settings were already migrated. The host
  // remains authoritative; the new browser key is only the import snapshot.
  const legacy = loadLegacyPreferences();
  return enqueue((values) => {
    if (values.legacyMigrated) return values;
    // Native has no browser storage. Leave migration available until a web
    // client connects, or an explicit edit/reset makes SDK settings authoritative.
    if (legacy === undefined) return values;
    // Existing SDK choices win over legacy values. The host marker prevents
    // stale localStorage from restoring settings after an edit or reset.
    return {
      preferences: { ...legacy, ...values.preferences },
      legacyMigrated: true,
    };
  });
}

export function retryEnhancerPreferences(): Promise<void> {
  if (invoke) return initializeEnhancerPreferences(invoke);
  storageError = STARTUP_MESSAGES.incompatibleHost;
  publish();
  return Promise.resolve();
}

export function updateEnhancerPreferences(update: Partial<EnhancerPreferences>): Promise<void> {
  const patch = preferenceOverridesSchema.parse(update);
  localVersion += 1;
  preferences = { ...preferences, ...patch };
  publish();
  return enqueue((values) => ({
    preferences: { ...values.preferences, ...patch },
    legacyMigrated: true,
  }));
}

export function resetEnhancerPreferences(): Promise<void> {
  localVersion += 1;
  preferences = { ...DEFAULT_PREFERENCES };
  publish();
  // SDK reset would also clear the migration marker, so write an empty set of
  // explicit choices instead. Each platform then uses its own defaults.
  return enqueue(() => ({ preferences: {}, legacyMigrated: true }));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useEnhancerPreferences(): EnhancerPreferences {
  return useSyncExternalStore(subscribe, getEnhancerPreferences, getEnhancerPreferences);
}

export function useEnhancerPreferencesError(): string | null {
  return useSyncExternalStore(subscribe, getEnhancerPreferencesError, getEnhancerPreferencesError);
}
