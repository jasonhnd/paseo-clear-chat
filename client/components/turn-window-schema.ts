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

/** Timeline payload for a turn-window snapshot. Legacy items have no `details`. */
export const turnWindowItemSchema = z.object({
  files: z.array(z.string()),
  details: z.record(z.string(), turnWindowFileStatsSchema).optional().default({}),
  message: z.string().nullable(),
  warning: z.string().nullable(),
  incomplete: z.boolean(),
});
