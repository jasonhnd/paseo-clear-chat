import { translate as t } from "../translation";
import { useState } from "react";
import { Platform, useWindowDimensions } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { revealPathRpc } from "../../shared/file-rpc";
import { DESKTOP_MIN } from "../breakpoints";
import { isAbsoluteFilePath } from "../file-path-links";

export function useReplyFilePath(cwd?: string | null) {
  const reveal = useRpc(revealPathRpc);
  const toast = useToast();
  const { width } = useWindowDimensions();
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const copy = Platform.OS !== "web" || width < DESKTOP_MIN;
  const openFilePath = async (path: string) => {
    if (copy) {
      try {
        await copyText(path);
        toast.show(t("toast.pathCopied"), { variant: "success" });
      } catch {
        setFallbackText(path);
        toast.error(t("toast.copyFailed"));
      }
      return;
    }
    if (!cwd && !isAbsoluteFilePath(path)) {
      toast.error(t("toast.cwdMissing"));
      return;
    }
    try {
      const result = await reveal({ cwd: cwd ?? "", path });
      if (!result.revealed) toast.error(t("toast.pathUnopened"));
    } catch {
      toast.error(t("toast.pathHostDown"));
    }
  };
  return { openFilePath, copy, fallbackText, setFallbackText };
}
