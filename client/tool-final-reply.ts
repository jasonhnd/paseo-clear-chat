import { record, stringValue, valueText } from "./tool-detail";

/** Only an explicit wrap-up operation is a reply; a completed phase is not. */
export function finalToolReply(name: string, input: Record<string, unknown>, output: unknown): string | undefined {
  const leaf = name.toLowerCase().split(/__|[./]/).pop();
  const operation = stringValue(input.action, input.operation, input.op, input.phase, input.stage, input.type, input.kind, input.mode);
  const nested = input.wrap_up;
  if (leaf !== "wrap_up" && !(leaf === "ccd_turn" && (operation === "wrap_up" || nested !== undefined))) return undefined;
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
