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
 * `unsupported` means this host cannot answer at all: there is no call to make (no RPC
 * surface, or one of the two methods is missing) or the failure carries an explicit
 * unknown-method code. `error` means the call ran and failed, or the answer did not match the
 * contract. Both let the calendar fall back to the timeline path without a broken screen.
 *
 * The source asks for both calls or neither: a host that offers only one method would
 * otherwise show a calendar whose day view silently disagrees with its counts.
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
  // Both or neither: one missing method makes the whole surface unsupported.
  const both = typeof calls?.days === "function" && typeof calls?.day === "function";
  const invokeDays = both ? calls?.days : undefined;
  const invokeDay = both ? calls?.day : undefined;
  return {
    timeZone: zone,
    days() {
      return request(invokeDays, historyDaysRpc.output, { timeZone: zone });
    },
    day(day) {
      return request(invokeDay, historyDayRpc.output, { day, timeZone: zone });
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
 * Codes that mean "this host has no such method". Paseo surfaces a failed RPC as a
 * `DaemonRpcError` whose `code` comes from the `rpc_error` payload; the daemon also reports
 * an unregistered plugin method as `handler_error`, which is a failed call, not a missing
 * surface. Reading the code (never the message) keeps an ordinary read failure from being
 * mistaken for an old host.
 */
const UNKNOWN_METHOD_CODES = new Set([
  "METHOD_NOT_FOUND",
  "PLUGIN_RPC_METHOD_NOT_FOUND",
  "UNKNOWN_METHOD",
  "UNSUPPORTED_METHOD",
]);

export function isUnsupportedMethod(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && UNKNOWN_METHOD_CODES.has(code);
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
