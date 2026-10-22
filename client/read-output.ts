import type { ToolCalloutData } from "../shared/contracts";

type ReadLine = { text: string; lineNumber: number };

/** Unwrap only a recognized projected read; ordinary numeric pipe text stays literal. */
export function readOutputLines(data: Pick<ToolCalloutData, "tool" | "filePath">, text: string): { text: string; lines: ReadLine[] } {
  const envelope = data.tool === "read" && data.filePath
    ? /^Read ([^\r\n]+?)(?: \(from line (\d+), limit (\d+)\))? — \d+ total lines?\r?\n\r?\n```[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text)
    : null;
  const displayPath = envelope?.[1];
  // Providers may display a workspace-relative path beside an absolute tool path.
  const matchingPath = displayPath !== undefined && (displayPath === data.filePath
    || (!displayPath.startsWith("/") && !displayPath.split("/").includes("..")
      && data.filePath?.endsWith(`/${displayPath}`)));
  const candidate = envelope?.[4];
  const sourceLines = candidate?.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  // A fence or numeric pipe in ordinary file prose is never sufficient evidence.
  const numbered = sourceLines.length > 0 && sourceLines.every(line => /^\d+\|/.test(line));
  const body = matchingPath && numbered ? candidate : undefined;
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
