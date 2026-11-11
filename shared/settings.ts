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
  foldMessagePrefixes: z.string().optional(),
  selectionActions: z.boolean().optional(),
  assistantMarkdown: z.boolean().optional(),
  codeBlockOpen: z.boolean().optional(),
  markdownVariant: z.enum(["document", "compact", "terminal"]).optional(),
  foldFinishedSteps: z.boolean().optional(),
  collapsedStepAction: z.enum(["details", "inline"]).optional(),
  foldLongOutputAfter: z.union([z.literal(10), z.literal(15), z.literal(30), z.literal("never")]).optional(),
  answerStyle: z.enum(["none", "concise", "formal", "casual", "oneLine"]).optional(),
  savedReplies: z.array(z.string()).optional(),
  autoFillAnswer: z.boolean().optional(),
  showAnswerCard: z.boolean().optional(),
  showJumpChips: z.boolean().optional(),
  keepItemLineBreaks: z.boolean().optional(),
  dismissedOptionReplies: z.array(z.object({ agentId: z.string(), at: z.number().finite() })).max(100).optional(),
  delegatedTools: z.string().optional(),
  delegatedCodeBlocks: z.string().optional(),
  hiddenTools: z.string().optional(),
});

// Unfinished answer-card drafts survive a reload here. One entry per card
// (agent plus reply timestamp); the value carries its own schema number so a
// shape change can drop old entries instead of migrating or guessing.
export const answerDraftSchema = z.object({
  schema: z.literal(1),
  choices: z.record(z.string(), z.string()).default({}),
  customDrafts: z.record(z.string(), z.string()).default({}),
  customOpen: z.record(z.string(), z.boolean()).default({}),
  activeQuestion: z.number().int().min(0).default(0),
  block: z.string().optional(),
});

export type AnswerDraft = z.output<typeof answerDraftSchema>;

const presentationSchema = z.object({
  preferences: preferenceOverridesSchema.default({}),
  legacyMigrated: z.boolean().default(false),
  answerDrafts: z.record(z.string(), answerDraftSchema).optional(),
});

export const presentationSettings = defineSettings({
  id: "presentation",
  scope: "host",
  version: 2,
  schema: presentationSchema,
  // Version 1 and 2 values remain explicit choices. Drafts are an optional field
  // so older clients strip them instead of failing the schema.
  migrate: (values) => presentationSchema.parse(values),
});

export type PreferenceOverrides = z.output<typeof preferenceOverridesSchema>;
export type PresentationSettings = z.output<typeof presentationSettings.schema>;
export const presentationSettingsRpc = settingsRpc(presentationSettings.id);

export const hermesCcSettings = defineSettings({
  id: "hermes-cc",
  scope: "host",
  version: 1,
  schema: z.object({ enabled: z.boolean().default(true) }),
});
