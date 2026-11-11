import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { jumpHeadingLines } from "../jump-chips";
import { hostFontEscape } from "./host-font-escape";
import { MarkdownView, type MarkdownViewProps } from "./markdown/markdown-view";

let activeReader: (() => void) | null = null;

/** Capture the host position before mounting a modal, and keep it stable until it closes. */
export function beginReader(root: HTMLElement | null, close: () => void): () => void {
  activeReader?.();
  let ancestor = root?.parentElement ?? null;
  while (ancestor) {
    const overflow = window.getComputedStyle(ancestor).overflowY;
    if ((overflow === "auto" || overflow === "scroll" || overflow === "overlay") && ancestor.scrollHeight > ancestor.clientHeight) break;
    ancestor = ancestor.parentElement;
  }
  const scroller = ancestor;
  const position = scroller ? scroller.scrollTop : window.scrollY;
  const restore = () => {
    if (scroller) scroller.scrollTop = position;
    else if (window.scrollY !== position) window.scrollTo(window.scrollX, position);
  };
  const target: HTMLElement | Window = scroller ?? window;
  target.addEventListener("scroll", restore, { passive: true });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    target.removeEventListener("scroll", restore);
    if (activeReader === dismiss) activeReader = null;
    restore();
  };
  const dismiss = () => { release(); close(); };
  activeReader = dismiss;
  return release;
}

type ReaderDialogProps = Pick<MarkdownViewProps, "text" | "images" | "cwd" | "tokens" | "variant"> & {
  onClose: () => void;
};

