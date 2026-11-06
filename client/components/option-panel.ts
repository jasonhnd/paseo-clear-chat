import { answerText, choose, clearChoice, dismiss, getOptionSession, missingQuestion, moveCursor, setActiveQuestion, setNote, subscribeOptionSession } from "../option-session";
import type { ExtendedThemeTokens } from "./theme-tokens";

const failed = new Set<string>();
const cleanups = new Set<() => void>();
export function resetOptionPanelFailures(): void { failed.clear(); }
export function removeOptionPanels(): void { for (const cleanup of [...cleanups]) cleanup(); failed.clear(); }

type Translate = (key: any, values?: any) => string;
interface Options {
  agentId: string; at: number; composer: () => HTMLInputElement | HTMLTextAreaElement | null;
  tokens: () => ExtendedThemeTokens; t: Translate; collapsed: () => boolean;
  entered: () => boolean; sendFocused: () => boolean;
  enter: () => void; focusSend: () => void; collapse: () => void; reopen: () => void; send: () => void;
  fallback: () => void;
}
export interface OptionPanel { host: HTMLElement; update: () => void; focusSend: () => void; dispose: () => void }

// The host supplies no overlay API. Fail closed if its composer contract changes.
export function mountOptionPanel(options: Options): OptionPanel | null {
  if (failed.has(options.agentId)) return null;
  let host: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pointerTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let pointerDown = false;
  let redrawPending = false;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;
  let mounted = false;
  let noteOpen: Record<number, boolean> = {};
  let input: HTMLInputElement | HTMLTextAreaElement | null = null;
  let inputParent: HTMLElement | null = null;
  let body: HTMLElement;
  let panel: HTMLElement;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.(); observer?.disconnect(); resizeObserver?.disconnect();
    if (timer !== undefined) clearInterval(timer);
    if (pointerTimer !== undefined) clearTimeout(pointerTimer);
    if (releaseTimer !== undefined) clearTimeout(releaseTimer);
    window.removeEventListener("resize", position);
    window.removeEventListener("scroll", position, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerCancel, true);
    host?.remove(); cleanups.delete(cleanup);
  };
  const fail = () => {
    if (disposed) return;
    if (mounted) failed.add(options.agentId);
    cleanup(); options.fallback();
  };
  function position() {
    try {
      if (!host || !host.isConnected || !input || options.composer() !== input || !input.isConnected || input.parentElement !== inputParent || !input.matches("[data-composer-input]")) throw 0;
      for (let node: HTMLElement | null = input; node; node = node.parentElement) {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) throw 0;
      }
      const rect = input.getBoundingClientRect();
      const inputRoot = input.closest<HTMLElement>('[data-testid="message-input-root"]');
      let anchorTop = inputRoot ? inputRoot.getBoundingClientRect().top : rect.top;
      const session = getOptionSession(options.agentId);
      if (session && session.at === options.at) {
        const count = session.set.questions.filter((_, i) => session.choices[i] === undefined).length;
        const label = options.t("answerCard.openQuestions", { count });
        // Find the nearest pane containing the conversation; do not cross a split pane.
        for (let pane = input.parentElement; pane; pane = pane.parentElement) {
          const chats = Array.from(pane.querySelectorAll('[data-testid="agent-chat-scroll"]')).filter(chat => chat.getClientRects().length);
          if (chats.length > 1) break;
          if (chats.length !== 1) continue;
          const buttons = Array.from(pane.querySelectorAll<HTMLElement>('button, [role="button"]')).filter(button => {
            if (!button.getClientRects().length) return false;
            for (let node: HTMLElement | null = button; node && node !== pane.parentElement; node = node.parentElement) {
              const style = window.getComputedStyle(node);
              if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
            }
            return true;
          });
          const pill = buttons.find(button => button.textContent?.trim().startsWith(label));
          if (pill) {
            const pillRect = pill.getBoundingClientRect();
            const center = (pillRect.top + pillRect.bottom) / 2;
            for (const button of buttons) {
              const bounds = button.getBoundingClientRect();
              if (Number.isFinite(bounds.top) && Number.isFinite(bounds.bottom) && Math.abs((bounds.top + bounds.bottom) / 2 - center) <= 24) anchorTop = Math.min(anchorTop, bounds.top);
            }
          }
          break;
        }
      }
      const available = anchorTop - 8;
      if (![rect.left, rect.right, rect.top, rect.width, rect.height, anchorTop, window.innerWidth, window.innerHeight].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.right > window.innerWidth || rect.top > window.innerHeight || available < 44 || rect.bottom > window.innerHeight) throw 0;
      Object.assign(host.style, { left: `${rect.left}px`, width: `${rect.width}px`, bottom: `${window.innerHeight - anchorTop + 8}px`, maxHeight: `${Math.min(available, window.innerHeight * 0.4)}px` });
    } catch { fail(); }
  }
  function render() {
    if (pointerDown || releaseTimer !== undefined) { redrawPending = true; return; }
    try {
      const session = getOptionSession(options.agentId);
      if (!session || session.at !== options.at || disposed) return;
      const t = options.t, tokens = options.tokens(), index = session.activeQuestion, question = session.set.questions[index]!;
      const number = (i: number) => session.set.questions[i]!.number ?? i + 1;
      const chosen = session.set.questions.map((q, i) => session.choices[i] ? `${q.number ?? ""}${session.choices[i]}` : "").filter(Boolean).join(" ");
      const previous = panel.getRootNode() as ShadowRoot;
      const focused = previous.activeElement as HTMLInputElement | null;
      const focusId = focused?.getAttribute("data-testid");
      const selection = focusId === "option-note" ? [focused?.selectionStart, focused?.selectionEnd] : null;
      panel.replaceChildren();
      Object.assign(panel.style, { color: tokens.foreground, background: tokens.surface1, borderColor: tokens.border, fontFamily: tokens.fontUi, fontSize: `${tokens.fs(13)}px` });
      const node = (tag: string, text?: string, id?: string) => {
        const el = document.createElement(tag);
        if (text !== undefined) el.textContent = text;
        if (id) el.setAttribute("data-testid", id);
        return el;
      };
      const button = (text: string, id: string, action: () => void) => {
        const el = node("button", text, id) as HTMLButtonElement;
        el.type = "button"; el.onclick = action; return el;
      };
      if (options.collapsed()) {
        const strip = button(`${t("answerCard.summary", { total: session.set.questions.length, chosen: chosen || t("answerCard.none"), question: number(index) })} · ${t("answerCard.hintReopen")}`, "option-panel-strip", options.reopen);
        strip.className = "strip"; panel.append(strip);
      } else {
        const header = node("div"); header.className = "header";
        session.set.questions.forEach((_, i) => {
          const tab = button(t("answerCard.question", { current: i + 1, total: session.set.questions.length }), `option-question-${i}`, () => setActiveQuestion(options.agentId, i));
          tab.setAttribute("aria-pressed", String(i === index)); header.append(tab);
        });
        if (chosen) header.append(node("span", `· ${chosen}`));
        header.append(node("span", t("answerCard.detected")));
        header.append(button(t("answerCard.collapse"), "option-card-collapse", options.collapse)); panel.append(header);
        panel.append(node("div", question.text));
        question.options.forEach((option, i) => {
          const selected = session.choices[index] === option.letter;
          const row = button("", `option-row-${option.letter}`, () => {
            moveCursor(options.agentId, index, i - (getOptionSession(options.agentId)?.cursor[index] ?? 0));
            if (selected) clearChoice(options.agentId, index); else choose(options.agentId, index, option.letter);
          });
          row.className = "row"; row.setAttribute("aria-pressed", String(selected));
          if (selected || (options.entered() && !options.sendFocused() && session.cursor[index] === i)) row.style.borderColor = tokens.success;
          if (selected) row.style.background = tokens.successBg;
          const chip = node("strong", option.letter); chip.className = "chip"; chip.style.color = tokens.success; chip.style.borderColor = tokens.success; row.append(chip, node("span", option.text));
          if (option.recommended) { const badge = node("span", t("answerCard.recommended")); badge.className = "badge"; badge.style.color = tokens.success; badge.style.borderColor = tokens.success; row.append(badge); }
          if (selected) row.append(node("span", "✓"));
          if (options.entered() && !options.sendFocused() && session.cursor[index] === i) row.append(node("span", t("answerCard.hintEnter")));
          panel.append(row);
        });
        panel.append(button(t("answerCard.writeOwn"), "option-note-toggle", () => { noteOpen[index] = !noteOpen[index]; render(); }));
        if (noteOpen[index]) {
          const note = node("input", undefined, "option-note") as HTMLInputElement;
          note.value = session.notes[index] ?? ""; note.setAttribute("aria-label", t("answerCard.noteLabel"));
          note.oninput = () => setNote(options.agentId, index, note.value); panel.append(note);
        }
        if (session.notes[index]?.trim() && !session.choices[index]) panel.append(node("div", t("answerCard.chooseFirst"), "option-note-warning"));
        if (index < session.set.questions.length - 1) panel.append(button(t("answerCard.next"), "option-next", () => setActiveQuestion(options.agentId, index + 1)));
        panel.append(button(t("answerCard.notOptions"), "option-dismiss", () => dismiss(options.agentId)));
        if (session.error) panel.append(node("div", t("answerCard.error", { reason: session.error }), "option-send-error"));
        panel.append(node("div", [t("answerCard.hintMove"), t("answerCard.hintPick"), index === session.set.questions.length - 1 ? t("answerCard.hintSend") : t("answerCard.hintNext"), t("answerCard.hintBack")].join("  ·  "), "option-key-hints"));
        const missing = missingQuestion(options.agentId), answer = answerText(options.agentId);
        const send = button(missing === null ? t("answerCard.send", { answer: answer ?? "" }) : t("answerCard.missing", { question: number(missing) }), "option-send", options.send);
        send.style.background = answer === null || session.sending ? tokens.surface2 : tokens.success;
        send.style.color = answer === null || session.sending ? tokens.foregroundMuted : (tokens.isDark ? "#000000" : "#ffffff");
        send.onfocus = options.focusSend;
        send.setAttribute("aria-disabled", String(answer === null || session.sending));
        const sendRow = node("div", undefined, "option-send-row");
        Object.assign(sendRow.style, { position: "sticky", bottom: "0", background: tokens.surface1 });
        sendRow.className = "send-row"; sendRow.append(send); panel.append(sendRow);
      }
      if (focusId) {
        const next = panel.querySelector<HTMLElement>(`[data-testid="${focusId}"]`);
        next?.focus();
        if (selection && next instanceof HTMLInputElement && selection[0] != null && selection[1] != null) next.setSelectionRange(selection[0], selection[1]);
      }
      position();
    } catch { fail(); }
  }
  function flushRedraw() {
    if (releaseTimer !== undefined) clearTimeout(releaseTimer);
    releaseTimer = undefined;
    if (redrawPending) { redrawPending = false; render(); }
  }
  function endPointer(deferRedraw: boolean) {
    if (!pointerDown) return;
    pointerDown = false;
    if (pointerTimer !== undefined) clearTimeout(pointerTimer);
    pointerTimer = undefined;
    // A click follows pointerup; keep its target mounted until click dispatch completes.
    if (deferRedraw) releaseTimer = setTimeout(flushRedraw, 0);
    else flushRedraw();
  }
  function onPointerUp() { endPointer(true); }
  function onPointerCancel() { endPointer(false); }
  try {
    input = options.composer();
    if (!input || !input.matches("[data-composer-input]")) throw 0;
    inputParent = input.parentElement;
    host = document.createElement("div"); host.setAttribute("data-testid", "option-panel");
    Object.assign(host.style, { all: "initial", position: "fixed", zIndex: "2147483000", display: "block" });
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `:host{box-sizing:border-box} *,*::before,*::after{box-sizing:border-box} .panel{border:1px solid;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;max-height:inherit;overflow:auto;white-space:pre-wrap} .panel>*{flex-shrink:0;min-width:0} button,input{font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:8px;padding:8px;min-height:44px;text-align:left} button{cursor:pointer} .header,.row{display:flex;align-items:center;gap:8px} .header{flex-wrap:wrap} .header>*{max-width:100%;overflow-wrap:anywhere} .strip{white-space:normal;overflow-wrap:anywhere} .send-row{padding-top:8px} .send-row button{width:100%} .row span:nth-child(2){flex:1} .chip,.badge{border:1px solid;border-radius:5px;padding:2px 5px} .badge{font-size:.9em}`;
    panel = document.createElement("div"); panel.className = "panel"; body = panel;
    shadow.append(style, body); document.body.append(host);
    host.addEventListener("pointerdown", event => {
      if (releaseTimer !== undefined) flushRedraw();
      pointerDown = true;
      if (pointerTimer !== undefined) clearTimeout(pointerTimer);
      pointerTimer = setTimeout(() => endPointer(false), 1000);
      if (!(event.composedPath()[0] as HTMLElement)?.closest?.("input, textarea, [contenteditable=true]")) options.enter();
    });
    host.addEventListener("click", event => {
      if (event.detail === 0 && pointerDown) return;
      endPointer(false);
      if (!pointerDown) flushRedraw();
    });
    position(); if (disposed) return null;
    render(); if (disposed) return null;
    observer = new MutationObserver(position); observer.observe(document.body, { childList: true, subtree: true });
    if (typeof ResizeObserver !== "undefined") { resizeObserver = new ResizeObserver(position); resizeObserver.observe(input); }
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    window.addEventListener("pointerup", onPointerUp, true); window.addEventListener("pointercancel", onPointerCancel, true);
    timer = setInterval(position, 250);
    unsubscribe = subscribeOptionSession(render); cleanups.add(cleanup);
    mounted = true;
    return { host, update: render, focusSend: () => panel.querySelector<HTMLElement>('[data-testid="option-send"]')?.focus(), dispose: cleanup };
  } catch { fail(); return null; }
}
