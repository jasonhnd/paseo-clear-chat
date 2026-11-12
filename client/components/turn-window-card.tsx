import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ExtendedThemeTokens } from "./theme-tokens";

export type TurnWindowSnapshot = { files: string[]; message: string | null; warning: string | null; incomplete: boolean };

/** Renders only a snapshot already attached to this reply. No fetching, no timeline reads. */
export function TurnWindowCard({ snapshot, tokens }: { snapshot?: TurnWindowSnapshot | null; tokens: ExtendedThemeTokens }) {
  const [open, setOpen] = useState(false);
  if (!snapshot) return null;
  const files = snapshot.files ?? [];
  if (!files.length) {
    if (!snapshot.message && !snapshot.warning && !snapshot.incomplete) return null;
    return <View testID="turn-window-card">
      {snapshot.message ? <Text selectable style={{ color: tokens.foregroundMuted }}>{snapshot.message}</Text> : null}
      {snapshot.warning ? <Text selectable style={{ color: tokens.foregroundMuted }}>{snapshot.warning}</Text> : null}
      {snapshot.incomplete && !snapshot.message ? <Text selectable style={{ color: tokens.foregroundMuted }}>Snapshot timing or overlap with other conversations may be incomplete.</Text> : null}
    </View>;
  }
  return <View testID="turn-window-card" style={{ marginTop: 8, padding: 10, borderWidth: 1, borderColor: tokens.border, borderRadius: 8 }}>
    <Pressable testID="turn-window-toggle" accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)}>
      <Text style={{ color: tokens.foreground, fontSize: tokens.fs(12) }}>Workspace changes during this turn {open ? "▴" : "▾"}</Text>
    </Pressable>
    {open ? <View style={{ gap: 4, marginTop: 8 }}>
      {snapshot.message ? <Text selectable style={{ color: tokens.foregroundMuted }}>{snapshot.message}</Text> : null}
      {snapshot.warning ? <Text selectable style={{ color: tokens.foregroundMuted }}>{snapshot.warning}</Text> : null}
      {snapshot.incomplete ? <Text selectable style={{ color: tokens.foregroundMuted }}>Snapshot timing or overlap with other conversations may be incomplete.</Text> : null}
      {files.map(file => <Text selectable key={file} style={{ color: tokens.foreground }}>{file}</Text>)}
    </View> : null}
  </View>;
}

