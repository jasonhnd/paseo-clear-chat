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
  text: z.string().optional(),
});

export type AgentDelivery = z.infer<typeof deliverySchema>;

export function parseAgentDelivery(value: unknown): AgentDelivery | undefined {
  const parsed = deliverySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The reserved ID identifies a delivery, never its sender. */
export function isAgentMessageCall(data: LiveToolCallPayload): boolean {
  const prefix = "paseo-agent-message:";
  return data.name === "agent_message" && Boolean(data.callId?.startsWith(prefix) && data.callId.length > prefix.length);
}

/** Paseo projects delivered prompts as compatibility tool calls, not provider tools. */
export function agentMessageCallout(data: LiveToolCallPayload): ToolCalloutData | undefined {
  const message = parseAgentDelivery(data.agentMessage);
  if (!message && !isAgentMessageCall(data)) return undefined;
  const sender = message && ((message.sender.title ?? "").replace(/\s+/g, " ").trim() || message.sender.id);
  const body = message?.text ?? (typeof data.detail?.text === "string" ? data.detail.text : "");
  const text = message ? `From agent: ${message.sender.id}\n\n${body}` : body;
  return {
    id: data.callId ?? "agent-delivery",
    tool: "plain_text",
    title: message ? `${labels[message.event]} · ${sender}` : labels.message,
    status: toolStatus(data.status),
    agentMessage: true,
    plainText: text,
    copyResult: text,
  };
}
