import { Platform } from "react-native";

interface Dismissal { close(): void; opener: HTMLElement | null }
const panels = new WeakMap<Document, Dismissal[]>();

/** Escape belongs to the most recently opened detail, including a host side panel. */
export function installStepDetailKeyboard(close: () => void): () => void {
  const doc = globalThis.document;
  if (Platform.OS !== "web" || !doc) return () => {};
  const stack = panels.get(doc) ?? [];
  panels.set(doc, stack);
  const entry = { close, opener: doc.activeElement as HTMLElement | null };
  stack.push(entry);
  const onKey = (event: KeyboardEvent) => {
    if (stack.at(-1) !== entry || event.defaultPrevented || event.key !== "Escape" || event.isComposing ||
      event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    close();
    // Native web Modal restores focus too; the side panel has no focus trap.
    if (entry.opener?.isConnected) entry.opener.focus({ preventScroll: true });
  };
  doc.addEventListener("keydown", onKey, true);
  return () => {
    doc.removeEventListener("keydown", onKey, true);
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    if (!stack.length) panels.delete(doc);
  };
}
