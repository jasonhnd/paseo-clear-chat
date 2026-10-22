import React, { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { View, Text, Pressable } from "react-native";
import { useEnhancerPreferences } from "../preferences";
import { SyntaxHighlightBlock, type SyntaxHighlightProps } from "./syntax-highlight";
import type { ExtendedThemeTokens } from "./theme-tokens";

export const ToolOutputVisibility = createContext<((text: string, expanded: boolean) => void) | undefined>(undefined);

export function ToolOutput({ text, tokens, children }: {
  text: string;
  tokens: ExtendedThemeTokens;
  children: (shown: string) => ReactNode;
}) {
  const { foldLongOutputAfter: limit } = useEnhancerPreferences();
  const reportVisibility = useContext(ToolOutputVisibility);
  const [choice, setChoice] = useState<{ limit: typeof limit; expanded: boolean }>();
  const lines = useMemo(() => text.replace(/\r?\n$/, "").split(/\r?\n/), [text]);
  const folded = limit !== "never" && lines.length > limit;
  const expanded = choice?.limit === limit && choice.expanded;
  useEffect(() => {
    reportVisibility?.(text, Boolean(expanded));
    return () => reportVisibility?.(text, false);
  }, [reportVisibility, text, expanded]);
  const shown = limit !== "never" && folded && !expanded ? lines.slice(0, limit).join("\n") : text;
  return (
    <View testID="tool-output" style={{ gap: 4 }}>
      {children(shown)}
      {folded ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Show fewer lines" : `Show all ${lines.length} lines`}
          accessibilityState={{ expanded: Boolean(expanded) }}
          onPress={() => {
            setChoice({ limit, expanded: !expanded });
            reportVisibility?.(text, !expanded);
          }}
        >
          <Text style={{ color: tokens.accent, fontFamily: tokens.fontUi, fontSize: tokens.fs(11), paddingVertical: 4 }}>
            {expanded ? "Show fewer lines" : `Show all ${lines.length} lines`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function ToolCodeBlock(props: SyntaxHighlightProps) {
  return (
    <ToolOutput text={props.code} tokens={props.tokens}>
      {(code) => <SyntaxHighlightBlock {...props} code={code} copyText={props.copyText ?? props.code} />}
    </ToolOutput>
  );
}
