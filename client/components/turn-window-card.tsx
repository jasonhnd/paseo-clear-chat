import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as pluginClient from "@getpaseo/plugin/client";
import { messages } from "../messages";
import type { ExtendedThemeTokens } from "./theme-tokens";

export type TurnWindowSnapshot = {
  files: string[]; message: string | null; warning: string | null; incomplete: boolean;
  messageCode?: string | null; warningCode?: string | null;
};

const FALLBACK: Record<string, string> = {
  turnHeadChanged: "Git HEAD changed during this period; the status difference may be incomplete.",
  turnInterrupted: "The turn ended before it completed; the observed change set may be incomplete.",
  turnNotGit: "This workspace is not a Git repository; changes cannot be shown yet.",
  turnIncomplete: "Snapshot timing or overlap with other conversations may be incomplete.",
  turnOverlap: "Other conversations were running in this workspace during this period, so these changes may not all belong to this turn.",
};

/** Renders only a snapshot already attached to this reply. No fetching, no timeline reads. */
export function TurnWindowCard({ snapshot, tokens }: { snapshot?: TurnWindowSnapshot | null; tokens: ExtendedThemeTokens }) {
  const [open, setOpen] = useState(false);
  const { t } = pluginClient.useTranslation(messages);
  const say = (code?: string | null, text?: string | null): string | null => {
    if (!code) return text ?? null;
    const key = `sidebar.${code}`;
    const translated = t(key);
    if (translated && translated !== key) return translated;
    return text ?? FALLBACK[code] ?? null;
  };
  if (!snapshot) return null;
  const files = snapshot.files ?? [];
  const message = say(snapshot.messageCode, snapshot.message);
  const warning = say(snapshot.warningCode, snapshot.warning);
  const incompleteText = snapshot.incomplete && !message ? say("turnIncomplete") : null;
  if (!files.length) {
    if (!message && !warning && !incompleteText) return null;
    return <View testID="turn-window-card">
      {message ? <Text selectable style={{ color: tokens.foregroundMuted }}>{message}</Text> : null}
      {warning ? <Text selectable style={{ color: tokens.foregroundMuted }}>{warning}</Text> : null}
      {incompleteText ? <Text selectable style={{ color: tokens.foregroundMuted }}>{incompleteText}</Text> : null}
    </View>;
  }
  return <View testID="turn-window-card" style={{ marginTop: 8, padding: 10, borderWidth: 1, borderColor: tokens.border, borderRadius: 8 }}>
    <Pressable testID="turn-window-toggle" accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)}>
      <Text style={{ color: tokens.foreground, fontSize: tokens.fs(12) }}>Workspace changes during this turn {open ? "▴" : "▾"}</Text>
    </Pressable>
    {open ? <View style={{ gap: 4, marginTop: 8 }}>
      {message ? <Text selectable style={{ color: tokens.foregroundMuted }}>{message}</Text> : null}
      {warning ? <Text selectable style={{ color: tokens.foregroundMuted }}>{warning}</Text> : null}
      {incompleteText ? <Text selectable style={{ color: tokens.foregroundMuted }}>{incompleteText}</Text> : null}
      {files.map(file => <Text selectable key={file} style={{ color: tokens.foreground }}>{file}</Text>)}
    </View> : null}
  </View>;
}
