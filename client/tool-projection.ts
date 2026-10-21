import { record, stringValue } from "./tool-detail";

const projectedTools = [
  { source: "terminal", host: "execute", type: "shell", field: "command" },
  { source: "skill_view", host: "read", type: "read", field: "filePath" },
  { source: "search_files", host: "search", type: "search", field: "query" },
  { source: "web_search", host: "fetch", type: "fetch", field: "url" },
  { source: "tool_search", host: "other", type: "plain_text", field: "label" },
];

function argumentAfterPrefix(value: unknown, name: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const prefix = `${name}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length).trim() : undefined;
}

/** Recover tool identity from the host's projected category and display fields. */
export function recoverProjectedTool(
  name: string, detail: Record<string, unknown>, rawMetadata: unknown,
): { name: string; detail: Record<string, unknown> } {
  const metadata = record(rawMetadata);
  for (const tool of projectedTools) {
    if (name.toLowerCase() !== tool.host || detail.type !== tool.type) continue;
    const fieldArgument = argumentAfterPrefix(detail[tool.field], tool.source);
    const titleArgument = metadata.kind === tool.host
      ? argumentAfterPrefix(metadata.title, tool.source) : undefined;
    if (titleArgument === undefined) continue;
    const argument = fieldArgument ?? titleArgument;

    if (tool.source === "terminal") return {
      name: tool.source,
      detail: { ...detail, command: fieldArgument ?? stringValue(detail.command) ?? argument },
    };
    if (tool.source === "skill_view") return {
      name: tool.source, detail: { ...detail, skillName: argument },
    };
    if (tool.source === "search_files") return {
      name: tool.source,
      detail: { ...detail, query: fieldArgument ?? stringValue(detail.query) ?? argument },
    };
    if (tool.source === "web_search") return {
      name: tool.source,
      detail: {
        ...detail, type: "web_search", query: stringValue(detail.query) ?? argument,
        // The projection stores a search label in the URL slot, not a link.
        ...(fieldArgument !== undefined ? { url: undefined } : {}),
      },
    };
    // This phrase is a provider display label, not part of a discovery query.
    // Only strip it after the projected tool identity has been corroborated.
    return { name: tool.source, detail: { ...detail, query: stringValue(detail.query) ?? argument.replace(/^Searching tools\s*·\s*/, "") } };
  }
  return { name, detail };
}
