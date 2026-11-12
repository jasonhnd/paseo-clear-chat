import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const turnWindowRpc = defineRpc({
  name: "turn.window",
  input: z.object({ agentId: z.string(), turnId: z.string() }),
  output: z.object({ files: z.array(z.string()), message: z.string().nullable(), warning: z.string().nullable(), incomplete: z.boolean() }),
});
