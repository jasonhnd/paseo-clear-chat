import { useEffect, useMemo } from "react";
import { Platform, type ViewProps } from "react-native";
import type { ToolCalloutData } from "../../shared/contracts";
import { DESKTOP_MIN } from "../breakpoints";
import { toolSummary } from "../tool-summary";
import type { ExtendedThemeTokens } from "./theme-tokens";

const HOVER_QUERY = `(min-width: ${DESKTOP_MIN}px) and (any-hover: hover) and (any-pointer: fine)`;
const activePreviews = new WeakMap<Document, () => void>();
let nextPreviewId = 0;

function snippet(text: string, lines: number, characters: number): string {
  const head = text.slice(0, characters).split(/\r?\n/).slice(0, lines).join("\n");
  return head.length < text.length ? `${head}\n…` : head;
}

function outputPreview(data: ToolCalloutData): string {
  const streams = [data.error, data.shell?.stdout, data.shell?.stderr].filter(Boolean).join("\n");
  const text = streams || data.diff || data.output || data.plainText || data.skill?.text
    || data.search?.preview || data.fetch?.preview || data.toolSearch?.text
    || data.thinking?.text || data.cells?.[0]?.output || data.code || data.fallback?.output
    || data.checklist?.tasks.slice(0, 4).map(task => task.title).join("\n")
    || data.subagent?.agents[0]?.task || "No output reported.";
  return snippet(text, 4, 800);
}

function previewController(doc: Document, data: ToolCalloutData, tokens: ExtendedThemeTokens) {
  const view = doc.defaultView!;
  const media = view.matchMedia(HOVER_QUERY);
  let timer: number | undefined;
  let preview: HTMLElement | undefined;
  let target: HTMLElement | undefined;
  let description: string | null = null;
  let describedBy: string | undefined;

  const dismiss = () => {
    if (timer !== undefined) view.clearTimeout(timer);
    timer = undefined;
    preview?.remove();
    preview = undefined;
    if (target && describedBy && target.getAttribute("aria-describedby") === describedBy) {
      if (description === null) target.removeAttribute("aria-describedby");
      else target.setAttribute("aria-describedby", description);
    }
    target = undefined;
    describedBy = undefined;
    doc.removeEventListener("scroll", dismiss, true);
    doc.removeEventListener("pointerdown", dismiss, true);
    doc.removeEventListener("keydown", dismiss, true);
    doc.removeEventListener("visibilitychange", dismiss);
    view.removeEventListener("resize", dismiss);
    view.removeEventListener("blur", dismiss);
    media.removeEventListener("change", dismiss);
    if (activePreviews.get(doc) === dismiss) activePreviews.delete(doc);
  };

  const onPointerEnter: NonNullable<ViewProps["onPointerEnter"]> = event => {
    dismiss();
    if (event.nativeEvent.pointerType !== "mouse" || !media.matches) return;
    const row = event.currentTarget as unknown as HTMLElement;
    if (typeof row?.getBoundingClientRect !== "function") return;
    const pointerX = event.nativeEvent.clientX;
    activePreviews.get(doc)?.();
    activePreviews.set(doc, dismiss);
    target = row;
    doc.addEventListener("scroll", dismiss, true);
    doc.addEventListener("pointerdown", dismiss, true);
    doc.addEventListener("keydown", dismiss, true);
    doc.addEventListener("visibilitychange", dismiss);
    view.addEventListener("resize", dismiss);
    view.addEventListener("blur", dismiss);
    media.addEventListener("change", dismiss);
    timer = view.setTimeout(() => {
      timer = undefined;
      if (!media.matches || !row.isConnected) { dismiss(); return; }
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom <= 0 || rect.top >= view.innerHeight) { dismiss(); return; }

      // A body-level surface escapes the card's clipping and virtual row stacking.
      const node = doc.createElement("div");
      node.id = `clear-chat-tool-preview-${++nextPreviewId}`;
      node.setAttribute("role", "tooltip");
      node.setAttribute("data-testid", "tool-hover-preview");
      Object.assign(node.style, {
        position: "fixed", pointerEvents: "none", zIndex: "10000", boxSizing: "border-box",
        width: "420px", maxWidth: `${view.innerWidth - 16}px`, maxHeight: `${Math.min(200, view.innerHeight - 16)}px`,
        overflow: "hidden", padding: "10px 12px", borderRadius: "8px",
        border: `1px solid ${tokens.borderSubtle}`, background: tokens.surface1,
        color: tokens.foreground, boxShadow: "0 6px 24px rgba(0, 0, 0, 0.2)",
        fontFamily: tokens.fontUi, fontSize: `${tokens.fs(12)}px`, lineHeight: "1.4",
        whiteSpace: "pre-wrap", overflowWrap: "anywhere",
      });
      const title = doc.createElement("div");
      title.style.fontWeight = "600";
      title.textContent = snippet(toolSummary(data), 2, 200);
      node.appendChild(title);
      if (data.filePath) {
        const path = doc.createElement("div");
        path.textContent = snippet(data.filePath, 1, 200);
        path.style.color = tokens.foregroundMuted;
        node.appendChild(path);
      }
      const output = doc.createElement("div");
      output.textContent = outputPreview(data);
      Object.assign(output.style, { marginTop: "6px", fontFamily: tokens.fontMono });
      node.appendChild(output);
      doc.body.appendChild(node);
      preview = node;

      const height = node.getBoundingClientRect().height;
      let left = Math.max(8, Math.min(rect.left, view.innerWidth - node.getBoundingClientRect().width - 8));
      let top = rect.top - height - 8;
      if (top < 8) {
        // Near the top edge, keep the pointer's vertical lane clear for the next row.
        const x = Number.isFinite(pointerX) ? pointerX : rect.left + rect.width / 2;
        const rightSpace = view.innerWidth - x - 24;
        const leftSpace = x - 24;
        const right = rightSpace >= leftSpace;
        const width = Math.min(420, right ? rightSpace : leftSpace);
        node.style.width = `${width}px`;
        left = right ? x + 16 : x - width - 16;
        top = Math.max(8, Math.min(rect.bottom + 8, view.innerHeight - node.getBoundingClientRect().height - 8));
      }
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      description = row.getAttribute("aria-describedby");
      describedBy = [description, node.id].filter(Boolean).join(" ");
      row.setAttribute("aria-describedby", describedBy);
    }, 300);
  };

  return { dismiss, props: { onPointerEnter, onPointerLeave: dismiss } };
}

/** Hover never changes expansion, selection, or the row's press gestures. */
export function useToolHoverPreview(data: ToolCalloutData, expanded: boolean, tokens: ExtendedThemeTokens): ViewProps {
  const doc = globalThis.document;
  const controller = useMemo(() => {
    if (expanded || Platform.OS !== "web" || !doc?.defaultView?.matchMedia) return;
    return previewController(doc, data, tokens);
  }, [data, expanded, tokens, doc]);
  useEffect(() => () => controller?.dismiss(), [controller]);
  return controller?.props ?? {};
}
