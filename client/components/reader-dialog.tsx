import React, { useLayoutEffect, useMemo, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { Modal } from "@getpaseo/plugin/client/ui";
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
  const atBottom = useRef(false);
  const headings = useMemo(() => jumpHeadingLines(text), [text]);

  useLayoutEffect(() => {
    const node = scroll.current;
    const content = body.current;
    if (!node || !content) return;
    const updatePosition = () => { atBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 2; };
    updatePosition();
    node.addEventListener("scroll", updatePosition, { passive: true });
    const observer = new ResizeObserver(() => {
      if (atBottom.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(content);
    return () => { node.removeEventListener("scroll", updatePosition); observer.disconnect(); };
  }, []);

  function goToHeading(index: number) {
    const node = scroll.current;
    const heading = node?.querySelector<HTMLElement>(`[data-jump-heading="${index}"]`);
    if (node && heading) {
      node.scrollTop += heading.getBoundingClientRect().top - node.getBoundingClientRect().top;
      atBottom.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 2;
    }
  }

  return <Modal title="Reader" open onOpenChange={open => { if (!open) onClose(); }}>
    <Modal.Content scrollable={false}>
      <View style={{ gap: 8, width: "100%" }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(16), fontWeight: "600" }}>Reader</Text>
          <Pressable testID="reader-close" accessibilityRole="button" accessibilityLabel="Close reader" onPress={onClose} style={{ padding: 8 }}>
            <Text style={{ color: tokens.accent }}>Close</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          {headings.map(({ index, heading }) => <Pressable key={index} testID={`reader-toc-${index}`} accessibilityRole="button"
            accessibilityLabel={heading || `Heading ${index + 1}`} onPress={() => goToHeading(index)} style={{ padding: 6 }}>
            <Text style={{ color: tokens.accent, fontSize: tokens.fs(12) }}>{heading || `Heading ${index + 1}`}</Text>
          </Pressable>)}
        </View>
        <View testID="reader-scroll" ref={node => { scroll.current = node as unknown as HTMLElement | null; }}
          style={{ height: "60vh" as unknown as number, maxHeight: 600, overflowY: "auto" } as never}>
          <View {...hostFontEscape} ref={node => { body.current = node as unknown as HTMLElement | null; }} style={{ padding: 12 }}>
            <MarkdownView text={text} images={images} cwd={cwd} tokens={tokens} variant={variant} />
          </View>
        </View>
      </View>
    </Modal.Content>
  </Modal>;
}
