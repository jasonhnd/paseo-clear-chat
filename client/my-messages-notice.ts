/**
 * The one place the registration can say something to the reader.
 *
 * The header button lives outside React, so it has no toast of its own; the panel lends its
 * toast while it is open. A reason is a translation key, not a sentence, so the words follow
 * the app language like every other line of the plugin.
 */
export type MyMessagesNoticeReason = "pickConversation" | "directory";

export type MyMessagesNotice = (reason: MyMessagesNoticeReason) => void;

let notice: MyMessagesNotice | null = null;

/** Registers the surface that can show a notice. `null` releases it. */
export function setMyMessagesNotice(next: MyMessagesNotice | null): void {
  notice = next;
}

/** Says why the panel could not open where the reader asked. Never throws. */
export function tellMyMessages(reason: MyMessagesNoticeReason): void {
  if (notice) {
    try {
      notice(reason);
      return;
    } catch (error) {
      console.warn("Clear Chat my-messages panel could not show a notice", error);
      return;
    }
  }
  // No panel is open to carry a toast: the host log is the only place left to say it.
  console.warn(`Clear Chat my-messages panel could not open: ${reason}`);
}
