import { z } from "zod";

/**
 * Payload contract for the turn-window timeline item.
 *
 * The host validates item.data with this schema BEFORE the renderer runs, and zod
 * strips unknown keys, so every field the server emits has to be declared here.
 * Adding a field on the server without extending this schema silently drops it.
 */
export const turnWindowItemSchema = z.object({
  files: z.array(z.string()),
  message: z.string().nullable(),
  warning: z.string().nullable(),
  incomplete: z.boolean(),
  messageCode: z.string().nullable().optional(),
  warningCode: z.string().nullable().optional(),
});

export type TurnWindowItemPayload = z.infer<typeof turnWindowItemSchema>;
