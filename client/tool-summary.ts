import type { ToolCalloutData } from "../shared/contracts";
import { stringValue } from "./tool-detail";

const singleLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function toolStatus(status: string): ToolCalloutData["status"] {
  if (status === "running" || status === "in_progress") return "running";
  if (status === "failed" || status === "error") return "failed";
  if (status === "canceled" || status === "cancelled") return "canceled";
  if (["waiting", "pending", "awaiting_approval", "pending_approval", "waiting_for_approval", "awaiting_input", "waiting_for_input", "awaiting_answer", "waiting_for_answer"].includes(status)) return "waiting";
  return "completed";
}

export function defaultToolExpanded(data: Pick<ToolCalloutData, "status">, foldFinishedSteps: boolean): boolean {
  return !foldFinishedSteps || data.status === "running" || data.status === "failed" || data.status === "waiting";
}

export function readLineRange(detail: Record<string, unknown>, input: Record<string, unknown>, content?: string): string | undefined {
  const range = stringValue(detail.lineRange, input.lineRange);
  if (range) return range.replace(/[^\d-]/g, "") || undefined;
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
  const start = [detail.startLine, input.startLine, input.start_line, detail.offset, input.offset].find(positive) ?? 1;
  const end = [detail.endLine, input.endLine, input.end_line].find(positive);
  if (end !== undefined && end >= start) return `${start}-${end}`;
  const limit = [detail.limit, input.limit].find(positive);
  const count = limit ?? (content ? content.replace(/\r?\n$/, "").split(/\r?\n/).length : undefined);
  return count !== undefined ? `${start}-${start + count - 1}` : undefined;
}

export function editChanges(detail: Record<string, unknown>, input: Record<string, unknown>, diff?: string): ToolCalloutData["changes"] {
  if (diff) {
    const lines = diff.split(/\r?\n/);
    return {
      added: lines.filter(line => line.startsWith("+") && !line.startsWith("+++ ")).length,
      removed: lines.filter(line => line.startsWith("-") && !line.startsWith("--- ")).length,
    };
  }
  const oldText = detail.oldString ?? input.oldString ?? input.old_string;
  const newText = detail.newString ?? input.newString ?? input.new_string;
  if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
  const count = (text: string) => text ? text.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
  return { added: count(newText), removed: count(oldText) };
}

export function toolSummary(data: ToolCalloutData): string {
  if (["bash", "shell", "git"].includes(data.tool) && (data.shell?.command || data.command)) {
    return `$ ${singleLine(data.shell?.command || data.command || "")}`;
  }
  if (data.skill) return `Skill: ${singleLine(data.skill.name)}`;
  const file = data.filePath?.split(/[/\\]/).pop() || data.filePath;
  if (data.tool === "read" && file) return `${file}${data.lineRange ? `:${data.lineRange}` : ""}`;
  if (data.tool === "edit") {
    const delta = data.changes ? `+${data.changes.added} −${data.changes.removed}` : "";
    return [file, delta].filter(Boolean).join(" · ") || singleLine(data.title);
  }
  if (data.tool === "write" && file) return file;
  if ((data.tool === "search" || data.tool === "web_search") && data.search?.query) return JSON.stringify(singleLine(data.search.query));
  if (data.tool === "fetch" && data.fetch?.url) return singleLine(data.fetch.url);
  return singleLine(data.title);
}

export function toolDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs > 0 && durationMs < 1) return "<1ms";
  return durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${Math.round(durationMs / 10) / 100}s`;
}
