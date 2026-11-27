import { useRef } from "react";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { isEmptyMessageText } from "./user-message-kind";

interface QuoteComposer {
  focus(): Promise<void>;
  insertText(text: string): void;
}

export interface MyMessagesComposerHost {
  composers?: (selector: { agentId: string } | { focused: true }) => readonly QuoteComposer[];
}

type Feedback = "myMessages.noText" | "myMessages.copied" | "myMessages.quoteCopied" | "myMessages.copyFailed";

/**
 * The message as a Markdown quote: blank lines around it are dropped, every line starts with
 * `> ` (a blank line becomes `>`), and one empty line follows so the reader can type below it.
 */
export function quoteLines(text: string): string {
  const body = text.replace(/^(?:[ \t]*(?:\r\n|\r|\n))+/, "").replace(/(?:(?:\r\n|\r|\n)[ \t]*)+$/, "");
  return body.split(/\r\n|\r|\n/).map(line => line.trim() === "" ? ">" : `> ${line}`).join("\n") + "\n\n";
}

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
    if (isEmptyMessageText(text)) {
      toastRef.current.show(t("myMessages.noText"), { variant: "info" });
      return;
    }
    const quoted = quoteLines(text);
    try {
      const composer = agentId && typeof host?.composers === "function" ? host.composers({ agentId })[0] : undefined;
      if (typeof composer?.focus === "function" && typeof composer.insertText === "function") {
        await composer.focus();
        // Focusing may open another tab; ask again so the text goes to the live composer.
        const live = host?.composers?.({ agentId: agentId as string })[0];
        (typeof live?.insertText === "function" ? live : composer).insertText(quoted);
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
