import { choose, getOptionSession, missingQuestion, moveCursor, setActiveQuestion } from "../option-session";

const cleanups = new Set<() => void>();

export function removeOptionKeyboards(): void {
  for (const cleanup of [...cleanups]) cleanup();
}

interface KeyboardOptions {
  agentId: string;
  at: number;
  root: () => HTMLElement | null;
  enter: () => void;
  leave: () => void;
  exit: () => void;
  entered: () => boolean;
  send: () => void;
  focusSend: () => void;
  sendFocused: () => boolean;
  setSendFocused: (focused: boolean) => void;
  contains?: (node: Node) => boolean;
}

// The composer and the scroll area are siblings in the host. Stop at a split
// pane instead of allowing one card to control another pane's composer.
function composerFor(root: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
  if (!root.getClientRects().length) return null;
  for (let parent = root.parentElement; parent; parent = parent.parentElement) {
    const chats = Array.from(parent.querySelectorAll('[data-testid="agent-chat-scroll"]')).filter(chat => chat.getClientRects().length);
    if (chats.length > 1) return null;
    if (chats.length !== 1 || !chats[0]?.contains(root)) continue;
    const inputs = Array.from(parent.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-composer-input], [data-composer-input] textarea, [data-composer-input] input'))
      .filter(input => (input.tagName === "TEXTAREA" || input.tagName === "INPUT") && input.getClientRects().length);
    if (inputs.length === 1) return inputs[0]!;
    if (inputs.length > 1) return null;
    // Preserve keyboard access when the host removes the marker, provided the
    // pane still has exactly one visible input outside the conversation.
    const unmarked = Array.from(parent.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input"))
      .filter(input => !chats[0]!.contains(input) && input.getClientRects().length);
    if (unmarked.length === 1) return unmarked[0]!;
    if (unmarked.length > 1) return null;
  }
  return null;
}

export function installOptionKeyboard(options: KeyboardOptions, target: Window = window): () => void {
  const composer = () => { const root = options.root(); return root ? composerFor(root) : null; };
  const onPointerDown = (event: PointerEvent) => {
    const input = composer();
    if (input && (event.composedPath?.()[0] ?? event.target) === input) options.exit();
  };
  const onInput = (event: Event) => {
    if (event.target === composer() && (event.target as HTMLInputElement).value) options.leave();
  };
  const onKey = (event: KeyboardEvent) => {
    const root = options.root();
    const input = composer();
    const session = getOptionSession(options.agentId);
    if (!root || !input || !session || session.at !== options.at || session.sending) return;
    if (input.value) { options.leave(); return; }
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || (event.shiftKey && event.key !== "Tab")) return;
    const targetNode = event.target as HTMLElement | null;
    const actualTarget = (event.composedPath?.()[0] ?? targetNode) as HTMLElement | null;
    if (targetNode !== input && (!targetNode || (!root.contains(targetNode) && !options.contains?.(targetNode)))) return;
    if (targetNode !== input && actualTarget?.closest('input, textarea, [contenteditable="true"]')) return;
    const index = session.activeQuestion;
    const question = session.set.questions[index]!;
    if (!options.entered()) {
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && targetNode === input) {
        const recommended = question.options.findIndex(option => option.recommended);
        moveCursor(options.agentId, index, Math.max(0, recommended) - (session.cursor[index] ?? 0));
        options.enter(); event.preventDefault();
      }
      return;
    }
    if (event.key === "Escape") {
      options.leave(); input.focus(); event.preventDefault(); return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      options.setSendFocused(false);
      moveCursor(options.agentId, index, event.key === "ArrowUp" ? -1 : 1);
      event.preventDefault(); return;
    }
    if (event.key === "Tab" || event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const backwards = event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey);
      if (backwards && options.sendFocused()) options.setSendFocused(false);
      else if (backwards && index > 0) { options.setSendFocused(false); setActiveQuestion(options.agentId, index - 1); }
      else if (!backwards && index < session.set.questions.length - 1) { options.setSendFocused(false); setActiveQuestion(options.agentId, index + 1); }
      else if (!backwards && event.key === "Tab" && !options.sendFocused()) { options.setSendFocused(true); options.focusSend(); }
      else return;
      event.preventDefault(); return;
    }
    if (event.key === "Enter") {
      if (options.sendFocused()) {
        if (missingQuestion(options.agentId) === null) options.send();
      } else {
        if (!session.choices[index]) choose(options.agentId, index, question.options[session.cursor[index] ?? 0]!.letter);
        if (index < session.set.questions.length - 1) setActiveQuestion(options.agentId, index + 1);
        else if (missingQuestion(options.agentId) === null) options.send();
      }
      event.preventDefault(); return;
    }
    const letter = /^[1-8]$/.test(event.key) ? String.fromCharCode(64 + Number(event.key)) : /^[a-h]$/i.test(event.key) ? event.key.toUpperCase() : "";
    const optionIndex = question.options.findIndex(option => option.letter === letter);
    if (optionIndex >= 0) {
      options.setSendFocused(false);
      moveCursor(options.agentId, index, optionIndex - (session.cursor[index] ?? 0));
      choose(options.agentId, index, letter);
      event.preventDefault(); return;
    }
    if (targetNode === input && event.key.length === 1) options.leave();
  };
  target.addEventListener("keydown", onKey, true);
  target.addEventListener("input", onInput, true);
  target.addEventListener("pointerdown", onPointerDown, true);
  if (composer()?.value) options.leave();
  const cleanup = () => {
    target.removeEventListener("keydown", onKey, true);
    target.removeEventListener("input", onInput, true);
    target.removeEventListener("pointerdown", onPointerDown, true);
    cleanups.delete(cleanup);
  };
  cleanups.add(cleanup);
  return cleanup;
}

export function optionComposer(root: HTMLElement | null): HTMLInputElement | HTMLTextAreaElement | null {
  return root ? composerFor(root) : null;
}
