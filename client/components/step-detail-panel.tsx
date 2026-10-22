import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal, PanResponder, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View,
  useWindowDimensions,
} from "react-native";
import type { ViewProps, ViewStyle } from "react-native";
import type { StepDetailPresentation } from "../breakpoints";
import { installStepDetailBack } from "../step-detail-back";
import { installStepDetailKeyboard } from "../step-detail-keyboard";
import type { ToolCalloutData } from "../../shared/contracts";
import type { ImageFile } from "../image-file";
import type { ExtendedThemeTokens } from "./theme-tokens";
import { ToolCalloutBody } from "./tool-callouts";
import { toolSummary } from "../tool-summary";
import { Glyph } from "./glyph";
import { hostFontEscape } from "./host-font-escape";
import { surfaceProps } from "./view-props";

export type { StepDetailPresentation } from "../breakpoints";

export interface StepDetailPanelProps {
  /** The selected step, kept separate from the timeline's persisted folding state. */
  step: ToolCalloutData | null;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Use the viewport breakpoint, rather than the width of the host side panel. */
  presentation: StepDetailPresentation;
  tokens: ExtendedThemeTokens;
  onRevealPath?: (path: string) => void;
  imageFile?: ImageFile | null;
}

type SheetSnap = "half" | "full";

export function sheetSnapAfterDrag(height: number, startHeight: number, dy: number, velocity: number): SheetSnap | "closed" {
  const projected = startHeight - dy - velocity * 100;
  if (projected < height * 0.28) return "closed";
  return projected > height * 0.75 ? "full" : "half";
}

