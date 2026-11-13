import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as pluginClient from "@getpaseo/plugin/client";
import { messages } from "../messages";
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
  messageCode?: string | null;
  warningCode?: string | null;
};

const FALLBACK: Record<string, string> = {
  turnHeadChanged: "Git HEAD changed during this period; the status difference may be incomplete.",
  turnInterrupted: "The turn ended before it completed; the observed change set may be incomplete.",
  turnNotGit: "This workspace is not a Git repository; changes cannot be shown yet.",
  turnIncomplete: "Snapshot timing or overlap with other conversations may be incomplete.",
  turnOverlap: "Other conversations were running in this workspace during this period, so these changes may not all belong to this turn.",
};

function fileLabel(file: string, stats: TurnWindowFileStats | undefined): string {
  if (!stats) return file;
  if (stats.added !== null && stats.deleted !== null) return `${file}  +${stats.added} / -${stats.deleted}`;
  return file;
}

/** Translate a server-side English note into the reader's language. */
function localizeNote(note: string, tr: (key: string, fallback: string) => string): string {
  return note.split("; ").map(part => {
    if (part === "binary file") return tr("turnBinaryFile", part);
    if (part === "untracked or no textual diff in Git") return tr("turnUntrackedNoTextDiff", part);
    if (part === "no textual diff in Git") return tr("turnNoTextDiff", part);
    if (part === "no diff available from Git") return tr("turnNoDiffAvailable", part);
    if (part === "diff truncated") return tr("turnDiffTruncated", part);
    if (part === "diff omitted (file limit)") return tr("turnDiffOmittedFileLimit", part);
    if (part === "diff omitted (total size limit)") return tr("turnDiffOmittedTotalLimit", part);
    if (part.startsWith("renamed to ")) return `${tr("turnRenamedTo", "renamed to")} ${part.slice("renamed to ".length)}`;
    if (part.startsWith("renamed from ")) return `${tr("turnRenamedFrom", "renamed from")} ${part.slice("renamed from ".length)}`;
    return part;
  }).join(" · ");
}

function fileNote(file: string, stats: TurnWindowFileStats | undefined, tr: (key: string, fallback: string) => string): string | null {
  if (!stats) return null;
  const parts: string[] = [];
  const noteText = stats.note ?? "";
  if (stats.renamedFrom) parts.push(`${tr("turnRenamedFrom", "renamed from")} ${stats.renamedFrom}`);
  if (stats.binary && !noteText.toLowerCase().includes("binary")) parts.push(tr("turnBinaryFile", "binary file"));
  if (noteText && !parts.includes(noteText)) parts.push(localizeNote(noteText, tr));
  if (stats.added === null && stats.deleted === null && !stats.binary && !noteText) parts.push(tr("turnNoTextualDiffShort", "no textual diff"));
  return parts.length ? parts.join(" · ") : null;
}

/** Renders only a snapshot already attached to this reply. No fetching, no timeline reads. */
export function TurnWindowCard({ snapshot, tokens }: { snapshot?: TurnWindowSnapshot | null; tokens: ExtendedThemeTokens }) {
  const [open, setOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const { t } = pluginClient.useTranslation(messages);
  // The typed t() only accepts literal keys, so call it through a widened signature.
  const translate = t as unknown as (value: string) => string;
  const say = (code?: string | null, text?: string | null): string | null => {
    if (!code) return text ?? null;
    const key = `sidebar.${code}`;
    const translated = translate(key);
    if (translated && translated !== key) return translated;
    return text ?? FALLBACK[code] ?? null;
  };
  const tr = (key: string, fallback: string): string => {
    const full = `sidebar.${key}`;
    const translated = translate(full);
    return translated && translated !== full ? translated : fallback;
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
      <Text style={{ color: tokens.foreground, fontSize: tokens.fs(12) }}>{tr("turnWindowTitle", "Workspace changes during this turn")} {open ? "▴" : "▾"}</Text>
    </Pressable>
    {open ? <View style={{ gap: 4, marginTop: 8 }}>
      {message ? <Text selectable style={{ color: tokens.foregroundMuted }}>{message}</Text> : null}
      {warning ? <Text selectable style={{ color: tokens.foregroundMuted }}>{warning}</Text> : null}
      {incompleteText ? <Text selectable style={{ color: tokens.foregroundMuted }}>{incompleteText}</Text> : null}
      {files.map((file, index) => {
        const stats = snapshot.details?.[file];
        const note = fileNote(file, stats, tr);
        const hasDiff = Boolean(stats?.diff);
        const expanded = hasDiff && openFile === file;
        return <View key={file} style={{ gap: 2 }}>
          <Pressable testID={`turn-window-file-${index}`} accessibilityRole="button" disabled={!hasDiff} accessibilityState={{ expanded }} onPress={hasDiff ? () => setOpenFile(value => value === file ? null : file) : undefined}>
            <Text selectable style={{ color: tokens.foreground }}>{fileLabel(file, stats)}{hasDiff ? (expanded ? "  ▴" : "  ▾") : ""}</Text>
            {note ? <Text selectable style={{ color: tokens.foregroundMuted, fontSize: tokens.fs(11) }}>{note}</Text> : null}
          </Pressable>
          {expanded && stats?.diff ? <View testID={`turn-window-diff-${index}`} style={{ padding: 8, borderWidth: 1, borderColor: tokens.border, borderRadius: 6, backgroundColor: tokens.surface1 }}>
            <Text selectable style={{ color: tokens.foreground, fontSize: tokens.fs(11), fontFamily: "monospace" }}>{stats.diff.replace("... [diff truncated]", tr("turnDiffTruncated", "diff truncated"))}</Text>
          </View> : null}
        </View>;
      })}
    </View> : null}
  </View>;
}
