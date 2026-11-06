import { formatPartialOptionAnswer } from "./option-questions";
import { getOptionSession } from "./option-session";

type Composer = HTMLInputElement | HTMLTextAreaElement;

function setValue(input: Composer, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("Composer value setter unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

// Install only while the matching card is available. The capture listener runs
// before the host's key handler without consuming or changing the key event.
export function installOptionComposer(doc: Document, agentId: string, at: number, composer: () => Composer | null): () => void {
  let pending: { input: Composer; prefix: string; timer: ReturnType<typeof setTimeout> } | null = null;

  function cancelPending(): void {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.input.removeEventListener("input", observeDraft);
    pending = null;
  }

  function observeDraft(): void {
    if (pending && (composer() !== pending.input || !pending.input.value.startsWith(pending.prefix))) cancelPending();
  }

  function removePrefix(): void {
    const current = pending;
    if (!current) return;
    cancelPending();
    const { input, prefix } = current;
    if (composer() !== input || !input.value.startsWith(prefix)) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    try {
      setValue(input, input.value.slice(prefix.length));
      input.setSelectionRange(Math.max(0, start - prefix.length), Math.max(0, end - prefix.length));
    } catch { /* The host remains responsible for the draft. */ }
  }

  function onKey(event: KeyboardEvent): void {
    if (pending || event.key !== "Enter" || event.shiftKey || event.isComposing || event.altKey || event.defaultPrevented) return;
    const input = composer();
    if (!input || event.target !== input || !input.value) return;
    const session = getOptionSession(agentId);
    if (!session || session.at !== at || session.dismissed || session.sending) return;
    const choices = Object.fromEntries(session.set.questions.map((_, i) => [i, session.choices[i] === undefined ? undefined : { letter: session.choices[i]!, note: session.notes[i] }]));
    const prefix = formatPartialOptionAnswer(session.set, choices);
    if (!prefix) return;

    const original = input.value;
    const start = input.selectionStart ?? original.length;
    const end = input.selectionEnd ?? start;
    const expected = prefix + original;
    let written = false;
    try {
      input.setSelectionRange(0, 0);
      if (composer() !== input || input.value !== original) return;
      const inserted = doc.execCommand("insertText", false, prefix);
      if (composer() !== input) {
        if (input.value !== original) setValue(input, original);
        return;
      }
      if (inserted) {
        written = input.value === expected;
      } else {
        if (input.value !== original) setValue(input, original);
        if (composer() === input && input.value === original) {
          setValue(input, expected);
          written = composer() === input && input.value === expected;
        }
      }
    } catch { /* Restore below and leave the key to the host. */ }
    if (!written) {
      try { if (input.value !== original) setValue(input, original); } catch { /* Best effort if the page rejects writes. */ }
      try { input.setSelectionRange(start, end); } catch { /* The input may have been removed. */ }
      return;
    }
    try { input.setSelectionRange(start + prefix.length, end + prefix.length); } catch { /* The host may replace the input. */ }
    pending = { input, prefix, timer: setTimeout(removePrefix, 300) };
    input.addEventListener("input", observeDraft);
    queueMicrotask(observeDraft);
  }

  doc.addEventListener("keydown", onKey, true);
  return () => {
    doc.removeEventListener("keydown", onKey, true);
    removePrefix();
  };
}