/** One body for the phone sheet, tablet popover and host-owned desktop pane. */
export function StepDetailPanel({ step, open, onOpenChange, presentation, tokens, onRevealPath, imageFile }: StepDetailPanelProps) {
  const window = useWindowDimensions();
  const [availableHeight, setAvailableHeight] = useState(window.height);
  const [snap, setSnap] = useState<SheetSnap>("half");
  const [drag, setDrag] = useState(0);
  const onChange = useRef(onOpenChange);
  onChange.current = onOpenChange;
  const close = useCallback(() => onChange.current(false), []);
  const height = Math.min(window.height, availableHeight);
  const snapHeight = snap === "full" ? height : height / 2;
  const startHeight = useRef(snapHeight);

  useEffect(() => {
    if (!open || presentation !== "sheet") {
      setSnap("half");
      setDrag(0);
    }
  }, [open, presentation]);
  useEffect(() => {
    if (!open || !step || presentation === "side") return;
    return installStepDetailBack(close);
  }, [open, Boolean(step), presentation === "side", close]);

  useEffect(() => {
    if (open && step) return installStepDetailKeyboard(close);
  }, [open, Boolean(step), close]);

  const resize = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderGrant: () => { startHeight.current = snapHeight; },
    onPanResponderMove: (_, gesture) => setDrag(gesture.dy),
    onPanResponderRelease: (_, gesture) => {
      const next = sheetSnapAfterDrag(height, startHeight.current, gesture.dy, gesture.vy);
      setDrag(0);
      if (next === "closed") close(); else setSnap(next);
    },
    onPanResponderTerminate: () => setDrag(0),
    onPanResponderTerminationRequest: () => false,
  }), [snapHeight, height, close]);

  const backEdge = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => gesture.dx > 10 && gesture.dx > Math.abs(gesture.dy) * 2,
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx > 72 || (gesture.dx > 24 && gesture.vx > 0.5)) close();
    },
  }), [close]);

  if (!open || !step) return null;

  const panel = (
    <View
      {...surfaceProps(hostFontEscape, { dataSet: { presentation, ...(presentation === "sheet" ? { snap } : {}) } } as ViewProps)}
      testID="step-detail-panel"
      accessibilityLabel="Step details"
      accessibilityViewIsModal={presentation !== "side"}
      onAccessibilityEscape={close}
      style={[
        styles.panel,
        { backgroundColor: tokens.surface0, borderColor: tokens.border },
        presentation === "sheet" ? [styles.sheet, { height: Math.max(0, Math.min(height, snapHeight - drag)) }] :
          presentation === "popover" ? styles.popover : styles.side,
      ]}
    >
      {presentation === "sheet" ? (
        <View
          testID="step-detail-drag-handle"
          accessibilityRole="adjustable"
          accessibilityLabel="Resize step details"
          accessibilityValue={{ text: snap === "half" ? "Half screen" : "Full screen" }}
          accessibilityHint="Drag up for full screen, down for half screen, or further down to close."
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }, { name: "escape" }]}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === "increment") setSnap("full");
            else if (nativeEvent.actionName === "escape" || snap === "half") close();
            else setSnap("half");
          }}
          {...resize.panHandlers}
          style={[styles.handle, touchGestureStyle]}
        >
          <View style={[styles.grip, { backgroundColor: tokens.foregroundMuted }]} />
        </View>
      ) : null}
      <View style={[styles.header, { borderBottomColor: tokens.border }]}>
        <Text style={[styles.title, { fontFamily: tokens.fontUi, color: tokens.foreground, fontSize: tokens.fs(14) }]} numberOfLines={2}>
          {toolSummary(step)}
        </Text>
        {presentation === "sheet" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={snap === "half" ? "Expand step details" : "Half-screen step details"}
            onPress={() => setSnap(snap === "half" ? "full" : "half")}
            style={styles.button}
          >
            <Glyph name={snap === "half" ? "Maximize2" : "Minimize2"} size={18} color={tokens.foregroundMuted} />
          </Pressable>
        ) : null}
        <Pressable testID="step-detail-close" accessibilityRole="button" accessibilityLabel="Close step details" onPress={close} style={styles.button}>
          <Glyph name="X" size={18} color={tokens.foregroundMuted} />
        </Pressable>
      </View>
      <ScrollView style={styles.scroll} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ToolCalloutBody data={step} tokens={tokens} onRevealPath={onRevealPath} imageFile={imageFile} />
      </ScrollView>
    </View>
  );

  if (presentation === "side") return panel;
  return (
    <Modal transparent visible={open} animationType={presentation === "sheet" ? "slide" : "fade"} onRequestClose={close}>
      <View style={styles.overlay}>
        <Pressable testID="step-detail-backdrop" accessibilityRole="button" accessibilityLabel="Dismiss step details" onPress={close} style={styles.backdrop} />
        <SafeAreaView pointerEvents="box-none" style={styles.safeArea}>
          <View
            pointerEvents="box-none"
            onLayout={event => setAvailableHeight(event.nativeEvent.layout.height)}
            style={[styles.viewport, presentation === "sheet" ? styles.bottom : styles.center]}
          >
            {panel}
          </View>
        </SafeAreaView>
        <View testID="step-detail-back-edge" {...backEdge.panHandlers} style={[styles.backEdge, touchGestureStyle]} accessible={false} />
      </View>
    </Modal>
  );
}

// Keep browser scrolling from canceling the dedicated resize and back gestures.
const touchGestureStyle = Platform.OS === "web" ? { touchAction: "none" } as ViewStyle : undefined;

const styles = StyleSheet.create({
  overlay: { flex: 1 },
  backdrop: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, backgroundColor: "rgba(0,0,0,0.45)" },
  safeArea: { flex: 1 },
  viewport: { flex: 1, minHeight: 0 },
  bottom: { justifyContent: "flex-end" },
  center: { justifyContent: "center", alignItems: "center", padding: 24 },
  panel: { minHeight: 0, overflow: "hidden" },
  sheet: { width: "100%", borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: 1 },
  popover: { width: "100%", maxWidth: 680, height: "80%", borderWidth: 1, borderRadius: 16 },
  side: { flex: 1, alignSelf: "stretch" },
  header: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 8, paddingVertical: 4, borderBottomWidth: 1, gap: 4 },
  title: { flex: 1, minWidth: 0, fontWeight: "600" },
  button: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  handle: { height: 28, alignItems: "center", justifyContent: "center" },
  grip: { width: 40, height: 4, borderRadius: 2 },
  scroll: { flex: 1, minHeight: 0 },
  content: { padding: 8, paddingBottom: 24 },
  backEdge: { position: "absolute", left: 0, top: 0, bottom: 0, width: 20 },
});
