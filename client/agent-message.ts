import { z } from "zod";
import type { ToolCalloutData } from "../shared/contracts";
import type { LiveToolCallPayload } from "./tool-call-data";
import { toolStatus } from "./tool-summary";

const labels = {
  message: "Message received",
  finished: "Agent finished",
  errored: "Agent errored",
  "permission-required": "Agent needs permission",
  closed: "Agent closed",
} as const;

const deliverySchema = z.object({
  event: z.enum(["message", "finished", "errored", "permission-required", "closed"]),
  sender: z.object({ id: z.string().min(1), title: z.string().min(1).optional() }),
  text: z.string(),
});

/** Paseo projects delivered prompts as compatibility tool calls, not provider tools. */
export function agentMessageCallout(data: LiveToolCallPayload): ToolCalloutData | undefined {
  const parsed = deliverySchema.safeParse(data.agentMessage);
  if (!parsed.success) return undefined;
  const message = parsed.data;
  const sender = (message.sender.title ?? message.sender.id).replace(/\s+/g, " ").trim();
  const text = `From agent: ${message.sender.id}\n\n${message.text}`;
  return {
    id: data.callId ?? "agent-delivery",
    tool: "plain_text",
    title: `${labels[message.event]} · ${sender}`,
    status: toolStatus(data.status),
    agentMessage: true,
    plainText: text,
    copyResult: text,
  };
}
