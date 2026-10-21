import type { ToolCallKind } from "../shared/contracts";
import { record, stringValue } from "./tool-detail";

function reportedText(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    return stringValue(value.map(reportedText).filter(Boolean).join("\n"));
  }
  const fields = record(value);
  // Prefer explicit errors to accompanying output. Ignore inputs and metadata:
  // an empty result object is not a reported failure message.
  for (const key of ["error", "stderr", "message", "output", "result", "content", "text", "stdout"]) {
    const text = reportedText(fields[key]);
    if (text) return text;
  }
  return undefined;
}

export function toolFailureMessage(error: string | null | undefined, detail: Record<string, unknown>, tool: ToolCallKind): string {
  // These tools carry request content at the detail root. Only exclude that
  // input field; content blocks inside output/result still report failures.
  const report = tool === "write" || tool === "edit" || tool === "github"
    ? { ...detail, content: undefined } : detail;
  return stringValue(error) ?? reportedText(report) ?? "Failed (no error message reported)";
}
