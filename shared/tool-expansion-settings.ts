import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_EXPANSION_ENTRIES = 1000;
const expansionEntry = z.object({ expanded: z.boolean(), updatedAt: z.number().finite() });
export type ExpansionEntries = Record<string, z.output<typeof expansionEntry>>;

export function pruneExpansionEntries(entries: ExpansionEntries): ExpansionEntries {
  return Object.fromEntries(Object.entries(entries)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt || a[0].localeCompare(b[0]))
    .slice(0, MAX_EXPANSION_ENTRIES));
}

// Separate from presentation preferences: frequent disclosure edits never
// contend with a font or theme change. Only identities and choices are saved.
export const toolExpansionSettings = defineSettings({
  id: "tool-expansion",
  scope: "host",
  version: 1,
  schema: z.object({
    entries: z.record(z.string(), expansionEntry).default({}).transform(pruneExpansionEntries),
  }),
});

export type ToolExpansionSettings = z.output<typeof toolExpansionSettings.schema>;
export const toolExpansionSettingsRpc = settingsRpc(toolExpansionSettings.id);
