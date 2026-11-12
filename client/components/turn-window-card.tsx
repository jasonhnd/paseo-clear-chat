import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ExtendedThemeTokens } from "./theme-tokens";

export type TurnWindowFileStats = {
  added: number | null;
  deleted: number | null;
  binary: boolean;
  renamedFrom: string | null;
  diff: string | null;
  truncated: boolean;
  note: string | null;
};

export type TurnWindowSnapshot = {
  files: string[];
  details?: Record<string, TurnWindowFileStats>;
  message: string | null;
  warning: string | null;
  incomplete: boolean;
};

function fileLabel(file: string, stats: TurnWindowFileStats | undefined): string {
  if (!stats) return file;
  if (stats.added !== null && stats.deleted !== null) return `${file}  +${stats.added} / -${stats.deleted}`;
  return file;
}

function fileNote(file: string, stats: TurnWindowFileStats | undefined): string | null {
  if (!stats) return null;
  const parts: string[] = [];
  const noteText = stats.note ?? "";
  if (stats.renamedFrom) parts.push(`renamed from ${stats.renamedFrom}`);
  if (stats.binary && !noteText.toLowerCase().includes("binary")) parts.push("binary file");
  if (noteText && !parts.includes(noteText)) parts.push(noteText);
  if (stats.added === null && stats.deleted === null && !stats.binary && !noteText) parts.push("no textual diff");
  return parts.length ? parts.join(" · ") : null;
}

/** Renders only a snapshot already attached to this reply. No fetching, no timeline reads. */
export function TurnWindowCard({ snapshot, tokens }: { snapshot?: TurnWindowSnapshot | null; tokens: ExtendedThemeTokens }) {
  const [open, setOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
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
      {files.map((file, index) => {
        const stats = snapshot.details?.[file];
        const note = fileNote(file, stats);
        const hasDiff = Boolean(stats?.diff);
        const expanded = hasDiff && openFile === file;
        return <View key={file} style={{ gap: 2 }}>
          <Pressable testID={`turn-window-file-${index}`} accessibilityRole="button" disabled={!hasDiff} accessibilityState={{ expanded }} onPress={hasDiff ? () => setOpenFile(value => value === file ? null : file) : undefined}>
            <Text selectable style={{ color: tokens.foreground }}>{fileLabel(file, stats)}{hasDiff ? (expanded ? "  ▴" : "  ▾") : ""}</Text>
            {note ? <Text selectable style={{ color: tokens.foregroundMuted, fontSize: tokens.fs(11) }}>{note}</Text> : null}
          </Pressable>
          {expanded && stats?.diff ? <View testID={`turn-window-diff-${index}`} style={{ padding: 8, borderWidth: 1, borderColor: tokens.border, borderRadius: 6, backgroundColor: tokens.surface1 }}>
            <Text selectable style={{ color: tokens.foreground, fontSize: tokens.fs(11), fontFamily: "monospace" }}>{stats.diff}</Text>
          </View> : null}
        </View>;
      })}
    </View> : null}
  </View>;
}
