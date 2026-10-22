import { defineSettings, settingsRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const customAccentSchema = z.string().trim()
  .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, "Enter a HEX colour as #RGB or #RRGGBB.")
  .transform((value) => {
    const hex = value.slice(1).toLowerCase();
    return `#${hex.length === 3 ? [...hex].map((channel) => channel + channel).join("") : hex}`;
  });

// Store explicit choices only so resets can restore defaults without replaying
// legacy browser settings. Text size is shared by all clients of this host.
export const preferenceOverridesSchema = z.object({
  accent: z.enum(["host", "jade", "violet", "amber", "rose"]).optional(),
  // Keep the existing enum readable by older clients; they ignore these fields.
  customAccent: customAccentSchema.optional(),
  customAccentEnabled: z.boolean().optional(),
  uiFont: z.enum(["inter", "system"]).optional(),
  codeFont: z.enum(["code", "plain"]).optional(),
  codeFontFamily: z.enum(["host", "iosevka", "menlo", "consolas", "fira-code", "cascadia-code"]).optional(),
  textScale: z.number().transform((value) => Math.min(1.35, Math.max(0.85, value))).optional(),
  frostedGlass: z.boolean().optional(),
  pointerGlow: z.boolean().optional(),
  enhancedUserBubble: z.boolean().optional(),
  selectionActions: z.boolean().optional(),
  assistantMarkdown: z.boolean().optional(),
  markdownVariant: z.enum(["document", "compact", "terminal"]).optional(),
  foldFinishedSteps: z.boolean().optional(),
  collapsedStepAction: z.enum(["details", "inline"]).optional(),
  foldLongOutputAfter: z.union([z.literal(10), z.literal(15), z.literal(30), z.literal("never")]).optional(),
});

const presentationSchema = z.object({
  preferences: preferenceOverridesSchema.default({}),
  legacyMigrated: z.boolean().default(false),
});

export const presentationSettings = defineSettings({
  id: "presentation",
  scope: "host",
  version: 2,
  schema: presentationSchema,
  // Version 1 values remain explicit choices. New options use client defaults.
  migrate: (values) => presentationSchema.parse(values),
});

export type PreferenceOverrides = z.output<typeof preferenceOverridesSchema>;
export type PresentationSettings = z.output<typeof presentationSettings.schema>;
export const presentationSettingsRpc = settingsRpc(presentationSettings.id);
