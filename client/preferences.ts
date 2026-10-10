import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
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
   * Paseo maps a stream item to the plugin timeline item before any transformer
   * runs, and that mapping carries only the text. Pasted images therefore never
   * reach plugin code, so the enhanced bubble cannot draw them. Turning this off
   * hands prompts back to the host, whose own bubble still shows them.
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
}

const STORAGE_KEY = "paseo/beautiful-chat/preferences/v1";

export const DEFAULT_PREFERENCES: Readonly<EnhancerPreferences> = {
  accent: "host",
  uiFont: "inter",
  codeFont: "code",
  textScale: 1,
  frostedGlass: true,
  pointerGlow: true,
  enhancedUserBubble: Platform.OS !== "ios",
  selectionActions: true,
  assistantMarkdown: Platform.OS !== "ios",
  markdownVariant: "document",
};

const listeners = new Set<() => void>();

function storage(): Storage | undefined {
  const candidate = globalThis as typeof globalThis & { localStorage?: Storage };
  return candidate.localStorage;
}

function loadLegacyPreferences(): PreferenceOverrides | undefined {
  try {
    const legacyStorage = storage();
    if (!legacyStorage) return undefined;
    const stored = legacyStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const candidate: unknown = JSON.parse(stored);
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};
    const valid: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(preferenceOverridesSchema.shape)) {
      // Text size is a new host-only preference; never import it from localStorage.
      if (key === "textScale") continue;
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
  if (!invoke) throw new Error("Preference storage is not connected to a host.");
  // Every write merges against a fresh revision. Retry bounded conflicts so
  // another client's unrelated changes are retained rather than overwritten.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await invoke(presentationSettingsRpc.read, {});
    if (result.status !== "ready") throw new Error(result.error);
    const current = presentationSettings.schema.parse(result.values);
    const next = change(current);
    if (next === current) return current;
    const saved = await invoke(presentationSettingsRpc.write, {
      revision: result.revision,
      values: next,
    });
    if (saved.status === "saved") return presentationSettings.schema.parse(saved.values);
    if (saved.status === "invalid") throw new Error(saved.error);
  }
  throw new Error("Preferences changed in another client. Please try again.");
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
    storageError = error instanceof Error ? error.message : String(error);
    publish();
  });
  return pending;
}

export function initializeEnhancerPreferences(rpc: PluginClientContext["rpc"]): Promise<void> {
  invoke = rpc;
  return enqueue((values) => {
    if (values.legacyMigrated) return values;
    const legacy = loadLegacyPreferences();
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
