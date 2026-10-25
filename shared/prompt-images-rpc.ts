// shared/prompt-images-rpc.ts
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
/**
 * Images are returned only when exactly one provider message matches. Resolvers
 * prefer messageId/clientMessageId; text fallback with multiple matches returns
 * { images: [], total: 0, reason: "ambiguous" }, and zero matches uses "no_match".
 * The same rule scopes prompt.image. Every image id is an opaque provider ID,
 * never a path. The RPC field shapes remain the same for every provider.
 */
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
