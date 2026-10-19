import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Store explicit choices only so resets can restore defaults without replaying
// legacy browser settings. Text size is shared by all clients of this host.
export const preferenceOverridesSchema = z.object({
  accent: z.enum(["host", "jade", "violet", "amber", "rose"]).optional(),
  uiFont: z.enum(["inter", "system"]).optional(),
  codeFont: z.enum(["code", "plain"]).optional(),
  textScale: z.number().transform((value) => Math.min(1.35, Math.max(0.85, value))).optional(),
  frostedGlass: z.boolean().optional(),
  pointerGlow: z.boolean().optional(),
  enhancedUserBubble: z.boolean().optional(),
  selectionActions: z.boolean().optional(),
  assistantMarkdown: z.boolean().optional(),
  markdownVariant: z.enum(["document", "compact", "terminal"]).optional(),
});

export const presentationSettings = defineSettings({
  id: "presentation",
  scope: "host",
  version: 1,
  schema: z.object({
    preferences: preferenceOverridesSchema.default({}),
    legacyMigrated: z.boolean().default(false),
  }),
});

export type PreferenceOverrides = z.output<typeof preferenceOverridesSchema>;
export type PresentationSettings = z.output<typeof presentationSettings.schema>;
export const presentationSettingsRpc = settingsRpc(presentationSettings.id);
