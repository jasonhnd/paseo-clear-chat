import type { TaskItemData, TaskListData, ToolCalloutData } from "../shared/contracts";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

/** Keep structured output readable, including every text block in an envelope. */
export function valueText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  const blocks = Array.isArray(value) ? value : record(value).content;
  if (Array.isArray(blocks)) {
    const texts = blocks.flatMap((block) => {
      const text = record(block).text;
      return typeof text === "string" ? [text] : [];
    });
    if (texts.length) return texts.join("\n");
  }
  const obj = record(value);
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.stdout === "string") return obj.stdout;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function preview(text: string | undefined, limit: number): { text?: string; truncated: boolean } {
  if (!text?.trim()) return { truncated: false };
  const lines = text.split(/\r?\n/);
  return { text: lines.slice(0, limit).join("\n"), truncated: lines.length > limit };
}

function parameterValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

export function fallbackData(input: unknown, output: unknown): NonNullable<ToolCalloutData["fallback"]> {
  const entries = input && typeof input === "object" && !Array.isArray(input)
    ? Object.entries(input)
    : input !== undefined && input !== null && input !== "" ? [["input", input] as const] : [];
  const excerpt = preview(valueText(output), 15);
  return {
    parameters: entries.map(([name, value]) => ({ name, value: parameterValue(value) })),
    output: excerpt.text,
    truncated: excerpt.truncated,
  };
}

/** Unknown tools retain their real name, with the most useful argument on the summary row. */
export function unknownTitle(name: string, input: Record<string, unknown>): string {
  const key = stringValue(
    input.action, input.operation, input.op, input.tool_name, input.toolName,
    input.tool, input.name, input.query, input.pattern, input.target, input.connection_id,
    input.path, input.id,
  );
  return key ? `${name} · ${key.replace(/\s+/g, " ").slice(0, 80)}` : name;
}

export function skillData(detail: Record<string, unknown>, input: Record<string, unknown>): NonNullable<ToolCalloutData["skill"]> {
  const path = stringValue(detail.filePath, input.path) ?? "";
  const parts = path.replace(/\\/g, "/").replace(/\/$/, "").split("/");
  const leaf = parts.pop();
  const name = stringValue(input.name, input.skill_name, input.skill, detail.skillName)
    ?? (leaf?.toLowerCase() === "skill.md" ? parts.pop() : leaf)
    ?? "Unnamed skill";
  return { name, text: valueText(detail.content ?? detail.output ?? detail.result) };
}

function resultRow(value: unknown): NonNullable<ToolCalloutData["search"]>["results"][number] | undefined {
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    if (/^https?:\/\//i.test(value)) return { label: value, url: value };
    const match = value.match(/^(.+?):(\d+)(?::(\d+))?:(.*)$/);
    return { label: value, path: match?.[1] ?? value.trim() };
  }
  const row = record(value);
  const url = stringValue(row.url, row.link);
  const path = stringValue(row.filePath, row.path, row.file_path);
  const title = stringValue(row.title, row.name, row.label, path, url);
  if (!title) return undefined;
  const line = typeof row.line === "number" ? `:${row.line}` : "";
  return {
    label: `${title}${line}`,
    path,
    url,
    preview: stringValue(row.snippet, row.content, row.text, row.description),
  };
}

