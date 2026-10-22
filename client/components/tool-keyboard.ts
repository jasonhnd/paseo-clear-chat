import { useState } from "react";
import type { KeyboardEvent } from "react";
import { Platform, type PressableProps, type ViewStyle } from "react-native";
import type { ExtendedThemeTokens } from "./theme-tokens";

/** Only a focused step owns these keys; editors and host shortcuts keep theirs. */
export function useToolKeyboard(scope: string, activate: () => void, tokens: ExtendedThemeTokens) {
  const [focused, setFocused] = useState(false);
  const web = Platform.OS === "web";
  const rowProps = {
    focusable: true,
    ...(web ? {
      onFocus: (event: { currentTarget: unknown; target: unknown }) => {
        if (event.target !== event.currentTarget) return;
        const node = event.currentTarget as HTMLElement;
        setFocused(Boolean(node.matches?.(":focus-visible")));
      },
      onBlur: () => setFocused(false),
      dataSet: { clearChatStep: scope },
      onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => {
        const row = event.currentTarget;
        if (event.defaultPrevented || event.target !== row || row.ownerDocument.activeElement !== row ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown" && event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        setFocused(true);
        if (event.key === "Enter") {
          // Capture precedes Pressable's built-in Enter activation, so it runs once.
          if (!event.repeat) activate();
          return;
        }
        // Read mounted plugin rows in visual timeline order, without touching host DOM.
        const rows = Array.from(row.ownerDocument.querySelectorAll<HTMLElement>("[data-clear-chat-step]"))
          .filter(node => node.getAttribute("data-clear-chat-step") === scope && node.getClientRects().length > 0 &&
            !node.closest('[inert], [aria-hidden="true"], [aria-disabled="true"]'));
        const index = rows.indexOf(row);
        if (index < 0) return;
        const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
        if (next) {
          next.focus({ preventScroll: true });
          next.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
      },
    } : {}),
  } as PressableProps;
  const focusStyle = web ? {
    outlineStyle: focused ? "solid" : "none", outlineColor: tokens.accent, outlineWidth: 2, outlineOffset: -2,
  } as ViewStyle : undefined;
  return { rowProps, focusStyle, clearFocus: () => setFocused(false) };
}
