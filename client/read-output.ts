import type { ToolCalloutData } from "../shared/contracts";

/** Unwrap a projected Hermes read; leave ordinary file contents untouched. */
export function readOutputText(data: Pick<ToolCalloutData, "tool" | "filePath">, text: string): string {
  if (data.tool !== "read" || !data.filePath || !text.startsWith(`Read ${data.filePath} `)) return text;
  const body = /^Read [^\r\n]+ — \d+ total lines?\r?\n\r?\n```[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text)?.[1];
  return body === undefined ? text : body.replace(/^\d+\|/gm, "");
}
