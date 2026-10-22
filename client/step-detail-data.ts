import { stepResultText } from "./tool-step-copy";

const searchResults = ["content", "filePaths", "webResults", "annotations", "numFiles", "numMatches", "truncated"];

function resultFields(type: unknown): string[] {
  if (type === "search" || type === "web_search") return searchResults;
  if (type === "read") return ["content"];
  if (type === "plain_text") return ["text"];
  if (type === "sub_agent") return ["log", "actions"];
  if (type === "worktree_setup") return ["log", "commands", "truncated"];
  return [];
}

/** Typed projections have argument fields beside results instead of an input envelope. */
export function stepInputText(detail: Record<string, unknown>): string | undefined {
  const input = detail.input ?? detail.arguments ?? detail.args;
  if (input !== undefined && input !== null) {
    return typeof input === "string" ? input : JSON.stringify(input, null, 2);
  }
  const excluded = new Set([
    "type", "toolName", "input", "arguments", "args", "output", "result", "error",
    "durationMs", "durationSeconds", "exitCode", ...resultFields(detail.type),
    ...(typeof detail.code === "number" ? ["code", "codeText", "bytes"] : []),
  ]);
  if (!["write", "edit"].includes(String(detail.type))) excluded.add("content");
  const entries = Object.entries(detail).filter(([key, value]) => !excluded.has(key) && value !== undefined);
  if (!entries.length) return undefined;
  if (entries.length === 1 && entries[0]?.[0] === "command" && typeof entries[0][1] === "string") return entries[0][1];
  return JSON.stringify(Object.fromEntries(entries), null, 2);
}

/** Keep all reported result fields; file contents and patches are write/edit inputs. */
export function stepOutputText(detail: Record<string, unknown>): string | undefined {
  const result = detail.output ?? detail.result;
  if (result !== undefined && result !== null) return stepResultText(result);
  const fields = resultFields(detail.type);
  const entries = fields.filter(key => detail[key] !== undefined).map(key => [key, detail[key]] as const);
  if (entries.length === 1 && ["content", "text", "log"].includes(entries[0]![0])) return stepResultText(entries[0]![1]);
  if (entries.length) return stepResultText(Object.fromEntries(entries));
  if (!["write", "edit"].includes(String(detail.type))) return stepResultText(detail.content);
  return undefined;
}

/** Split without dropping whitespace or splitting a UTF-16 surrogate pair. */
export function stepTextChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0, lines = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") lines++;
    if (lines < 48 && index - start + 1 < 2048) continue;
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) index++;
    if (text[index] === "\r" && text[index + 1] === "\n") index++;
    chunks.push(text.slice(start, index + 1));
    start = index + 1;
    lines = 0;
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks;
}
