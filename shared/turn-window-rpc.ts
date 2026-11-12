import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const fileLineStats = z.object({
  added: z.number().nullable(),
  deleted: z.number().nullable(),
  binary: z.boolean(),
  renamedFrom: z.string().nullable(),
  diff: z.string().nullable(),
  truncated: z.boolean(),
  note: z.string().nullable(),
});

export const turnWindowRpc = defineRpc({
  name: "turn.window",
  input: z.object({ agentId: z.string(), turnId: z.string() }),
  output: z.object({
    files: z.array(z.string()),
    details: z.record(z.string(), fileLineStats),
    message: z.string().nullable(),
    warning: z.string().nullable(),
    incomplete: z.boolean(),
  }).nullable(),
});
