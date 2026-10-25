import { useTranslation } from "@getpaseo/plugin/client";
import { messages } from "../messages";
import React, { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { View, Text, Pressable } from "react-native";
import { useEnhancerPreferences } from "../preferences";
import { SyntaxHighlightBlock, type SyntaxHighlightProps } from "./syntax-highlight";
import type { ExtendedThemeTokens } from "./theme-tokens";
import { useStepDetailState } from "./step-detail-state";

export const ToolOutputVisibility = createContext<((text: string, expanded: boolean) => void) | undefined>(undefined);

export interface OutputExpansion {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  error: string | null;
}

export function ToolOutput({ text, tokens, children, expansion }: {
  text: string;
  tokens: ExtendedThemeTokens;
  children: (shown: string) => ReactNode;
  expansion?: OutputExpansion;
}) {
  const { t } = useTranslation(messages);
  const { foldLongOutputAfter: limit } = useEnhancerPreferences();
  const reportVisibility = useContext(ToolOutputVisibility);
  const [choice, setChoice] = useStepDetailState<{ limit: typeof limit; expanded: boolean } | undefined>(`output:${text}`, undefined);
  const lines = useMemo(() => text.replace(/\r?\n$/, "").split(/\r?\n/), [text]);
  const folded = limit !== "never" && lines.length > limit;
  const expanded = expansion?.expanded ?? (choice?.limit === limit && choice.expanded);
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
          accessibilityLabel={expanded ? t("fold.showFewer") : t("fold.showAll", { count: lines.length })}
          accessibilityState={{ expanded: Boolean(expanded) }}
          style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }}
          onPress={() => {
            if (expansion) expansion.onExpandedChange(!expanded);
            else setChoice({ limit, expanded: !expanded });
            reportVisibility?.(text, !expanded);
          }}
        >
          <Text style={{ color: tokens.accent, fontFamily: tokens.fontUi, fontSize: tokens.fs(11), paddingVertical: 4 }}>
            {expanded ? t("fold.showFewer") : t("fold.showAll", { count: lines.length })}
          </Text>
        </Pressable>
      ) : null}
      {expansion?.error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.danger, fontSize: tokens.fs(11) }}>
          {t("fold.saveFailed")}
        </Text>
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
