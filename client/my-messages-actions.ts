import { useRef } from "react";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";

interface QuoteComposer {
  focus(): Promise<void>;
  insertText(text: string): void;
}

export interface MyMessagesComposerHost {
  composers?: (selector: { agentId: string } | { focused: true }) => readonly QuoteComposer[];
}

type Feedback = "myMessages.noText" | "myMessages.copied" | "myMessages.quoteCopied" | "myMessages.copyFailed";

export function useMyMessageActions(t: (key: Feedback) => string, host?: MyMessagesComposerHost) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  async function copyWithFeedback(text: string, feedback: "myMessages.copied" | "myMessages.quoteCopied") {
    try {
      await copyText(text);
      toastRef.current.show(t(feedback), { variant: "success" });
    } catch {
      toastRef.current.error(t("myMessages.copyFailed"));
    }
  }

  function copy(text: string, empty: boolean) {
    if (empty) {
      toastRef.current.show(t("myMessages.noText"), { variant: "info" });
      return;
    }
    return copyWithFeedback(text, "myMessages.copied");
  }

  async function quote(text: string, agentId?: string, openConversation?: () => void) {
    const quoted = text.split(/\r\n|\r|\n/).map(line => line === "" ? ">" : `> ${line}`).join("\n") + "\n\n";
    try {
      const composer = agentId && typeof host?.composers === "function" ? host.composers({ agentId })[0] : undefined;
      if (typeof composer?.focus === "function" && typeof composer.insertText === "function") {
        await composer.focus();
        composer.insertText(quoted);
        return;
      }
    } catch {
      // An unavailable composer still leaves a quote the reader can paste.
    }
    try {
      openConversation?.();
    } catch {
      // A navigation failure must not prevent copying the quote.
    }
    await copyWithFeedback(quoted, "myMessages.quoteCopied");
  }

  return { copy, quote };
}
