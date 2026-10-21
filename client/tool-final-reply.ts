import { record, stringValue, valueText } from "./tool-detail";

export type FinalToolReplyContent =
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string }
  | { kind: "wrap_up"; recap: string; ask?: string; actions: string[]; blocked: string[]; isBlocked: boolean };

function actionText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() ? value : undefined;
  const action = record(value);
  const label = stringValue(action.label, action.title, action.text);
  if (!label || Object.keys(action).some(key => !["id", "label", "title", "text", "description", "message"].includes(key))) return undefined;
  if ([action.message, action.description].some(value => value != null && typeof value !== "string")) return undefined;
  return [label, action.message, action.description].filter(value => typeof value === "string" && value.trim()).join("\n\n");
}

/** Decode the known reply envelope without hiding malformed or unfamiliar data. */
export function parseFinalToolReply(text: string): FinalToolReplyContent {
  const fallback = { kind: "text" as const, text: text.trim() ? text : "No final reply content was reported." };
  const source = text.trim();
  const fenced = source.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  let decoded: unknown;
  try {
    decoded = JSON.parse(fenced?.[1] ?? source);
  } catch {
    return source.startsWith("{") || source.startsWith("[") || /^```json\b/i.test(source) || !source
      ? fallback : { kind: "markdown", text };
  }
  const fields = record(decoded);
  if (typeof fields.recap !== "string" || Object.keys(fields).some(key => !["recap", "ask", "actions", "blocked"].includes(key))) return fallback;
  if (fields.ask != null && typeof fields.ask !== "string") return fallback;
  if (fields.actions != null && !Array.isArray(fields.actions)) return fallback;
  const actions = (fields.actions ?? []) as unknown[];
  const labels = actions.map(actionText);
  if (labels.some(label => label === undefined)) return fallback;
  const blocked = fields.blocked == null || typeof fields.blocked === "boolean" ? []
    : typeof fields.blocked === "string" ? [fields.blocked] : fields.blocked;
  if (!Array.isArray(blocked) || blocked.some(item => typeof item !== "string")) return fallback;
  const reasons = (blocked as string[]).filter(item => item.trim());
  const ask = typeof fields.ask === "string" && fields.ask.trim() ? fields.ask : undefined;
  const isBlocked = fields.blocked === true || reasons.length > 0;
  if (!fields.recap.trim() && !ask && !labels.length && !isBlocked) return fallback;
  return { kind: "wrap_up", recap: fields.recap, ask, actions: labels as string[], blocked: reasons, isBlocked };
}

/** Only an explicit wrap-up operation is a reply; a completed phase is not. */
export function finalToolReply(name: string, rawInput: unknown, output: unknown): string | undefined {
  let input = record(rawInput);
  if (typeof rawInput === "string") {
    try { input = record(JSON.parse(rawInput)); } catch { /* Preserve an explicit reply verbatim below. */ }
  }
  const leaf = name.toLowerCase().split(/__|[./]/).pop();
  const operation = stringValue(input.action, input.operation, input.op, input.phase, input.stage, input.type, input.kind, input.mode);
  const nested = input.wrap_up;
  if (leaf !== "wrap_up" && !(leaf === "ccd_turn" && (operation === "wrap_up" || nested !== undefined))) return undefined;
  if (leaf === "wrap_up" && typeof rawInput === "string" && rawInput.trim()) return rawInput;
  const payload = record(nested ?? input);
  const reply = stringValue(
    typeof nested === "string" ? nested : undefined,
    payload.final_reply, payload.finalReply, payload.reply, payload.message,
    payload.response, payload.markdown, payload.text, payload.content,
    payload.summary, payload.report,
  );
  if (reply) return reply;
  // An unfamiliar payload still remains fully visible rather than disappearing
  // behind a finished tool row. Do not fabricate a reply from the phase alone.
  const fields = Object.fromEntries(Object.entries(payload).filter(([key]) => !["action", "operation", "op", "phase", "stage", "type", "kind", "mode"].includes(key)));
  if (Object.keys(fields).length) return valueText(fields);
  return valueText(output)?.trim() ? valueText(output) : undefined;
}
