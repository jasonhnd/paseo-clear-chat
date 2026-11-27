import { useRef } from "react";
import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { isEmptyMessageText } from "../shared/user-message-kind";

interface QuoteComposer {
  focus(): Promise<void>;
  insertText(text: string): void;
  /** Present on the host composer. Absent on an older host. */
  prompt?: string;
  /** Present when the host reports a cursor. Absent means the insert lands at the end. */
  selection?: { start: number; end: number } | null;
}

export interface MyMessagesComposerHost {
  composers?: (selector: { agentId: string }) => readonly QuoteComposer[];
}

type Feedback = "myMessages.noText" | "myMessages.copied" | "myMessages.quoteCopied" | "myMessages.copyFailed" | "myMessages.quoteNoText";

/**
 * The message as a Markdown quote: blank lines around it are dropped, every line starts with
 * `> ` (a blank line becomes `>`), and one empty line follows so the reader can type below it.
 */
function quoteLines(text: string): string {
  // Line by line, so the time stays linear however many line breaks the message carries.
  const lines = text.split(/\r\n|\r|\n/);
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end).map(line => line.trim() === "" ? ">" : `> ${line}`).join("\n") + "\n\n";
}

/** How many line breaks sit at the end of `text`, counting `\r\n` as one. */
function trailingBreaks(text: string): number {
  let count = 0;
  let index = text.length;
  while (index > 0) {
    if (index >= 2 && text[index - 2] === "\r" && text[index - 1] === "\n") {
      count += 1;
      index -= 2;
    } else if (text[index - 1] === "\n" || text[index - 1] === "\r") {
      count += 1;
      index -= 1;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Newlines to put in front of a quote so it does not stick to the draft.
 * Nothing before the cursor stays as it is. One break gets one more. Two or more
 * already leave a blank line.
 */
function gapBeforeQuote(before: string): string {
  if (before.length === 0) return "";
  const breaks = trailingBreaks(before);
  if (breaks >= 2) return "";
  if (breaks === 1) return "\n";
  return "\n\n";
}

function textBeforeInsert(composer: QuoteComposer): string {
  const prompt = typeof composer.prompt === "string" ? composer.prompt : "";
  const start = composer.selection?.start;
  if (typeof start === "number" && Number.isFinite(start)) {
    const index = Math.max(0, Math.min(prompt.length, Math.trunc(start)));
    return prompt.slice(0, index);
  }
  return prompt;
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

  async function quote(text: string, agentId: string, openConversation?: () => void) {
    if (isEmptyMessageText(text)) {
      toastRef.current.show(t("myMessages.quoteNoText"), { variant: "info" });
      return;
    }
    const quoted = quoteLines(text);
    try {
      const composer = typeof host?.composers === "function" ? host.composers({ agentId })[0] : undefined;
      if (typeof composer?.focus === "function" && typeof composer.insertText === "function") {
        await composer.focus();
        // Focusing may open another tab; ask again so the text goes to the live composer.
        const live = host?.composers?.({ agentId })[0];
        const target = typeof live?.insertText === "function" ? live : composer;
        target.insertText(gapBeforeQuote(textBeforeInsert(target)) + quoted);
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
