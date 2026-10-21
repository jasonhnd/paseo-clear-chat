import type { ViewProps } from "react-native";
import { COLLAPSED_TOOL_HEIGHT } from "./components/tool-callout-styles";

const ROW_SELECTOR = "[data-history-row-id]";
const TOOL_SELECTOR = "[data-clearchattool]";
export const COMPACT_TOOL_GAP = 4;
export const MAX_TOOL_GAP_COMPENSATION = 12;

/** Never consume more than the measured host gap or move a row over its neighbor. */
export function toolGapCompensation(hostGap: number): number {
  return Number.isFinite(hostGap) ? Math.min(MAX_TOOL_GAP_COMPENSATION, Math.max(0, hostGap - COMPACT_TOOL_GAP)) : 0;
}

export function toolRowMarker(collapsed: boolean): ViewProps {
  return { dataSet: { clearchattool: collapsed ? "collapsed" : "open" } } as unknown as ViewProps;
}

function markerInRow(row: Element): HTMLElement | undefined {
  const markers = Array.from(row.querySelectorAll<HTMLElement>(TOOL_SELECTOR))
    .filter(marker => marker.closest(ROW_SELECTOR) === row);
  return markers.length === 1 ? markers[0] : undefined;
}

function hostFrame(marker: HTMLElement, row: Element): HTMLElement | undefined {
  let frame = marker;
  while (frame.parentElement && frame.parentElement !== row) frame = frame.parentElement;
  // A footer or another sibling is an intentional boundary, not a compact tool sequence.
  return frame.parentElement === row && row.children.length === 1 ? frame : undefined;
}

function previousRow(row: Element): Element | undefined {
  const previous = row.previousElementSibling;
  if (previous?.matches(ROW_SELECTOR)) return previous;
  // Web history's virtualized rows share a container immediately before mounted rows.
  if (previous?.children.length && Array.from(previous.children).every(child => child.matches(ROW_SELECTOR))) {
    return previous.lastElementChild ?? undefined;
  }
  return undefined;
}

/**
 * The SDK exposes neither gapBelow nor neighbors. On web, read the host frame's
 * actual gap and compensate only our own root between two collapsed tool rows.
 * Native and unknown host layouts keep their existing spacing.
 */
export function installCompactToolSpacing(doc = typeof document === "undefined" ? undefined : document): () => void {
  const view = doc?.defaultView;
  if (!doc || !view?.MutationObserver || !view.requestAnimationFrame) return () => {};
  const adjusted = new Map<HTMLElement, string>();
  let pending: number | undefined;
  let stopped = false;

  function restore(marker: HTMLElement) {
    const original = adjusted.get(marker);
    if (original === undefined) return;
    marker.style.marginTop = original;
    adjusted.delete(marker);
  }

  function refresh() {
    pending = undefined;
    if (stopped) return;
    const markers = Array.from(doc!.querySelectorAll<HTMLElement>(TOOL_SELECTOR));
    const present = new Set(markers);
    const measured = new Map<HTMLElement, boolean>();
    const compact = (marker: HTMLElement) => {
      if (measured.has(marker)) return measured.get(marker)!;
      const height = marker.getAttribute("data-clearchattool") === "collapsed" ? marker.getBoundingClientRect().height : 0;
      const result = height > 0 && height <= COLLAPSED_TOOL_HEIGHT;
      measured.set(marker, result);
      return result;
    };
    const margins = new Map<HTMLElement, number>();
    for (const marker of markers) {
      const row = marker.closest(ROW_SELECTOR);
      const above = row ? previousRow(row) : undefined;
      const previous = above ? markerInRow(above) : undefined;
      const frame = previous && above ? hostFrame(previous, above) : undefined;
      const consecutive = !row?.hasAttribute("data-index") || !above?.hasAttribute("data-index")
        || Number(row.getAttribute("data-index")) === Number(above.getAttribute("data-index")) + 1;
      const amount = row && frame && previous && consecutive && markerInRow(row) === marker && hostFrame(marker, row) && compact(marker) && compact(previous)
        ? toolGapCompensation(Number.parseFloat(view!.getComputedStyle(frame).marginBottom)) : 0;
      margins.set(marker, amount);
    }
    // Read the entire batch before changing layout. Interleaving each margin
    // with the next row's geometry forces a reflow for every compact neighbor.
    for (const marker of adjusted.keys()) if (!present.has(marker)) restore(marker);
    for (const [marker, amount] of margins) {
      if (!amount) { restore(marker); continue; }
      if (!adjusted.has(marker)) adjusted.set(marker, marker.style.marginTop);
      const margin = `${-amount}px`;
      if (marker.style.marginTop !== margin) marker.style.marginTop = margin;
    }
  }

  function schedule() {
    if (!stopped && pending === undefined) pending = view!.requestAnimationFrame(refresh);
  }
  const observer = new view.MutationObserver(schedule);
  observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-clearchattool", "data-history-row-id", "data-index"] });
  view.addEventListener("resize", schedule);
  schedule();
  return () => {
    stopped = true;
    observer.disconnect();
    view.removeEventListener("resize", schedule);
    if (pending !== undefined) view.cancelAnimationFrame(pending);
    for (const marker of adjusted.keys()) restore(marker);
  };
}
