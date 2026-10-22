import React, { useRef, useState } from "react";
import { Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import type { PressableProps, TextStyle } from "react-native";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import type { ToolCalloutData } from "../../shared/contracts";
import { DESKTOP_MIN } from "../breakpoints";
import { CopyFallbackDialog } from "./copy-feedback";
import { unselectable } from "./selection";
import type { ExtendedThemeTokens } from "./theme-tokens";

// Summary rows are controls. Keeping selection off here prevents the iOS
// selection loupe from competing with a long press; detail text stays selectable.
export const stepSummaryTextStyle = { ...unselectable, userSelect: "none" } as TextStyle;

type Point = { x: number; y: number };
type MenuEvent = { nativeEvent?: { clientX?: number; clientY?: number; pageX?: number; pageY?: number } };
type ContextEvent = MenuEvent & { preventDefault(): void; stopPropagation(): void };

function gesturePoint(event?: MenuEvent): Point | null {
  const pointer = event?.nativeEvent;
  if (!pointer) return null;
  if (Platform.OS === "web" && Number.isFinite(pointer.clientX) && Number.isFinite(pointer.clientY)) {
    return { x: pointer.clientX!, y: pointer.clientY! };
  }
  if (!Number.isFinite(pointer.pageX) || !Number.isFinite(pointer.pageY)) return null;
  // Web press events expose document coordinates; the Modal uses the viewport.
  // Native page coordinates already refer to the root, not the summary row.
  return {
    x: pointer.pageX! - (Platform.OS === "web" ? globalThis.scrollX ?? 0 : 0),
    y: pointer.pageY! - (Platform.OS === "web" ? globalThis.scrollY ?? 0 : 0),
  };
}

function anchoredOffset(point: number, size: number, available: number): number {
  const start = point + 4 + size <= available - 8 ? point + 4 : point - size - 4;
  return Math.max(8, Math.min(start, available - size - 8));
}

export function useToolStepMenu(data: ToolCalloutData, tokens: ExtendedThemeTokens, onRevealPath?: (path: string) => void) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Point | null>(null);
  const [menuSize, setMenuSize] = useState<{ width: number; height: number } | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);
  const suppressPress = useRef(false);
  const pressPoint = useRef<Point | null>(null);
  const { width, height } = useWindowDimensions();
  const toast = useToast();
  const command = data.shell?.command ?? data.command;
  const path = data.filePath;
  const result = data.copyResult;
  const hasActions = Boolean(command || path || result !== undefined);
  const show = (event?: MenuEvent) => {
    if (!hasActions) return;
    suppressPress.current = true;
    setAnchor(gesturePoint(event) ?? pressPoint.current);
    setMenuSize(null);
    setOpen(true);
  };
  const rowProps = {
    delayLongPress: 500,
    onLongPress: show,
    onPressIn: event => { suppressPress.current = false; pressPoint.current = gesturePoint(event); },
    ...(Platform.OS === "web" ? {
      // The overlay appears under the finger. Cancel the compatibility click
      // so releasing that same touch cannot immediately activate its backdrop.
      onTouchEnd: (event: { preventDefault(): void }) => {
        if (suppressPress.current) event.preventDefault();
      },
      onContextMenu: (event: ContextEvent) => {
        if (!hasActions) return;
        event.preventDefault();
        event.stopPropagation();
        show(event);
      },
    } : {}),
  } as PressableProps;
  const consumePress = () => {
    const suppressed = suppressPress.current;
    suppressPress.current = false;
    return suppressed;
  };
  const copy = async (text: string) => {
    try {
      await copyText(text);
      toast.show("Copied to clipboard", { variant: "success" });
      setOpen(false);
    } catch {
      setOpen(false);
      setFallback(text);
      toast.error("Could not copy. Select all the text in the dialog and use Copy.");
    }
  };
  const action = (id: string, label: string, onPress: () => void) => (
    <Pressable
      testID={id}
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingHorizontal: 16,
        paddingVertical: 10, backgroundColor: pressed ? tokens.surface2 : tokens.surface0 })}
    >
      <Text selectable={false} style={{ ...stepSummaryTextStyle, color: tokens.foreground,
        fontFamily: tokens.fontUi, fontSize: tokens.fs(14), lineHeight: tokens.fs(20) }}>{label}</Text>
    </Pressable>
  );
  return {
    rowProps,
    consumePress,
    menu: <>
      {open ? (
        <Modal transparent visible animationType="none" onRequestClose={() => setOpen(false)} supportedOrientations={["portrait", "landscape"]}>
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 8 }}>
            <Pressable testID="step-menu-dismiss" accessibilityRole="button" accessibilityLabel="Close step actions"
              onPress={() => setOpen(false)} style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#00000040" }} />
            <View testID="tool-step-menu" accessibilityRole="menu" accessibilityLabel="Step actions" accessibilityViewIsModal
              onLayout={event => {
                const { width, height } = event.nativeEvent.layout;
                setMenuSize(previous => previous?.width === width && previous.height === height ? previous : { width, height });
              }}
              style={{ width: Math.max(0, Math.min(280, width - 16)), maxHeight: Math.max(0, height - 16),
                ...(anchor ? { position: "absolute", opacity: menuSize ? 1 : 0,
                  left: anchoredOffset(anchor.x, menuSize?.width ?? Math.min(280, width - 16), width),
                  top: anchoredOffset(anchor.y, menuSize?.height ?? 0, height) } : {}),
                borderRadius: 12, borderWidth: 1, borderColor: tokens.border, overflow: "hidden", backgroundColor: tokens.surface0 }}>
              <ScrollView bounces={false}>
                {command ? action("step-copy-command", "Copy command", () => copy(command)) : null}
                {path ? action("step-copy-path", "Copy path", () => copy(path)) : null}
                {result !== undefined ? action("step-copy-result", "Copy result", () => copy(result)) : null}
                {path && onRevealPath && Platform.OS === "web" && width >= DESKTOP_MIN
                  ? action("step-open-path", "Open in file manager", () => { setOpen(false); onRevealPath(path); }) : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
      <CopyFallbackDialog text={fallback} onClose={() => setFallback(null)} tokens={tokens} />
    </>,
  };
}
