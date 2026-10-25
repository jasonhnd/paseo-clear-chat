import React, { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { CellRendererProps } from "react-native";
import type { ToolCalloutData } from "../../shared/contracts";
import type { ImageFile } from "../image-file";
import { readOutputLines } from "../read-output";
import { stepTextChunks } from "../step-detail-data";
import { toolDuration } from "../tool-summary";
import { CopyFallbackDialog, useCopyText } from "./copy-feedback";
import { Glyph } from "./glyph";
import { ImagePreview } from "./image-preview";
import { StepDetailStateContext } from "./step-detail-state";
import type { ExtendedThemeTokens } from "./theme-tokens";

type Section = "input" | "output" | "error" | "stdout" | "stderr";
type DetailRow = { key: string; section: Section } & (
  { kind: "heading"; text: string | undefined } | { kind: "text"; text: string; lineNumber?: number; gutterWidth?: number }
);
const titles = { input: "Input", output: "Output", error: "Error", stdout: "Stdout", stderr: "Stderr" };
type ScrollNode = { scrollTop?: number; clientHeight?: number; getScrollableNode?: () => ScrollNode };

function SectionHeading({ section, text, tokens }: { section: Section; text: string | undefined; tokens: ExtendedThemeTokens }) {
  const { copied, handleCopy, fallbackText, setFallbackText } = useCopyText(text ?? "");
  return <View>
    <View style={styles.heading}>
      <Text accessibilityRole="header" style={{ color: tokens.foreground, fontFamily: tokens.fontUi, fontSize: tokens.fs(13), fontWeight: "600" }}>{titles[section]}</Text>
      {text !== undefined ? <Pressable
        testID={`step-detail-copy-${section}`}
        accessibilityRole="button" accessibilityLabel={`Copy ${section}`}
        onPress={handleCopy} style={styles.copy}
      >
        <Glyph name={copied ? "Check" : "Copy"} size={14} color={tokens.accent} />
        <Text style={{ color: tokens.accent, fontFamily: tokens.fontUi, fontSize: tokens.fs(12) }}>{copied ? "Copied" : "Copy"}</Text>
      </Pressable> : null}
    </View>
    {text === undefined || text === "" ? <Text style={{ color: tokens.foregroundMuted, paddingBottom: 12, fontSize: tokens.fs(12) }}>
      {text === undefined ? `No ${section} was reported.` : `Empty ${section}.`}
    </Text> : null}
    <CopyFallbackDialog text={fallbackText} onClose={() => setFallbackText(null)} tokens={tokens} />
  </View>;
}

/** One virtual document: wrapped, bounded text chunks, without nested scrolling. */
export function StepDetailContent({ step, tokens, onRevealPath, imageFile }: {
  step: ToolCalloutData;
  tokens: ExtendedThemeTokens;
  onRevealPath?: (path: string) => void;
  imageFile?: ImageFile | null;
}) {
  const readingState = useContext(StepDetailStateContext);
  const list = useRef<FlatList<DetailRow>>(null);
  // Restore relative to the visible cell: preceding input can wrap differently in a new root.
  const restoreTarget = useRef(readingState?.scrollOffset || undefined);
  const cells = useRef(new Map<string, { y: number; height: number }>());
  const restoreAnchor = useRef(readingState?.scrollAnchor);
  const restoreFrame = useRef<number | undefined>(undefined);
  const active = useRef(true);
  const layout = useRef({ width: 0, height: 0, contentHeight: 0 });
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (restoreFrame.current !== undefined) globalThis.cancelAnimationFrame(restoreFrame.current);
    };
  }, []);
  const restoreScroll = () => {
    if (!active.current || restoreTarget.current === undefined || !list.current || !layout.current.height || !layout.current.contentHeight) return;
    if (restoreFrame.current !== undefined) return;
    let remainingFrames = 60;
    const apply = () => {
      restoreFrame.current = undefined;
      if (!active.current || restoreTarget.current === undefined || !list.current) return;
      const anchor = restoreAnchor.current;
      const cell = anchor && cells.current.get(anchor.key);
      // Wait for the destination cell, rather than accepting an early raw-offset scroll.
      const target = anchor && cell ? cell.y + anchor.offset : restoreTarget.current;
      const native = list.current.getNativeScrollRef?.() as unknown as ScrollNode | null;
      const node = native?.getScrollableNode?.() ?? native;
      if ((!anchor || cell) && node?.clientHeight !== 0) {
        restoreTarget.current = target;
        list.current.scrollToOffset({ offset: target, animated: false });
      }
      if ((!anchor || cell) && typeof node?.scrollTop === "number" && Math.abs(node.scrollTop - target) < 1) {
        if (readingState) readingState.scrollOffset = target;
        restoreTarget.current = undefined;
      }
      if (restoreTarget.current !== undefined && --remainingFrames > 0 && typeof globalThis.requestAnimationFrame === "function") {
        restoreFrame.current = globalThis.requestAnimationFrame(apply);
      } else restoreTarget.current = undefined;
    };
    // Modal handoffs finish laying out their new scroll node on the next frame.
    if (typeof globalThis.requestAnimationFrame === "function") restoreFrame.current = globalThis.requestAnimationFrame(apply);
    else apply();
  };
  // Keep the cell component identity stable while callbacks read the latest restoration state.
  const measured = useRef((key: string, value: { y: number; height: number }) => {});
  measured.current = (key, value) => { cells.current.set(key, value); restoreScroll(); };
  const Cell = useCallback(({ item, onLayout, children, style, onFocusCapture }: CellRendererProps<DetailRow>) => (
    <View style={style} {...{ onFocusCapture }} testID={`step-detail-cell-${item.key}`} onLayout={event => {
      onLayout?.(event);
      measured.current(item.key, event.nativeEvent.layout);
    }}>{children}</View>
  ), []);
  const rows = useMemo(() => {
    const result: DetailRow[] = [];
    const sections: Array<[Section, string | undefined]> = [["input", step.input]];
    if (step.stdout !== undefined) sections.push(["stdout", step.stdout]);
    if (step.stderr !== undefined) sections.push(["stderr", step.stderr]);
    const read = step.tool === "read" && step.copyResult !== undefined ? readOutputLines(step, step.copyResult) : undefined;
    if (step.copyResult !== undefined || (step.stdout === undefined && step.stderr === undefined)) sections.push(["output", step.copyResult === undefined ? undefined : read?.text ?? step.copyResult]);
    if (step.error) sections.unshift(["error", step.error]);
    for (const [section, text] of sections) {
      result.push({ key: `${section}-heading`, section, kind: "heading", text });
      if (text && section === "output" && read) {
        const gutterWidth = tokens.fs(12) * (read.lines.reduce((digits, line) => Math.max(digits, String(line.lineNumber ?? "").length), 1) * 0.65 + 1.5);
        read.lines.forEach((line, index) => result.push({ key: `${section}-${index}`, section, kind: "text", ...line, gutterWidth }));
      } else if (text) stepTextChunks(text).forEach((chunk, index) => result.push({ key: `${section}-${index}`, section, kind: "text", text: chunk }));
    }
    return result;
  }, [step.tool, step.filePath, step.input, step.copyResult, step.error, step.stdout, step.stderr, tokens]);
  const duration = toolDuration(step.durationMs);
  const exitCode = typeof step.exitCode === "number" && Number.isInteger(step.exitCode) ? step.exitCode : undefined;
  return <View testID="tool-card-body" style={styles.body}>
    <FlatList
      ref={list}
      testID="step-detail-scroll"
      style={styles.body}
      contentContainerStyle={styles.content}
      data={rows}
      CellRendererComponent={Cell}
      keyExtractor={row => row.key}
      initialNumToRender={8}
      maxToRenderPerBatch={step.tool === "read" ? 32 : 4}
      windowSize={5}
      updateCellsBatchingPeriod={16}
      scrollEventThrottle={16}
      contentOffset={{ x: 0, y: readingState?.scrollOffset ?? 0 }}
      onLayout={event => {
        const { width, height } = event.nativeEvent.layout;
        if (layout.current.width && (width !== layout.current.width || height !== layout.current.height)) {
          if (restoreTarget.current === undefined) {
            restoreTarget.current = readingState?.scrollOffset || undefined;
            restoreAnchor.current = readingState?.scrollAnchor;
          }
          if (width !== layout.current.width) cells.current.clear();
        }
        Object.assign(layout.current, { width, height });
        restoreScroll();
      }}
      onContentSizeChange={(_, contentHeight) => { layout.current.contentHeight = contentHeight; restoreScroll(); }}
      onScroll={event => {
        if (event.nativeEvent.layoutMeasurement?.height === 0 || event.nativeEvent.layoutMeasurement?.width === 0) return;
        const offset = event.nativeEvent.contentOffset.y;
        const anchor = restoreAnchor.current;
        const cell = anchor && cells.current.get(anchor.key);
        const target = restoreTarget.current === undefined ? undefined
          : anchor && cell ? cell.y + anchor.offset : restoreTarget.current;
        if (active.current && readingState && (target === undefined || ((!anchor || cell) && Math.abs(offset - target) < 1))) {
          readingState.scrollOffset = offset;
          restoreTarget.current = undefined;
          let first: { key: string; y: number } | undefined;
          for (const [key, cell] of cells.current) {
            if (cell.y <= offset && cell.y + cell.height > offset && (!first || cell.y > first.y)) first = { key, y: cell.y };
          }
          readingState.scrollAnchor = first ? { key: first.key, offset: offset - first.y } : undefined;
        }
      }}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      ListHeaderComponent={<View style={styles.metadata}>
        <Text style={{ color: tokens.foregroundMuted, fontSize: tokens.fs(12) }}>Status: {step.status}</Text>
        {duration !== undefined ? <Text testID="step-detail-duration" style={{ color: tokens.foregroundMuted, fontSize: tokens.fs(12) }}>{`Duration: ${duration}`}</Text> : null}
        {exitCode !== undefined ? <Text testID="step-detail-exit-code" style={{ color: exitCode ? tokens.danger : tokens.foregroundMuted, fontSize: tokens.fs(12) }}>{`Exit code: ${exitCode}`}</Text> : null}
        {step.filePath ? <Text selectable onPress={onRevealPath ? () => onRevealPath(step.filePath!) : undefined} style={{ color: tokens.accent, fontFamily: tokens.fontMono, fontSize: tokens.fs(12) }}>{step.filePath}</Text> : null}
        {step.filePath && imageFile !== undefined ? <ImagePreview path={step.filePath} file={imageFile} tokens={tokens} onReveal={onRevealPath ? () => onRevealPath(step.filePath!) : undefined} /> : null}
      </View>}
      renderItem={({ item }) => item.kind === "heading"
        ? <SectionHeading section={item.section} text={item.text} tokens={tokens} />
        : item.kind === "text" && item.lineNumber !== undefined ? <View testID="step-detail-read-line" style={{ flexDirection: "row", alignItems: "flex-start", minWidth: 0 }}>
            <Text testID="step-detail-line-number" selectable={false} accessible={false} style={{
              width: item.gutterWidth, flexShrink: 0, paddingRight: tokens.fs(10), textAlign: "right",
              color: tokens.foregroundMuted, fontFamily: tokens.fontMono, fontSize: tokens.fs(12), lineHeight: tokens.fs(18),
              ...(Platform.OS === "web" ? { userSelect: "none" as const } : {}),
            }}>{item.lineNumber}</Text>
            <Text testID="step-detail-output" selectable style={{
              flex: 1, minWidth: 0, minHeight: tokens.fs(18), color: tokens.foreground, fontFamily: tokens.fontMono,
              fontSize: tokens.fs(12), lineHeight: tokens.fs(18),
              ...(Platform.OS === "web" ? { overflowWrap: "anywhere" as const } : {}),
            }}>{item.text.replace(/\r?\n$/, "")}</Text>
          </View> : <Text
            testID={`step-detail-${item.section}`}
            selectable
            style={{ color: item.section === "error" || item.section === "stderr" ? tokens.danger : tokens.foreground, fontFamily: item.section === "input" ? tokens.fontCode : tokens.fontMono, fontSize: tokens.fs(12), lineHeight: tokens.fs(18), flexShrink: 1 }}
          >{item.text.replace(/\r?\n$/, "")}</Text>}
    />
  </View>;
}

const styles = StyleSheet.create({
  body: { flex: 1, minHeight: 0, minWidth: 0 },
  content: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24 },
  metadata: { gap: 6 },
  heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 48, gap: 8, marginTop: 8 },
  copy: { flexDirection: "row", gap: 6, minWidth: 64, minHeight: 44, alignItems: "center", justifyContent: "center" },
});
