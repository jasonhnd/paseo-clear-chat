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

/** Only explicit display titles belong in a row; identifiers stay in details. */
export function agentSenderTitle(title: string | null | undefined, ...ids: (string | undefined)[]): string | undefined {
  const name = title?.replace(/\s+/g, " ").trim();
  if (!name || ids.some(id => id && name.includes(id))
    || /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(name)) return undefined;
  return name;
}

/** Paseo projects delivered prompts as compatibility tool calls, not provider tools. */
export function agentMessageCallout(data: LiveToolCallPayload): ToolCalloutData | undefined {
  const message = parseAgentDelivery(data.agentMessage);
  if (!message && !isAgentMessageCall(data)) return undefined;
  const sender = message && agentSenderTitle(message.sender.title, message.sender.id, data.callId);
  const body = message?.text ?? (typeof data.detail?.text === "string" ? data.detail.text : "");
  const text = message ? `Sender: ${message.sender.id}\n\n${body}` : body;
  return {
    id: data.callId ?? "agent-delivery",
    tool: "plain_text",
    title: message && sender
      ? message.event === "message" ? `Message from ${sender}` : `${labels[message.event]} · ${sender}`
      : message ? labels[message.event] : labels.message,
    status: toolStatus(data.status),
    agentMessage: true,
    plainText: text,
    copyResult: text,
  };
}
