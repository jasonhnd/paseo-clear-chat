import { z } from "zod";

export const turnWindowFileStatsSchema = z.object({
  added: z.number().nullable(),
  deleted: z.number().nullable(),
  binary: z.boolean(),
  renamedFrom: z.string().nullable(),
  diff: z.string().nullable(),
  truncated: z.boolean(),
  note: z.string().nullable(),
});

/**
 * Payload contract for the turn-window timeline item.
 *
 * The host validates item.data with this schema BEFORE the renderer runs, and zod
 * strips unknown keys, so every field the server emits has to be declared here.
 * Adding a field on the server without extending this schema silently drops it.
 */
export const turnWindowItemSchema = z.object({
  files: z.array(z.string()),
  details: z.record(z.string(), turnWindowFileStatsSchema).optional().default({}),
  message: z.string().nullable(),
  warning: z.string().nullable(),
  incomplete: z.boolean(),
  messageCode: z.string().nullable().optional(),
  warningCode: z.string().nullable().optional(),
});

export type TurnWindowItemPayload = z.infer<typeof turnWindowItemSchema>;