export function ReaderDialog({ text, images, cwd, tokens, variant, onClose }: ReaderDialogProps) {
  const scroll = useRef<HTMLElement | null>(null);
  const body = useRef<HTMLElement | null>(null);
  const overlay = useRef<HTMLElement | null>(null);
  const atBottom = useRef(false);
  const [active, setActive] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const [width, setWidth] = useState(() => window.innerWidth);
  const headings = useMemo(() => jumpHeadingLines(text), [text]);
  const summaries = useMemo(() => {
    const lines = text.split(/\r?\n/);
    return headings.map((heading, i) => lines.slice(heading.line + 1, headings[i + 1]?.line)
      .map(line => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, "").replace(/[*_`#]/g, "").trim())
      .find(Boolean)?.split(/[。！？.!?]/)[0] ?? "");
  }, [text, headings]);
  const lead = text.split(/\r?\n/).slice(0, headings[0]?.line ?? 0).find(line => line.trim())?.trim();
  const subtitle = lead && lead.length <= 24 && !/^[#>*`_-]/.test(lead) ? `${lead} · ` : "";
  const mobile = width < 640;
  const desktop = width >= 900;
  const muted = tokens.isDark ? "#b9bcc4" : tokens.foregroundMuted;
  const accent = tokens.isDark ? "#a8c8ff" : tokens.accent;
  const panel = tokens.isDark ? "#15181f" : tokens.surface0;
  const ui = { fontFamily: `"${tokens.fontUi}", sans-serif`, color: tokens.foreground };

  // Keep the overlay outside the conversation while retaining React event delegation.
  useLayoutEffect(() => {
    const node = overlay.current;
    if (!node || !node.parentNode) return;
    const parent = node.parentNode;
    const marker = document.createComment("reader");
    parent.insertBefore(marker, node);
    let reactRoot: HTMLElement | null = node.parentElement;
    while (reactRoot && !Object.keys(reactRoot).some(key => key.startsWith("__reactContainer$") || key === "_reactRootContainer")) reactRoot = reactRoot.parentElement;
    (reactRoot ?? document.getElementById("root") ?? document.body).appendChild(node);
    const previousFocus = document.activeElement as HTMLElement | null;
    node.querySelector<HTMLElement>('[data-testid="reader-close"]')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const buttons = Array.from(node.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(el => el.offsetParent !== null && !el.hasAttribute("disabled"));
      if (!buttons.length) return;
      const first = buttons[0]!;
      const last = buttons[buttons.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const backdrop = (event: MouseEvent) => { if (event.target === node) onClose(); };
    node.addEventListener("click", backdrop);
    node.querySelector<HTMLElement>('[data-testid="reader-panel"]')?.setAttribute("aria-modal", "true");
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      node.removeEventListener("click", backdrop);
      if (marker.parentNode) marker.parentNode.insertBefore(node, marker);
      marker.remove();
      previousFocus?.focus();
    };
  }, [onClose]);

  useLayoutEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useLayoutEffect(() => {
    const node = scroll.current;
    const content = body.current;
    if (!node || !content) return;
    const updatePosition = () => {
      atBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
      const top = node.getBoundingClientRect().top + 24;
      const markers = Array.from(node.querySelectorAll<HTMLElement>("[data-jump-heading]"));
      let current = 0;
      for (const marker of markers) {
        if (marker.getBoundingClientRect().top <= top) current = Number(marker.dataset.jumpHeading);
      }
      setActive(current);
    };
    updatePosition();
    node.addEventListener("scroll", updatePosition, { passive: true });
    const observer = new ResizeObserver(() => {
      if (atBottom.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(content);
    return () => { node.removeEventListener("scroll", updatePosition); observer.disconnect(); };
  }, []);

  useLayoutEffect(() => {
    const heading = body.current?.querySelector<HTMLElement>(`[data-jump-heading="${active}"]`);
    if (!heading) return;
    const nodes = [heading, ...Array.from(heading.querySelectorAll<HTMLElement>("span, div"))];
    const old = nodes.map(node => ({ node, color: node.style.color, borderLeft: node.style.borderLeft, paddingLeft: node.style.paddingLeft }));
    for (const node of nodes) node.style.color = accent;
    heading.style.borderLeft = `2px solid ${accent}`;
    heading.style.paddingLeft = "8px";
    return () => { for (const { node, color, borderLeft, paddingLeft } of old) { node.style.color = color; node.style.borderLeft = borderLeft; node.style.paddingLeft = paddingLeft; } };
  }, [active, accent, text]);

  function goToHeading(index: number) {
    const node = scroll.current;
    const heading = node?.querySelector<HTMLElement>(`[data-jump-heading="${index}"]`);
    if (node && heading) {
      node.scrollTop += heading.getBoundingClientRect().top - node.getBoundingClientRect().top;
      atBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
      setActive(index);
    }
    setTocOpen(false);
  }

  const toc = <View style={{ gap: 2 }}>
    {headings.map(({ index, heading }) => <Pressable key={index} testID={`reader-toc-${index}`} accessibilityRole="button"
      accessibilityLabel={heading || `Heading ${index + 1}`} onPress={() => goToHeading(index)}
      style={{ paddingVertical: 7, paddingHorizontal: 10, borderLeftWidth: 2, borderLeftColor: active === index ? accent : "transparent", borderRadius: 6, backgroundColor: active === index ? (tokens.isDark ? "#1e2a3f" : "#e8f0ff") : "transparent" }}>
      <Text numberOfLines={1} style={{ ...ui, color: active === index ? accent : tokens.foreground, fontSize: tokens.fs(13), fontWeight: active === index ? "600" : "400" }}>{heading || `Heading ${index + 1}`}</Text>
      {summaries[index] ? <Text numberOfLines={1} style={{ ...ui, color: muted, fontSize: tokens.fs(11), marginTop: 2 }}>{summaries[index]}</Text> : null}
    </Pressable>)}
  </View>;

  return <View ref={node => { overlay.current = node as unknown as HTMLElement | null; }} {...hostFontEscape}
    style={{ position: "fixed", inset: 0, zIndex: 10000, alignItems: "center", justifyContent: "center", backgroundColor: tokens.isDark ? "rgba(0,0,0,0.34)" : "rgba(0,0,0,0.16)" } as never}>
    <View testID="reader-panel" accessibilityRole={"dialog" as never} accessibilityLabel="长回复 · 阅读视图"
      style={{ width: desktop ? 1000 : mobile ? "calc(100% - 24px)" : "calc(100% - 48px)", maxWidth: "calc(100% - 24px)", height: mobile ? "calc(100% - 80px)" : "min(664px, calc(100% - 80px))", borderRadius: 12, borderWidth: 0, backgroundColor: panel, backgroundImage: `linear-gradient(${tokens.surface1}, ${tokens.surface1})`, overflow: "hidden", boxShadow: `0 0 0 1px ${tokens.border}, 0 18px 60px rgba(0,0,0,0.18)` } as never}>
      <View style={{ height: 72, flexShrink: 0, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: tokens.border }}>
        <View style={{ minWidth: 0 }}><Text numberOfLines={1} style={{ ...ui, fontSize: tokens.fs(16), fontWeight: "600" }}>长回复 · 阅读视图</Text>
          <Text style={{ ...ui, color: muted, fontSize: tokens.fs(12), marginTop: 4 }}>{subtitle}{headings.length} 节 · 约 {Array.from(text).length.toLocaleString()} 字</Text></View>
        <Pressable testID="reader-close" accessibilityRole="button" accessibilityLabel="关闭阅读视图" onPress={onClose} style={{ width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: tokens.border }}><Text style={{ ...ui, fontSize: tokens.fs(20), lineHeight: 24 }}>×</Text></Pressable>
      </View>
      {!desktop ? <View style={{ paddingHorizontal: 20, paddingTop: 12 }}>
        <Pressable testID="reader-toc-toggle" accessibilityRole="button" accessibilityState={{ expanded: tocOpen }} onPress={() => setTocOpen(!tocOpen)} style={{ minHeight: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: tokens.border, borderRadius: 8, backgroundColor: tokens.surface2, paddingHorizontal: 12 }}>
          <Text style={{ ...ui, fontSize: tokens.fs(12) }}>当前第 {headings.length ? active + 1 : 0} 节 · 共 {headings.length} 节</Text><Text style={{ ...ui, color: accent, fontSize: tokens.fs(12) }}>☰ 目录</Text>
        </Pressable>
        {tocOpen ? <View style={{ maxHeight: 220, overflowY: "auto", borderWidth: 1, borderColor: tokens.border, borderRadius: 8, backgroundColor: panel, marginTop: 4 } as never}>{toc}</View> : null}
      </View> : null}
      <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
        {desktop ? <View testID="reader-rail" style={{ width: 240, padding: 12, borderRightWidth: 1, borderRightColor: tokens.border, backgroundColor: tokens.surface2 }}>
          <Text style={{ ...ui, color: muted, fontSize: tokens.fs(12), marginHorizontal: 10, marginBottom: 12 }}>目录</Text>
          <View style={{ flex: 1, overflowY: "auto" } as never}>{toc}</View>
          <View style={{ borderTopWidth: 1, borderTopColor: tokens.border, paddingHorizontal: 10, paddingTop: 12 }}><View style={{ flexDirection: "row", justifyContent: "space-between" }}><Text style={{ ...ui, color: muted, fontSize: tokens.fs(12) }}>阅读进度</Text><Text testID="reader-progress" style={{ ...ui, color: muted, fontSize: tokens.fs(12) }}>{headings.length ? active + 1 : 0} / {headings.length}</Text></View><View style={{ height: 4, backgroundColor: tokens.border, borderRadius: 2, marginTop: 8 }}><View style={{ width: `${headings.length ? ((active + 1) / headings.length) * 100 : 0}%`, height: 4, borderRadius: 2, backgroundColor: accent }} /></View></View>
        </View> : null}
        <View testID="reader-content" style={{ flex: 1, minWidth: 0, position: "relative" }}>
          <View testID="reader-scroll" ref={node => { scroll.current = node as unknown as HTMLElement | null; }} style={{ flex: 1, overflowY: "scroll", scrollbarWidth: "thin", overscrollBehavior: "contain" } as never}>
            <View testID="reader-body" ref={node => { body.current = node as unknown as HTMLElement | null; }} style={{ paddingTop: 24, paddingHorizontal: mobile ? 20 : 28, paddingBottom: 64 }}>
              <MarkdownView text={text} images={images} cwd={cwd} tokens={tokens} variant={variant} />
            </View>
          </View>
          <View testID="reader-fade" pointerEvents="none" style={{ position: "absolute", bottom: 0, left: 0, right: 10, height: 46, backgroundImage: `linear-gradient(to top, ${panel}, transparent)` } as never} />
        </View>
      </View>
      <View style={{ minHeight: 56, flexShrink: 0, paddingHorizontal: 20, paddingVertical: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, borderTopWidth: 1, borderTopColor: tokens.border }}>
        <Text style={{ ...ui, color: muted, fontSize: tokens.fs(12), flexShrink: 1 }}>{mobile ? "上下滑动阅读 · 关闭后回到对话原位" : "↑↓ 在弹窗内滚动 · Esc 关闭"}</Text>
        <Pressable accessibilityRole="button" onPress={onClose} style={{ borderWidth: 1, borderColor: tokens.border, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 }}><Text style={{ ...ui, fontSize: tokens.fs(12) }}>关闭，回到对话</Text></Pressable>
      </View>
    </View>
  </View>;
}
