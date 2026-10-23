import type { ToolCallKind } from "../shared/contracts";
import { stepResultText } from "./tool-step-copy";
import { record } from "./tool-detail";

const searchResults = ["content", "results", "filePaths", "webResults", "annotations", "numFiles", "numMatches", "truncated"];
const requestContentTools: ToolCallKind[] = ["write", "edit", "github"];

function resultFields(type: unknown): string[] {
  if (type === "search" || type === "web_search") return searchResults;
  if (type === "read") return ["content"];
  if (type === "plain_text") return ["text"];
  if (type === "sub_agent") return ["log", "actions"];
  if (type === "worktree_setup") return ["log", "commands", "truncated"];
  return [];
}

/** Typed projections have argument fields beside results instead of an input envelope. */
export function stepInputText(detail: Record<string, unknown>, tool: ToolCallKind): string | undefined {
  const input = detail.input ?? detail.arguments ?? detail.args;
  if (input !== undefined && input !== null) {
    return typeof input === "string" ? input : JSON.stringify(input, null, 2);
  }
  const excluded = new Set([
    "type", "toolName", "input", "arguments", "args", "output", "result", "error",
    "durationMs", "durationSeconds", "exitCode", "exit_code", "stdout", "stderr", ...resultFields(detail.type),
    ...(typeof detail.code === "number" ? ["code", "codeText", "bytes"] : []),
  ]);
  if (!requestContentTools.includes(tool)) excluded.add("content");
  const entries = Object.entries(detail).filter(([key, value]) => !excluded.has(key) && value !== undefined);
  if (!entries.length) return undefined;
  if (entries.length === 1 && entries[0]?.[0] === "command" && typeof entries[0][1] === "string") return entries[0][1];
  return JSON.stringify(Object.fromEntries(entries), null, 2);
}

/** Claude keeps failed tool results in error.content instead of detail.output. */
export function claudeResultError(error: unknown): string | undefined {
  const result = record(error);
  return (result.type === "tool_result" || result.type === "mcp_tool_result") && result.is_error === true
    ? stepResultText(result.content) : undefined;
}

/** Parse only complete provider envelopes, never arbitrary command output. */
export function shellResultExitCode(output: unknown, error: unknown): number | undefined {
  const terminal = typeof output === "string" ? output.match(
    /^terminal result\r?\n- (?:output:|\*\*output:\*\*)[\s\S]*\r?\n- (?:exit_code:|\*\*exit_code:\*\*) (-?\d+)(?:\r?\n)?$/,
  ) ?? output.match(
    /^terminal result\r?\n\r?\n\*\*output:\*\*\r?\n[\s\S]*\r?\n\*\*exit_code:\*\*\r?\n(-?\d+)(?:\r?\n)?$/,
  ) : undefined;
  const claude = claudeResultError(error)?.match(/^Exit code (-?\d+)(?:\r?\n|$)/);
  const value = terminal?.[1] ?? claude?.[1];
  if (value === undefined) return undefined;
  const code = Number(value);
  return Number.isSafeInteger(code) ? code : undefined;
}

/** Preserve explicitly separated streams without guessing which stream a line used. */
export function stepResultStreams(detail: Record<string, unknown>): { stdout?: string; stderr?: string } {
  const result = record(detail.output ?? detail.result);
  const stream = (key: "stdout" | "stderr") => typeof detail[key] === "string" ? detail[key] as string
    : typeof result[key] === "string" ? result[key] as string : undefined;
  return { stdout: stream("stdout"), stderr: stream("stderr") };
}

/** File writes, edits and GitHub device calls carry request data in content. */
export function stepOutputText(detail: Record<string, unknown>, tool: ToolCallKind): string | undefined {
  const result = detail.output ?? detail.result;
  if (result !== undefined && result !== null) return stepResultText(result);
  const fields = resultFields(detail.type);
  const entries = fields.filter(key => detail[key] !== undefined).map(key => [key, detail[key]] as const);
  if (entries.length === 1 && ["content", "text", "log"].includes(entries[0]![0])) return stepResultText(entries[0]![1]);
  if (entries.length) return stepResultText(Object.fromEntries(entries));
  if (!requestContentTools.includes(tool)) return stepResultText(detail.content);
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
