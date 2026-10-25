import { translate as t } from "./translation";
import type { ToolCalloutData } from "../shared/contracts";
import { record } from "./tool-detail";

interface Replacement { oldText: string; newText: string }
interface DiffLine { marker: " " | "-" | "+"; text: string }
interface EditDiff {
  diff: string;
  changes?: ToolCalloutData["changes"];
}

const oldKeys = ["oldString", "old_string", "oldText", "old_text"];
const newKeys = ["newString", "new_string", "newText", "new_text"];
// Bound the comparison work on the client for unusually large replacements.
const MAX_DIFF_CELLS = 250_000;

function textField(sources: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const source of sources) {
    for (const key of keys) {
      if (typeof source[key] === "string") return source[key];
    }
  }
  return undefined;
}

function replacement(sources: Record<string, unknown>[]): Replacement[] {
  const newText = textField(sources, newKeys);
  // A missing new value can be an incomplete streamed call, not a deletion.
  if (newText === undefined) return [];
  return [{ oldText: textField(sources, oldKeys) ?? "", newText }];
}

function textLines(text: string): string[] {
  // Retain final newline information without adding a phantom trailing row.
  return text.replace(/\r\n/g, "\n").match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function compareLines(before: string[], after: string[]): DiffLine[] {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const rows: DiffLine[] = before.slice(0, start).map(text => ({ marker: " ", text }));
  const oldCount = oldEnd - start, newCount = newEnd - start;
  const width = newCount + 1;
  if ((oldCount + 1) * width > MAX_DIFF_CELLS) {
    // A whole-block replacement remains faithful when a minimal diff is costly.
    for (let i = start; i < oldEnd; i++) rows.push({ marker: "-", text: before[i]! });
    for (let j = start; j < newEnd; j++) rows.push({ marker: "+", text: after[j]! });
  } else {
    const lengths = new Uint32Array((oldCount + 1) * width);
    for (let i = oldCount - 1; i >= 0; i--) {
      for (let j = newCount - 1; j >= 0; j--) {
        lengths[i * width + j] = before[start + i] === after[start + j]
          ? 1 + lengths[(i + 1) * width + j + 1]!
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < oldCount || j < newCount) {
      if (i < oldCount && j < newCount && before[start + i] === after[start + j]) {
        rows.push({ marker: " ", text: before[start + i++]! });
        j++;
      } else if (i < oldCount && (j === newCount || lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!)) {
        rows.push({ marker: "-", text: before[start + i++]! });
      } else {
        rows.push({ marker: "+", text: after[start + j++]! });
      }
    }
  }
  for (let i = oldEnd; i < before.length; i++) rows.push({ marker: " ", text: before[i]! });
  return rows;
}

function formatLine(row: DiffLine): string {
  return row.text.endsWith("\n")
    ? `${row.marker}${row.text.slice(0, -1)}`
    : `${row.marker}${row.text}\n\\ No newline at end of file`;
}

/** Prefer a supplied diff; keep unrecognized output without inventing counts. */
export function buildEditDiff(detail: Record<string, unknown>, input: Record<string, unknown>, diff?: string): EditDiff | undefined {
  if (diff) {
    const lines = diff.split(/\r?\n/);
    const changes = {
      added: lines.filter(line => line.startsWith("+") && !line.startsWith("+++ ")).length,
      removed: lines.filter(line => line.startsWith("-") && !line.startsWith("--- ")).length,
    };
    // Hermes can project a success message into unifiedDiff and omit the input.
    // Zero marked rows do not prove that the tool made no changes.
    const recognized = lines.every(line => !line || /^(?:[ +-]|@@ |diff --git |index |(?:old|new|deleted file|new file) mode |(?:similarity|dissimilarity) index |(?:rename|copy) (?:from|to) |\\ No newline at end of file$)/.test(line));
    if (recognized && (changes.added || changes.removed)) return { diff, changes };
  }
  const edits = Array.isArray(detail.edits) ? detail.edits : input.edits;
  const replacements = Array.isArray(edits)
    ? edits.flatMap(edit => replacement([record(edit)])) : replacement([detail, input]);
  if (!replacements.length) return diff ? { diff } : undefined;

  const hunks: string[] = [];
  const changes = { added: 0, removed: 0 };
  for (const [index, edit] of replacements.entries()) {
    if (edit.oldText === edit.newText) continue;
    const before = textLines(edit.oldText), after = textLines(edit.newText);
    const rows = compareLines(before, after);
    if (rows.every(row => row.marker === " ")) continue;
    for (const row of rows) {
      if (row.marker === "+") changes.added++;
      if (row.marker === "-") changes.removed++;
    }
    // The tool supplies snippets, so hunk coordinates are relative to each edit.
    const label = replacements.length > 1 ? ` ${t("diff.replacement", { index: index + 1 })}` : "";
    const header = `@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@${label}`;
    hunks.push([header, ...rows.map(formatLine)].join("\n"));
  }
  return { diff: hunks.join("\n") || t("diff.noChanges"), changes };
}
