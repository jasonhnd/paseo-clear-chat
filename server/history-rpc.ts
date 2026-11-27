import type { PluginServerContext } from "@getpaseo/plugin/server";
import { historyDayRpc, historyDaysRpc } from "../shared/history-rpc";
import { listHistoryConversations } from "./history-conversations";
import { readHistoryDay, readHistoryDays } from "./history-reader";

/**
 * The two history RPCs, registered only when the host accepts them.
 *
 * Registration is additive: a host without `handle`, or with a `handle` that refuses this
 * contract shape, keeps settings and every other feature, and the client wrapper reports the
 * reader as unsupported instead of the plugin failing to load. The same goes for the
 * handler's own work: when `context.paseo.agents.list` fails, the call rejects, which the
 * client wrapper turns into an error state.
 *
 * Both contracts have the same shape, so a host that accepts the first accepts the second.
 * Paseo's plugin context has no way to withdraw a registered contract, so a host that refused
 * the second would leave the first registered. The handlers share a completion flag set only
 * after both registrations succeed; an incomplete registration refuses every call, so the
 * daemon never serves half a surface. The client also asks for both calls or neither
 * (`createHistorySource` reports unsupported unless both exist).
 */

export interface HistoryHandlerOptions {
  /** Injected by tests so no test ever opens the real Hermes data directory. */
  root?: string;
}

export function registerHistoryHandlers(
  server: Pick<PluginServerContext, "handle"> | null | undefined,
  options: HistoryHandlerOptions = {},
): boolean {
  if (!server || typeof server.handle !== "function") return false;
  // Set only after both registrations succeed; a handler that runs before then refuses.
  const registration = { complete: false };
  try {
    server.handle(historyDaysRpc, async (input, context) => {
      requireCompleteRegistration(registration);
      const { conversations, directoryPartial } = await listHistoryConversations(context.paseo);
      return {
        ...readHistoryDays({ conversations, root: options.root, timeZone: input.timeZone }),
        directoryPartial,
      };
    });
    server.handle(historyDayRpc, async (input, context) => {
      requireCompleteRegistration(registration);
      const { conversations, directoryPartial } = await listHistoryConversations(context.paseo);
      return {
        ...readHistoryDay({
          conversations,
          root: options.root,
          timeZone: input.timeZone,
          day: input.day,
        }),
        directoryPartial,
      };
    });
    registration.complete = true;
    return true;
  } catch {
    // A host can expose `handle` for its own contract set and reject these methods. The
    // reader then stays unavailable; nothing else in the plugin depends on it.
    registration.complete = false;
    return false;
  }
}

function requireCompleteRegistration(registration: { complete: boolean }): void {
  if (!registration.complete) throw new Error("Clear Chat history reader is unavailable");
}
