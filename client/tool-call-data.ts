import type { EvalCell, GitHubToolData, HubData, McpToolData, PaseoToolData, ToolCallKind, ToolCalloutData } from "../shared/contracts";
import { buildHubData } from "./hub-details";
import { buildGitHubData } from "./github-request";
import { asString, buildMcpData, buildPaseoData, buildSubagentBatch, extractAskQuestion, extractAskSelections, extractContentText, extractEvalCells, extractEvalDuration, extractStringProp, languageFromPath } from "./tool-call-legacy";
import { buildChecklist, fallbackData, fetchData, record, searchData, skillData, stringValue, subagentData, unknownTitle, valueText } from "./tool-detail";
import { readLineRange, toolStatus } from "./tool-summary";
import { buildEditDiff } from "./edit-diff";
import { finalToolReply } from "./tool-final-reply";
import { recoverProjectedTool } from "./tool-projection";
import { toolFailureMessage } from "./tool-error";
import { extractGeneratedImages } from "./generated-images";
import { errorText } from "./error-text";
import { stepInputText, stepOutputText } from "./step-detail-data";

export interface LiveToolCallPayload {
  name: string;
  status: string;
  detail?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  callId?: string;
  error?: unknown;
  phase?: string;
}

export function buildLiveToolCallData(data: LiveToolCallPayload): ToolCalloutData {
  const projected = recoverProjectedTool(stringValue(data.name)?.trim() ?? "tool", record(data.detail), data.metadata);
  const toolName = projected.name;
  const rawName = toolName.toLowerCase();
  const detail = projected.detail;
  const detailType = typeof detail.type === "string" ? detail.type.toLowerCase() : "";
  const rawInput = detail.input ?? detail.arguments ?? detail.args;
  const input = record(rawInput);
  const output = detail.output ?? detail.result ?? detail.content ?? "";

  // Universal path extraction across OMP, Paseo, Claude, and Codex formats
  const filePath: string | undefined =
    (typeof detail.filePath === "string" ? detail.filePath : undefined) ||
    (typeof input.path === "string" ? input.path : undefined) ||
    (typeof input.filePath === "string" ? input.filePath : undefined) ||
    (typeof input.file_path === "string" ? input.file_path : undefined) ||
    (typeof detail.path === "string" ? detail.path : undefined);

  // Universal command extraction
  const command: string | undefined =
    (typeof detail.command === "string" ? detail.command : undefined) ||
    (typeof input.command === "string" ? input.command : undefined) ||
    (typeof input.cmd === "string" ? input.cmd : undefined) ||
    (typeof detail.input === "string" ? detail.input : undefined);

  // Universal code / file content extraction
  const code: string | undefined =
    (typeof detail.content === "string" ? detail.content : undefined) ||
    (typeof input.content === "string" ? input.content : undefined) ||
    valueText(output);

  // Universal diff extraction
  const diff: string | undefined =
    (typeof detail.unifiedDiff === "string" ? detail.unifiedDiff : undefined) ||
    (typeof detail.diff === "string" ? detail.diff : undefined) ||
    extractStringProp(output, "diff");

  // A tool that answers with content blocks carries its prose in
  // `content[0].text`. That text is allowed to be empty — a `hub wait` job
  // snapshot puts everything in `details` and nothing in the text — so there
  // is deliberately no stringify fallback here: a card renders from its typed
  // record instead. Stringifying the envelope is what printed raw JSON.
  const outputText: string | undefined =
    typeof output === "string"
      ? output
      : extractStringProp(output, "stdout") ||
        extractStringProp(output, "text") ||
        (output && typeof output === "object"
          ? extractContentText(output as Record<string, unknown>)
          : undefined);
  const resultRecord = record(output);
  const reportedDuration = typeof detail.durationMs === "number" ? detail.durationMs
    : typeof detail.durationSeconds === "number" ? detail.durationSeconds * 1000
    : resultRecord.durationMs ?? (typeof resultRecord.durationSeconds === "number" ? resultRecord.durationSeconds * 1000 : extractEvalDuration(output));
  const durationMs = typeof reportedDuration === "number" && Number.isFinite(reportedDuration) && reportedDuration >= 0
    ? reportedDuration : undefined;
  let toolKind: ToolCallKind = "unknown";
  let skill: ToolCalloutData["skill"];
  let search: ToolCalloutData["search"];
  let fetch: ToolCalloutData["fetch"];
  let toolSearch: ToolCalloutData["toolSearch"];
  let checklist: ToolCalloutData["checklist"];
  let plainText: string | undefined;
  let hub: HubData | undefined;
  let mcp: McpToolData | undefined;
  let subagent: ToolCalloutData["subagent"];
  let paseo: PaseoToolData | undefined;
  let github: GitHubToolData | undefined;
  let evalCells: EvalCell[] = [];
  let askOptions: NonNullable<ToolCalloutData["askOptions"]> = [];
  let askAnswer: string[] = [];
  let title = toolName;

  const isGitHubTool =
    rawName === "github" ||
    detailType === "github" ||
    filePath === "xd://github" ||
    filePath?.startsWith("xd://github/") === true;
  const isGitCommand =
    rawName === "git" || detailType === "git" ||
    ((detailType === "shell" || rawName === "bash" || rawName === "shell") && /^\s*git(?:\.exe)?(?:\s|$)/i.test(command ?? ""));
  const isType = (type: string, aliases: string[] = [type]) =>
    detailType === type || ((!detailType || detailType === "unknown") && aliases.includes(rawName));

  if (/(?:^|[._/])skill_view$/.test(rawName)) {
    toolKind = "read";
    skill = skillData(detail, input);
    title = `Skill: ${skill.name}`;
  } else if (isType("search") || isType("web_search")) {
    const web = detailType === "web_search" || detail.toolName === "web_search" || rawName === "web_search";
    toolKind = web ? "web_search" : "search";
    search = searchData(detail, input, output, web);
    if (web && search.results.length === 0) fetch = fetchData(detail, input, output);
    title = `${web ? "web_search" : "Search"}${search.query ? `: ${search.query}` : ""}`;
  } else if (isType("tool_search") || (rawName === "tool_search" && ["unknown", "plain_text", ""].includes(detailType))) {
    toolKind = "tool_search";
    toolSearch = {
      query: stringValue(detail.query, input.query, input.pattern, input.search_term, input.q) ?? "",
      text: typeof detail.text === "string" ? detail.text : valueText(output),
    };
    title = unknownTitle("tool_search", { query: toolSearch.query });
  } else if (isType("fetch", ["fetch", "webfetch"])) {
    toolKind = "fetch";
    fetch = fetchData(detail, input, output);
    title = fetch.title ?? (fetch.url ? `Fetch: ${fetch.url}` : "Fetch");
  } else if (isType("sub_agent")) {
    toolKind = "sub_agent";
    subagent = subagentData(detail, input, record(data.metadata));
    title = subagent.agents[0]?.name ?? "Subagent";
  } else if (isType("plan", ["plan", "update_plan"]) || isType("todo", ["todo", "todowrite", "todo_write"])) {
    toolKind = isType("plan", ["plan", "update_plan"]) ? "plan" : "todo";
    checklist = buildChecklist(detail, input, toolKind);
    title = checklist.phaseName;
  } else if (isType("plain_text")) {
    toolKind = "plain_text";
    plainText = typeof detail.text === "string" ? detail.text : valueText(output);
  } else if (isGitHubTool) {
    toolKind = "github";
    // A device call is a write: `content` is the request, and the tool's own
    // result text is the reply. They are read separately here because the
    // generic `code` extraction prefers whichever it finds first, which drew
    // the request twice and the answer never.
    const request = asString(input.content) ?? asString(detail.content);
    const reply = outputText && outputText !== request ? outputText : undefined;
    github = buildGitHubData(request, reply);
    title = github
      ? [github.op, github.repo, github.subject].filter(Boolean).join(" ")
      : "GitHub";
  } else if (isGitCommand) {
    toolKind = "git";
    title = command ? `$ ${command.trim().slice(0, 55)}` : "Git command";
  } else if (isType("read")) {
    toolKind = "read";
    title = filePath ? `Read ${filePath.split(/[/\\]/).pop() || filePath}` : "Read file";
  } else if (isType("write")) {
    toolKind = "write";
    title = filePath ? `Write ${filePath.split(/[/\\]/).pop() || filePath}` : "Write file";
  } else if (isType("edit", ["edit", "multiedit", "multi_edit"])) {
    toolKind = "edit";
    title = filePath ? `Edit ${filePath.split(/[/\\]/).pop() || filePath}` : "Edit file";
  } else if (isType("shell", ["bash", "shell"])) {
    toolKind = rawName === "shell" || detailType === "shell" ? "shell" : "bash";
    title = command ? `$ ${command.trim().slice(0, 55)}` : "Execute command";
  } else if (rawName === "thinking") {
    toolKind = "thinking";
    title = "Reasoning Process";
  } else if (
    rawName === "create_agent" ||
    rawName === "list_providers" ||
    rawName === "list_models" ||
    rawName === "get_agent_activity" ||
    rawName === "send_agent_prompt" ||
    rawName === "get_agent_status"
  ) {
    toolKind = "paseo";
    title = `Paseo: ${rawName}`;
    paseo = buildPaseoData(rawName, input, outputText, durationMs);
  } else if (rawName.startsWith("mcp__") || rawName === "mcp") {
    toolKind = "mcp";
    title = rawName.replace(/^mcp__/, "").replace(/__/g, " / ");
    mcp = buildMcpData(rawName, input, output, durationMs);
  } else if (rawName === "ask") {
    toolKind = "ask";
    const asked = extractAskQuestion(input);
    title = asked?.question || "User Decision";
    askOptions = asked?.options ?? [];
    askAnswer = extractAskSelections(output, outputText);
  } else if (rawName === "hub") {
    toolKind = "hub";
    title = `Hub: ${stringValue(input.op) ?? "operation"}`;
    hub = buildHubData(input, outputText, output);
  } else if (rawName === "eval") {
    toolKind = "eval";
    evalCells = extractEvalCells(detail, input, output);
    const cellTitle = evalCells.find((cell) => cell.title)?.title;
    title = cellTitle ? `Eval: ${cellTitle}` : "Eval Kernel";
  } else if (rawName === "task") {
    toolKind = "task";
    subagent = buildSubagentBatch(input);
    const count = subagent?.agents.length ?? 0;
    title =
      count === 1 ? (subagent?.agents[0]?.name ?? "Subagent") : `${count || "No"} subagents`;
  }
  if (toolKind === "unknown") title = unknownTitle(title, input);
  const edit = toolKind === "edit" ? buildEditDiff(detail, input, diff) : undefined;

  // A fetch's numeric `code` is an HTTP status, not a process exit code.
  const exitCodeCandidate = [detail.exitCode,
    ["shell", "bash", "git"].includes(toolKind) ? detail.code : undefined,
    resultRecord.exitCode, resultRecord.exit_code, record(resultRecord.details).exitCode,
  ].find((value): value is number => typeof value === "number" && Number.isInteger(value));
  const status = toolStatus(data.status);
  const finalReply = finalToolReply(rawName, rawInput, output);
  // Reading or writing an image file is previewed from filePath by the renderer.
  // File contents are text, even when they quote image paths or generation reports.
  const fileOperation = ["read", "write", "edit"].includes(toolKind) ||
    /(?:^|[._/])(?:read_file|write_file|edit_file)$/.test(rawName);
  const generatesImages = /(?:^|[._/])(?:imagegen|image_generation|generate_images?|generate_art|text_to_image)$/.test(rawName);

  return {
    id: `live-${rawName}`,
    input: stepInputText(detail),
    copyResult: stepOutputText(detail),
    tool: toolKind,
    title,
    status,
    error: status === "failed" ? toolFailureMessage(data.error, detail, toolKind) : errorText(data.error),
    finalReply,
    images: fileOperation ? [] : extractGeneratedImages([output, detail.text], { toolOutput: !finalReply, generated: generatesImages }),
    filePath: skill ? undefined : filePath,
    lineRange: toolKind === "read" && !skill ? readLineRange(detail, input, code) : undefined,
    changes: edit?.changes,
    command,
    language:
      toolKind === "bash" || toolKind === "shell" || toolKind === "git"
        ? "bash"
        : languageFromPath(filePath),
    // A github card reads its typed record; leaving `code` and `output` set
    // would draw the request and the reply a second time.
    code: toolKind === "github" ? undefined : code,
    diff: edit?.diff ?? diff,
    output: toolKind === "github" || evalCells.length > 0 ? undefined : outputText ?? valueText(output),
    cells: evalCells.length > 0 ? evalCells : undefined,
    askOptions: askOptions.length > 0 ? askOptions : undefined,
    askAnswer: askAnswer.length > 0 ? askAnswer : undefined,
    exitCode: exitCodeCandidate,
    durationMs,
    hub,
    subagent,
    mcp,
    paseo,
    github,
    skill,
    search,
    fetch,
    toolSearch,
    checklist,
    plainText,
    fallback: fallbackData(rawInput, output),
  };
}
