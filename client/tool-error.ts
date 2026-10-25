import { translate as t } from "./translation";
import type { ToolCallKind, ToolCalloutData } from "../shared/contracts";
import { record, stringValue } from "./tool-detail";
import { errorText } from "./error-text";
import type { OutputLineLimit } from "./preferences";
import { claudeResultError } from "./step-detail-data";

function reportedText(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    return stringValue(value.map(reportedText).filter(Boolean).join("\n"));
  }
  const fields = record(value);
  // Prefer explicit errors to accompanying output. Ignore inputs and metadata:
  // an empty result object is not a reported failure message.
  for (const key of ["error", "stderr", "message", "output", "result", "content", "text", "stdout", "detail", "reason"]) {
    if (key === "error") {
      const text = errorText(fields[key]);
      if (text) return text;
      continue;
    }
    const text = reportedText(fields[key]);
    if (text) return text;
  }
  return undefined;
}

export function toolFailureMessage(error: unknown, detail: Record<string, unknown>, tool: ToolCallKind): string | undefined {
  // These tools carry request content at the detail root. Only exclude that
  // input field; content blocks inside output/result still report failures.
  const report = tool === "write" || tool === "edit" || tool === "github"
    ? { ...detail, content: undefined } : detail;
  return claudeResultError(error) ?? errorText(error) ?? reportedText(report)
    ?? (error && typeof error === "object" ? undefined : t("tool.error.none"));
}

/** Keep a separate error line when output folding would otherwise hide it. */
export function toolErrorLine(
  data: ToolCalloutData, limit: OutputLineLimit, expandedOutputs?: ReadonlySet<string>, imagePreview = false,
): string | undefined {
  const error = data.error;
  if (!error) return undefined;
  let outputs: Array<string | undefined> = [];
  if (data.finalReply) outputs = [data.finalReply];
  else if (data.skill) outputs = [data.skill.text];
  else if (["bash", "shell", "git"].includes(data.tool)) outputs = [data.shell?.stdout || data.output, data.shell?.stderr];
  else if ((data.tool === "read" || data.tool === "write") && !imagePreview) outputs = [data.code];
  else if (data.tool === "edit") outputs = [data.diff || data.code];
  else if (data.tool === "plain_text") outputs = [data.plainText];
  else if (data.tool === "tool_search") outputs = [data.toolSearch?.text];
  else if (data.tool === "mcp") outputs = [typeof data.mcp?.result === "string" ? data.mcp.result : undefined];
  else if (data.tool === "eval") outputs = data.cells?.map(cell => cell.output) ?? [data.output];
  else if (data.tool === "thinking") outputs = [data.thinking?.text || data.code || data.output];
  else if (data.tool === "github") outputs = [data.github?.text, data.github?.file?.code];
  else if (data.tool === "fetch") outputs = [data.fetch?.preview];
  else if (data.tool === "search" || data.tool === "web_search") outputs = data.search?.results.length
    ? [data.search.preview, ...data.search.results.map(row => row.preview?.split(/\r?\n/).slice(0, 5).join("\n"))]
    : [data.fetch?.preview];
  else if (data.tool === "unknown") outputs = [data.fallback?.output];
  return outputs.some(text => {
    const visible = data.finalReply || data.tool === "thinking" || limit === "never" || (text && expandedOutputs?.has(text))
      ? text : text?.split(/\r?\n/).slice(0, limit).join("\n");
    return visible?.includes(error);
  }) ? undefined : error;
}
