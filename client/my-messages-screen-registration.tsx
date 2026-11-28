import React from "react";
import { useRpc, useTranslation, type PluginClientContext, type PluginScreenProps, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { historyDayRpc, historyDaysRpc } from "../shared/history-rpc";
import { createHistorySource } from "./history-source";
import { MyMessagesScreen } from "./components/my-messages-screen";
import { messages } from "./messages";
import type { MyMessagesComposerHost } from "./my-messages-actions";
import { createMyMessagesCalendarFeed } from "./my-messages-calendar-feed";
import { createMyMessagesScreenFeed } from "./my-messages-screen-feed";

const SCREEN_ID = "my-messages-today";
let warnedMissingApis = false;

function MyMessagesSidebarItem({ openScreen, currentScreen }: PluginSidebarItemProps) {
  const { t } = useTranslation(messages);
  return (
    <SidebarRow icon="MessageSquare" label={t("myMessages.title")}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openScreen({ screenId: SCREEN_ID })}
    />
  );
}

export function registerMyMessagesScreen(client: Partial<Pick<PluginClientContext, "addScreen" | "addSidebarHeaderItem">> & MyMessagesComposerHost) {
  if (typeof client.addScreen !== "function" || typeof client.addSidebarHeaderItem !== "function") {
    if (!warnedMissingApis) {
      warnedMissingApis = true;
      console.warn("Clear Chat What I said screen is unavailable: this host has no screen or sidebar header API");
    }
    return () => {};
  }

  const feed = createMyMessagesScreenFeed();
  const calendarFeed = createMyMessagesCalendarFeed();
  const title = messages.message("myMessages.title");

  function Screen(props: PluginScreenProps) {
    const days = useRpc(historyDaysRpc);
    const day = useRpc(historyDayRpc);
    const history = React.useMemo(() => createHistorySource({ days, day }), [days, day]);
    return <MyMessagesScreen {...props} feed={feed} calendarFeed={calendarFeed} history={history} composerHost={client} />;
  }

  const removeScreen = client.addScreen({
    id: SCREEN_ID,
    title,
    Component: props => <Screen key={props.host.id} {...props} />,
  });
  const removeSidebar = client.addSidebarHeaderItem({ id: SCREEN_ID, title, Component: MyMessagesSidebarItem });
  return async () => {
    calendarFeed.stop();
    feed.stop();
    try {
      await removeSidebar();
    } finally {
      await removeScreen();
    }
  };
}
