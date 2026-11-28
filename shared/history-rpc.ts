import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Contracts for the read-only history reader.
 *
 * Two questions cross the plugin boundary, and both carry the reader's own time zone: the
 * number of messages a person typed on each local day, and what those messages were on one
 * day. The daemon answers from Hermes's SQLite history without replaying a conversation, so
 * a day boundary must follow the reader's clock, not the daemon's.
 */

/** `YYYY-MM-DD`. The reader still filters rows by the zone day, so shape is all this checks. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** `YYYY-MM`, a local month. */
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);

export const historyDaysInputSchema = z.object({
  timeZone: z.string().min(1).max(64),
});

export const historyDayCountSchema = z.object({
  day: daySchema,
  count: z.number().int().nonnegative(),
});

/**
 * One conversation's messages in one local month, counted from the same merged records
 * the day cells are drawn from. `lastAt` only breaks count ties in the "most talked-to"
 * list: the conversation that spoke more recently comes first.
 */
export const historyConversationMonthSchema = z.object({
  month: monthSchema,
  agentId: z.string(),
  title: z.string().nullable(),
  count: z.number().int().nonnegative(),
  lastAt: z.number().finite(),
});

export const historyDaysResultSchema = z.object({
  /** Only days with at least one message, oldest first. */
  days: z.array(historyDayCountSchema),
  firstDay: daySchema.nullable(),
  lastDay: daySchema.nullable(),
  /**
   * Per conversation, per month counts for the left panel. Optional so a host that
   * predates the left panel still answers; the client then marks the ranking incomplete.
   */
  conversationMonths: z.array(historyConversationMonthSchema).optional(),
  /** Conversations the fast path could read, and the ones it could not. */
  fastConversations: z.number().int().nonnegative(),
  slowConversationIds: z.array(z.string()),
  /** Hermes databases that were open but unreadable, named relative to the Hermes root. */
  skippedDatabases: z.array(z.string()),
  /** True when the conversation directory hit its page limit before the last page. */
  directoryPartial: z.boolean(),
  /** Rows from sessions this fast read did not complete (Hermes deleted or could not read them). */
  fromCache: z.number().int().nonnegative(),
  /** The archive could not be read or written; the answer is the fast read alone. */
  cacheError: z.boolean().optional(),
  /** UTC months where the size cap made new records count-only. */
  cacheFull: z.array(z.string()).optional(),
  readMs: z.number().nonnegative(),
});

export const historyDayInputSchema = z.object({
  day: daySchema,
  timeZone: z.string().min(1).max(64),
});

export const historyDayRowSchema = z.object({
  agentId: z.string(),
  /** Milliseconds since the epoch. */
  at: z.number().finite(),
  text: z.string(),
});

export const historyDayResultSchema = z.object({
  /** Newest first. */
  rows: z.array(historyDayRowSchema),
  /** True when the conversation directory hit its page limit before the last page. */
  directoryPartial: z.boolean(),
  /** Rows from sessions this fast read did not complete (Hermes deleted or could not read them). */
  fromCache: z.number().int().nonnegative(),
  /** The archive could not be read or written; the answer is the fast read alone. */
  cacheError: z.boolean().optional(),
  /** UTC months where the size cap made new records count-only. */
  cacheFull: z.array(z.string()).optional(),
});

export const historyDaysRpc = defineRpc({
  name: "history.days",
  input: historyDaysInputSchema,
  output: historyDaysResultSchema,
});

export const historyDayRpc = defineRpc({
  name: "history.day",
  input: historyDayInputSchema,
  output: historyDayResultSchema,
});

export type HistoryDaysInput = z.output<typeof historyDaysInputSchema>;
export type HistoryDayInput = z.output<typeof historyDayInputSchema>;
export type HistoryDayCount = z.output<typeof historyDayCountSchema>;
export type HistoryConversationMonth = z.output<typeof historyConversationMonthSchema>;
export type HistoryDaysResult = z.output<typeof historyDaysResultSchema>;
export type HistoryDayRow = z.output<typeof historyDayRowSchema>;
export type HistoryDayResult = z.output<typeof historyDayResultSchema>;
