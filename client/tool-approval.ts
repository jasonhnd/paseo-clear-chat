import type { LiveToolCallPayload } from "./tool-call-data";

export type ApprovalStatus = "approved" | "denied" | "waiting";

/** Recognize the empty approval bookkeeping calls in Hermes projected history. */
export function projectedApprovalStatus(data: Pick<LiveToolCallPayload, "name" | "status" | "callId" | "metadata" | "detail">): ApprovalStatus | undefined {
  if (!/^edit-approval-[a-z0-9-]+$/.test(data.name) ||
      data.callId !== data.name || data.metadata?.title !== data.name ||
      data.detail?.type !== "unknown" ||
      data.detail.input !== null || data.detail.output !== null) return undefined;

  if (data.status === "completed" || data.status === "approved") return "approved";
  if (["denied", "rejected", "failed", "error", "canceled", "cancelled"].includes(data.status)) return "denied";
  return "waiting";
}
