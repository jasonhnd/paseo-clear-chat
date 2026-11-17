import { useTranslation } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { messages } from "../messages";

const storageKey = "clear-chat.sidebar-view-hint-shown";
let shownInSession = false;

export function SidebarHintItem() {
  const { t } = useTranslation(messages);
  const toast = useToast();
  useEffect(() => {
    if (shownInSession) return;
    try {
      if (globalThis.localStorage?.getItem(storageKey) === "1") return;
      globalThis.localStorage?.setItem(storageKey, "1");
    } catch {
      // Storage may be unavailable; still limit the hint to this session.
    }
    shownInSession = true;
    toast.show(t("toast.sidebarViewHint"));
  }, [t, toast]);
  return null;
}
