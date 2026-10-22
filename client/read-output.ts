import type { ToolCalloutData } from "../shared/contracts";

type ReadLine = { text: string; lineNumber: number };

/** Unwrap only a recognized projected read; ordinary numeric pipe text stays literal. */
export function readOutputLines(data: Pick<ToolCalloutData, "tool" | "filePath">, text: string): { text: string; lines: ReadLine[] } {
  const body = data.tool === "read" && data.filePath && text.startsWith(`Read ${data.filePath} `)
    ? /^Read [^\r\n]+ — \d+ total lines?\r?\n\r?\n```[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text)?.[1]
    : undefined;
  const lines = (body ?? text).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const parsed = lines.map((line, index) => {
    const prefix = body === undefined ? undefined : /^(\d+)\|/.exec(line);
    return { text: prefix ? line.slice(prefix[0].length) : line, lineNumber: prefix ? Number(prefix[1]) : index + 1 };
  });
  return { text: parsed.map(line => line.text).join(""), lines: parsed };
}

/** Shared plain content for previews and clipboard actions. */
export function readOutputText(data: Pick<ToolCalloutData, "tool" | "filePath">, text: string): string {
  return readOutputLines(data, text).text;
}
