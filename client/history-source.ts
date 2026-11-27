import {
  historyDayRpc,
  historyDaysRpc,
  type HistoryDayResult,
  type HistoryDaysResult,
} from "../shared/history-rpc";

/**
 * The client's side of the history RPCs.
 *
 * A surface wires the two `useRpc` results in and gets states back, never exceptions:
 *
 *     const days = useRpc(historyDaysRpc);
 *     const day = useRpc(historyDayRpc);
 *     const source = createHistorySource({ days, day });
 *
 * `unsupported` means this host cannot answer at all (no RPC surface, or the daemon refused
 * the method). `error` means the call ran and failed, or the answer did not match the
 * contract. Both let the calendar fall back to the timeline path without a broken screen.
 */

export type HistoryStatus<Snapshot> =
  | { status: "ready"; snapshot: Snapshot }
  | { status: "unsupported" }
  | { status: "error" };

export type HistoryDaysState = HistoryStatus<HistoryDaysResult>;
export type HistoryDayState = HistoryStatus<HistoryDayResult>;

/** The two RPC calls, as `useRpc(contract)` returns them. */
export interface HistoryCalls {
  days?: (input: { timeZone: string }) => Promise<unknown>;
  day?: (input: { day: string; timeZone: string }) => Promise<unknown>;
}

export interface HistorySource {
  /** The zone sent with every call; the daemon falls back to its own clock if unknown. */
  readonly timeZone: string;
  days(): Promise<HistoryDaysState>;
  day(day: string): Promise<HistoryDayState>;
}

export function createHistorySource(
  calls: HistoryCalls | null | undefined,
  timeZone: string = defaultTimeZone(),
): HistorySource {
  const zone = timeZone.trim() || defaultTimeZone();
  return {
    timeZone: zone,
    days() {
      return request(calls?.days, historyDaysRpc.output, { timeZone: zone });
    },
    day(day) {
      return request(calls?.day, historyDayRpc.output, { day, timeZone: zone });
    },
  };
}

/** The reader's zone as this device spells it, with a safe fallback for old engines. */
export function defaultTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.trim() ? zone : "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * True when a failure means "this host has no such method" rather than "the read failed".
 * The host's wording is not part of the contract, so this matches the shapes a missing
 * plugin method has used; anything else stays a plain error.
 */
export function isUnsupportedMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message
    : typeof error === "string" ? error : "";
  return /not supported|unsupported|unknown (?:method|rpc)|method not found|no such (?:method|handler)|no handler/i
    .test(message);
}

interface ParsedSchema<Snapshot> {
  safeParse(value: unknown): { success: true; data: Snapshot } | { success: false };
}

async function request<Snapshot>(
  invoke: ((input: never) => Promise<unknown>) | undefined,
  schema: ParsedSchema<Snapshot>,
  input: unknown,
): Promise<HistoryStatus<Snapshot>> {
  if (typeof invoke !== "function") return { status: "unsupported" };
  let value: unknown;
  try {
    value = await invoke(input as never);
  } catch (error) {
    return isUnsupportedMethod(error) ? { status: "unsupported" } : { status: "error" };
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? { status: "ready", snapshot: parsed.data } : { status: "error" };
}
