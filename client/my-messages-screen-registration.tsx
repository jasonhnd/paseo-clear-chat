import { useTranslation, type PluginClientContext, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { MyMessagesScreen } from "./components/my-messages-screen";
import { messages } from "./messages";
import type { MyMessagesComposerHost } from "./my-messages-actions";
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
  const title = messages.message("myMessages.title");
  const removeScreen = client.addScreen({
    id: SCREEN_ID,
    title,
    Component: props => <MyMessagesScreen key={props.host.id} {...props} feed={feed} composerHost={client} />,
  });
  const removeSidebar = client.addSidebarHeaderItem({ id: SCREEN_ID, title, Component: MyMessagesSidebarItem });
  return async () => {
    feed.stop();
    try {
      await removeSidebar();
    } finally {
      await removeScreen();
    }
  };
}
