/** Shared contract; the durable implementation is supplied by the history store. */
export interface HermesCcJournalKey { providerId: string; nativeSessionId: string }

export type HermesCcJournalState =
  | { status: "complete"; events: readonly unknown[] } // Recorded from creation, settled, never invalidated.
  | { status: "unusable"; reason: string }; // Missing, incomplete, invalidated, corrupt, over cap or schema mismatch.

export interface HermesCcHistoryStore {
  /** Start only for a newly created session; fail if a journal already exists. */
  start(key: HermesCcJournalKey): Promise<void>;
  /** Append final events in order and fsync; no-op for missing or invalidated journals. */
  append(key: HermesCcJournalKey, event: unknown): Promise<void>;
  /** A journal with an admitted, unsettled turn is unusable. */
  turnStarted(key: HermesCcJournalKey): Promise<void>;
  turnSettled(key: HermesCcJournalKey): Promise<void>;
  /** Permanently mark the journal unusable. */
  invalidate(key: HermesCcJournalKey, reason: string): Promise<void>;
  read(key: HermesCcJournalKey): Promise<HermesCcJournalState>;
}
