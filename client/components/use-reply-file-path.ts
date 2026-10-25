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
        toast.show("Path copied. Open it on the host computer.", { variant: "success" });
      } catch {
        setFallbackText(path);
        toast.error("Could not copy. Select all the text in the dialog and use Copy.");
      }
      return;
    }
    if (!cwd && !isAbsoluteFilePath(path)) {
      toast.error("The session working directory is unavailable. Copy the path and open it on the host computer.");
      return;
    }
    try {
      const result = await reveal({ cwd: cwd ?? "", path });
      if (!result.revealed) toast.error("The path could not be opened on the host. It may not exist or may be inaccessible.");
    } catch {
      toast.error("The path could not be opened on the host. Try again when the host is connected.");
    }
  };
  return { openFilePath, copy, fallbackText, setFallbackText };
}
