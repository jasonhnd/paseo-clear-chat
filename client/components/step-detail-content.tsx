import React, { useContext, useMemo, useRef } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { ToolCalloutData } from "../../shared/contracts";
import type { ImageFile } from "../image-file";
import { stepTextChunks } from "../step-detail-data";
import { toolDuration } from "../tool-summary";
import { CopyFallbackDialog, useCopyText } from "./copy-feedback";
import { Glyph } from "./glyph";
import { ImagePreview } from "./image-preview";
import { StepDetailStateContext } from "./step-detail-state";
import type { ExtendedThemeTokens } from "./theme-tokens";

type Section = "input" | "output" | "error";
type DetailRow = { key: string; section: Section } & (
  { kind: "heading"; text: string | undefined } | { kind: "text"; text: string }
);
const titles = { input: "Input", output: "Output", error: "Error" };

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
  // Restore after mounting or resizing; virtual cell measurements keep the current position.
  const restoreTarget = useRef(readingState?.scrollOffset);
  const layout = useRef({ width: 0, height: 0, contentHeight: 0 });
  const restoreScroll = () => {
    if (restoreTarget.current === undefined || !list.current || !layout.current.height || !layout.current.contentHeight) return;
    list.current.scrollToOffset({ offset: restoreTarget.current, animated: false });
    restoreTarget.current = undefined;
  };
  const rows = useMemo(() => {
    const result: DetailRow[] = [];
    const sections: Array<[Section, string | undefined]> = [["input", step.input], ["output", step.copyResult]];
    if (step.error) sections.unshift(["error", step.error]);
    for (const [section, text] of sections) {
      result.push({ key: `${section}-heading`, section, kind: "heading", text });
      if (text) stepTextChunks(text).forEach((chunk, index) => result.push({ key: `${section}-${index}`, section, kind: "text", text: chunk }));
    }
    return result;
  }, [step.input, step.copyResult, step.error]);
  const duration = toolDuration(step.durationMs);
  const exitCode = typeof step.exitCode === "number" && Number.isInteger(step.exitCode) ? step.exitCode : undefined;
  return <View testID="tool-card-body" style={styles.body}>
    <FlatList
      ref={list}
      testID="step-detail-scroll"
      style={styles.body}
      contentContainerStyle={styles.content}
      data={rows}
      keyExtractor={row => row.key}
      initialNumToRender={8}
      maxToRenderPerBatch={4}
      windowSize={5}
      updateCellsBatchingPeriod={16}
      scrollEventThrottle={16}
      contentOffset={{ x: 0, y: readingState?.scrollOffset ?? 0 }}
      onLayout={event => {
        const { width, height } = event.nativeEvent.layout;
        if (layout.current.width && (width !== layout.current.width || height !== layout.current.height)) restoreTarget.current = readingState?.scrollOffset;
        Object.assign(layout.current, { width, height });
        restoreScroll();
      }}
      onContentSizeChange={(_, contentHeight) => { layout.current.contentHeight = contentHeight; restoreScroll(); }}
      onScroll={event => { if (readingState) readingState.scrollOffset = event.nativeEvent.contentOffset.y; }}
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
        : <Text
            testID={`step-detail-${item.section}`}
            selectable
            style={{ color: item.section === "error" ? tokens.danger : tokens.foreground, fontFamily: item.section === "input" ? tokens.fontCode : tokens.fontMono, fontSize: tokens.fs(12), lineHeight: tokens.fs(18), flexShrink: 1 }}
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
