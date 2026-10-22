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

type ContextEvent = { preventDefault(): void; stopPropagation(): void };

export function useToolStepMenu(data: ToolCalloutData, tokens: ExtendedThemeTokens, onRevealPath?: (path: string) => void) {
  const [open, setOpen] = useState(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const suppressPress = useRef(false);
  const { width, height } = useWindowDimensions();
  const toast = useToast();
  const command = data.shell?.command ?? data.command;
  const path = data.filePath;
  const result = data.copyResult;
  const hasActions = Boolean(command || path || result !== undefined);
  const show = () => {
    if (!hasActions) return;
    suppressPress.current = true;
    setOpen(true);
  };
  const rowProps = {
    delayLongPress: 500,
    onLongPress: show,
    onPressIn: () => { suppressPress.current = false; },
    ...(Platform.OS === "web" ? {
      onContextMenu: (event: ContextEvent) => {
        if (!hasActions) return;
        event.preventDefault();
        event.stopPropagation();
        show();
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
              style={{ width: Math.max(0, Math.min(280, width - 16)), maxHeight: Math.max(0, height - 16),
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
