// shared/prompt-images-rpc.ts
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const promptImagesRpc = defineRpc({
  name: "prompt.images",
  input: z.object({ agentId: z.string(), messageId: z.string().nullable().optional(), clientMessageId: z.string().nullable().optional(), text: z.string() }),
  output: z.object({
    images: z.array(z.object({ id: z.string(), thumbDataUri: z.string(), mime: z.string(), width: z.number().nullable(), height: z.number().nullable() })),
    total: z.number(),
    reason: z.string().nullable(),
  }),
});
export const promptImageRpc = defineRpc({
  name: "prompt.image",
  input: z.object({ agentId: z.string(), messageId: z.string().nullable().optional(), clientMessageId: z.string().nullable().optional(), text: z.string(), id: z.string() }),
  output: z.object({ dataUri: z.string().nullable(), mime: z.string().nullable(), width: z.number().nullable(), height: z.number().nullable(), bytes: z.number().nullable(), error: z.string().nullable() }),
});
