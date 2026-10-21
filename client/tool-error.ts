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

export function toolFailureMessage(error: string | null | undefined, detail: Record<string, unknown>): string {
  return stringValue(error) ?? reportedText(detail) ?? "Failed (no error message reported)";
}
