import React from "react";
import { usePaseo, type PluginScreenProps } from "@getpaseo/plugin/client";
import { localDateKey } from "../local-day";
import type { HistorySource } from "../history-source";
import { nowMs } from "../my-messages-clock";
import {
  createMyMessagesCalendarFeed,
  emptyCalendarSnapshot,
  type MyMessagesCalendarSnapshot,
} from "../my-messages-calendar-feed";
import type { createMyMessagesScreenFeed } from "../my-messages-screen-feed";
import type { MyMessagesComposerHost } from "../my-messages-actions";
import { MyMessagesCalendarScreen } from "./my-messages-calendar-screen";
import { MyMessagesTodayScreen } from "./my-messages-today-screen";

type TodayFeed = ReturnType<typeof createMyMessagesScreenFeed>;
type CalendarFeed = ReturnType<typeof createMyMessagesCalendarFeed>;

interface ScreenCapabilities {
  navigation?: {
    openAgent?: (input: { agentId: string; serverId?: string; focusHost?: boolean }) => void;
  };
  composerHost?: MyMessagesComposerHost;
}

type Props = PluginScreenProps & ScreenCapabilities & {
  feed: TodayFeed;
  calendarFeed: CalendarFeed;
  history: HistorySource;
};

/**
 * The "What I said" screen.
 *
 * The calendar is the normal shape. When the host cannot answer the daily-count RPC at all,
 * the feed reports `fallback` and the previous today-only page takes over, so an older host
 * keeps a working screen instead of an empty grid.
 */
export function MyMessagesScreen(props: Props) {
  const { calendarFeed, history, host } = props;
  const { agents } = usePaseo();
  const agentsRef = React.useRef(agents);
  agentsRef.current = agents;
  const [snapshot, setSnapshot] = React.useState<MyMessagesCalendarSnapshot>(
    () => emptyCalendarSnapshot(localDateKey(nowMs()), history.timeZone),
  );
  const session = React.useRef<ReturnType<CalendarFeed["mount"]> | null>(null);

  React.useEffect(() => {
    if (!history.available) return;
    const mounted = calendarFeed.mount({
      hostId: host.id,
      agents: agentsRef.current,
      history,
      publish: setSnapshot,
    });
    session.current = mounted;
    return () => {
      session.current = null;
      mounted.stop();
    };
  }, [calendarFeed, history, host.id]);

  const actions = React.useMemo(() => ({
    select: (day: string) => session.current?.select(day),
    refresh: () => session.current?.refresh(),
    retry: () => session.current?.retry(),
  }), []);

  if (!history.available || snapshot.mode === "fallback") {
    return <MyMessagesTodayScreen {...props} feed={props.feed} />;
  }
  return <MyMessagesCalendarScreen {...props} snapshot={snapshot} actions={actions} />;
}