export function searchData(
  detail: Record<string, unknown>, input: Record<string, unknown>, output: unknown, web: boolean,
): NonNullable<ToolCalloutData["search"]> {
  const result = record(output);
  const query = stringValue(detail.query, input.query, input.pattern, input.search_term, input.q) ?? "";
  const scope = stringValue(detail.scope, detail.path, input.path, input.directory, input.cwd)
    ?? (web ? "Web" : "Workspace");
  const filter = stringValue(input.glob, input.include, input.filePattern);
  const rows = detail.webResults ?? detail.results ?? result.results
    ?? (Array.isArray(output) ? output : web && typeof result.url === "string" ? [result] : undefined);
  const content = valueText(detail.content ?? output);
  const filePaths = Array.isArray(detail.filePaths) ? detail.filePaths : [];
  const source = Array.isArray(rows) ? rows : content?.trim()
    ? content.split(/\r?\n/).filter((line) => line.trim()) : filePaths;
  const results = source.flatMap((value) => {
    const row = resultRow(value);
    if (!row) return [];
    if (web && !row.url && typeof value === "string") {
      const link = value.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
      const url = link?.[2] ?? value.match(/https?:\/\/[^\s<>]+/)?.[0];
      if (!url) return [];
      return [{ label: link?.[1] ?? url, url, preview: value }];
    }
    // A prose-only match can still reveal the reported scope, rather than
    // passing its entire contents off as a filesystem path.
    if (!web && row.path && /\s/.test(row.path) && !row.path.includes("/")) {
      row.path = filePaths.length === 1 ? String(filePaths[0]) : stringValue(input.path, detail.path) ?? ".";
    }
    return [row];
  });
  const reported = detail.numMatches ?? detail.numFiles ?? result.total ?? result.count;
  return {
    query,
    scope: filter ? `${scope} (${filter})` : scope,
    count: typeof reported === "number" && Number.isFinite(reported) ? reported : results.length,
    truncated: detail.truncated === true,
    results,
  };
}

export function fetchData(
  detail: Record<string, unknown>, input: Record<string, unknown>, output: unknown,
): NonNullable<ToolCalloutData["fetch"]> {
  const result = record(output);
  const body = valueText(detail.result ?? detail.content ?? output);
  return {
    url: stringValue(detail.url, input.url, result.url),
    query: stringValue(detail.query, input.query),
    title: stringValue(detail.title, result.title) ?? body?.match(/^#\s+(.+)$/m)?.[1],
    preview: preview(body, 5).text,
  };
}

export function subagentData(
  detail: Record<string, unknown>, input: Record<string, unknown>, metadata: Record<string, unknown>,
): NonNullable<ToolCalloutData["subagent"]> {
  return {
    agents: [{
      name: stringValue(detail.name, detail.agentName, input.name, input.agent_name, detail.subAgentType) ?? "Subagent",
      agentType: stringValue(detail.subAgentType, input.subagent_type, input.agent_type) ?? "agent",
      model: stringValue(detail.model, input.model, metadata.model),
      task: stringValue(detail.task, input.task, input.prompt, input.instructions, detail.description)
        ?? "Task not reported by the provider.",
    }],
  };
}

export function buildChecklist(
  detail: Record<string, unknown>, input: Record<string, unknown>, kind: "plan" | "todo",
): TaskListData {
  const raw = detail.items ?? detail.steps ?? input.todos ?? input.items ?? input.plan ?? input.steps;
  const text = stringValue(detail.text, detail.content, input.plan, input.text) ?? "";
  const rows: unknown[] = Array.isArray(raw) ? raw : text.split(/\r?\n/).filter((line) => line.trim() && !/^\s*#/.test(line));
  const tasks: TaskItemData[] = rows.flatMap((entry, index) => {
    const row = record(entry);
    const original = typeof entry === "string" ? entry : stringValue(row.text, row.title, row.step, row.content);
    if (!original?.trim()) return [];
    const checked = original.match(/^\s*[-*+]\s+\[([ xX-])\]\s*/);
    const title = original.replace(/^\s*(?:[-*+]\s+(?:\[[ xX-]\]\s*)?|\d+[.)]\s+)/, "");
    const status = row.status;
    return [{
      id: stringValue(row.id) ?? `${kind}-${index}`,
      title,
      phase: kind === "plan" ? "Planning" : "Execution",
      status: row.completed === true || status === "completed" || status === "done" || checked?.[1]?.toLowerCase() === "x"
        ? "completed" : status === "in_progress" || status === "active" || checked?.[1] === "-"
          ? "in_progress" : status === "blocked" ? "blocked" : "pending",
      blockerReason: stringValue(row.blockerReason, row.reason),
    }];
  });
  return { id: `live-${kind}`, phaseName: kind === "plan" ? "Plan" : "Checklist Progress", tasks };
}
