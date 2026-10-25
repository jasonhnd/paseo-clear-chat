import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { promptImageRpc, promptImagesRpc } from "../../shared/prompt-images-rpc";
import { codexPromptImages } from "./codex";
import { readLocalImageReadOnly } from "./read-only";
import { readImageHeader } from "./image-header";

type LookupInput = RpcInput<typeof promptImagesRpc>;
type ImagesResult = RpcOutput<typeof promptImagesRpc>;
type ImageResult = RpcOutput<typeof promptImageRpc>;

export interface FoundImage {
  /** Stable within a provider message; never interpreted as a client-supplied path. */
  id: string;
  mime: string;
  readBytes(): Promise<Buffer>;
}

export interface ResolverContext extends LookupInput {
  provider: string;
  cwd: string;
  sessionId: string | null;
  nativeHandle: string | null;
  /** Resolvers should stop streaming/scanning when the lookup expires. */
  signal: AbortSignal;
}

/** All images must belong to the single message selected by the resolver. */
export interface FoundImages {
  matchedMessages: number;
  images: FoundImage[];
}

/** Local adapters must read through the validated descriptor, never a saved path. */
export function localFileImage(id: string, mime: string, path: string, allowedRoots: readonly string[]): FoundImage {
  return { id, mime, async readBytes() {
    const bytes = await readLocalImageReadOnly(path, allowedRoots);
    if (!bytes) throw new LookupError("invalid_image");
    return bytes;
  } };
}

export interface PromptImageResolver {
  /** Paseo 0.13 snapshots expose the provider ID, not its configured command. */
  matches(provider: string): boolean;
  /** Prefer matching IDs; otherwise count every message matching the text. */
  find(context: ResolverContext): Promise<FoundImages>;
}

/** Codex rollout lookup is registered here. Other providers are added separately. */
export const promptImageResolvers: readonly PromptImageResolver[] = [
  codexPromptImages,
];

const MAX_THUMBNAILS = 3;
const MAX_PIXELS = 24_000_000;

/**
 * Originals at or below this size are returned as-is. A later card will
 * restore server-side thumbnails with a pure-JS decoder.
 */
export const MAX_INLINE_IMAGE_BYTES = 1_572_864;

type Reason = "unknown_provider" | "agent_not_found" | "provider_mismatch" | "not_found" |
  "timeout" | "lookup_failed" | "image_too_large" | "too_large_bytes" | "invalid_image" | "ambiguous" | "no_match";

class LookupError extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}

function emptyImage(error: Reason): ImageResult {
  return { dataUri: null, mime: null, width: null, height: null, bytes: null, error };
}

function dataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Header width and height only. Bytes are never decoded or resized. */
function headerImage(bytes: Buffer, mime: string) {
  const header = readImageHeader(bytes);
  if (!header || header.mime !== mime || header.width < 1 || header.height < 1) throw new LookupError("invalid_image");
  if (header.width * header.height > MAX_PIXELS) throw new LookupError("image_too_large");
  return header;
}

/**
 * prompt.images returns up to three originals at or below the inline cap.
 * Width and height come from the header. An image over that cap is omitted,
 * with reason `too_large_bytes`, while total still counts it. prompt.image
 * returns the same original bytes under the same cap. Pixel-limit and type
 * failures use only fixed reason/error codes; no local paths or provider errors
 * cross the RPC.
 */
export function createPromptImageHandlers(options: {
  resolvers?: readonly PromptImageResolver[];
  timeoutMs?: number;
} = {}) {
  const resolvers = options.resolvers ?? promptImageResolvers;
  const timeoutMs = options.timeoutMs ?? 3000;

  async function guarded<T>(
    name: string,
    run: (signal: AbortSignal, check: () => void) => Promise<T>,
    failure: (reason: Reason) => T,
    reasonOf: (result: T) => string | null,
  ): Promise<T> {
    const controller = new AbortController();
    const expires = performance.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      if (controller.signal.aborted || performance.now() >= expires) throw new LookupError("timeout");
    };
    let result: T;
    try {
      result = await Promise.race([
        Promise.resolve().then(() => run(controller.signal, check)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new LookupError("timeout"));
          }, timeoutMs);
        }),
      ]);
      check();
    } catch (error) {
      result = failure(error instanceof LookupError ? error.reason : "lookup_failed");
    } finally {
      clearTimeout(timer);
    }
    const reason = reasonOf(result);
    // Only fixed codes reach the daemon log: no snapshots, inputs or exceptions.
    if (reason) console.debug(`[clear-chat] ${name}: ${reason}`);
    return result;
  }

  async function find(input: LookupInput, context: PluginHandlerContext, signal: AbortSignal, check: () => void) {
    const ref = context.paseo.agents.ref(input.agentId);
    const refreshed = await ref.refresh();
    check();
    const agent = refreshed?.agent ?? ref.current();
    if (!agent) throw new LookupError("agent_not_found");
    const provider = agent.provider;
    const resolver = resolvers.find(candidate => candidate.matches(provider));
    if (!resolver) throw new LookupError("unknown_provider");
    const persistence = agent.persistence;
    if (persistence && persistence.provider !== provider) throw new LookupError("provider_mismatch");
    // Copy only fields needed for local lookup; never pass config or metadata.
    const found = await resolver.find({
      agentId: input.agentId, messageId: input.messageId, clientMessageId: input.clientMessageId, text: input.text,
      provider, cwd: agent.cwd, sessionId: persistence?.sessionId ?? null,
      nativeHandle: persistence?.nativeHandle ?? null, signal,
    });
    check();
    if (found.matchedMessages === 0) throw new LookupError("no_match");
    if (found.matchedMessages !== 1) throw new LookupError("ambiguous");
    return found.images;
  }

  return {
    images(input: LookupInput, context: PluginHandlerContext): Promise<ImagesResult> {
      return guarded<ImagesResult>("prompt.images", async (signal, check) => {
        const found = await find(input, context, signal, check);
        const images: ImagesResult["images"] = [];
        let reason: Reason | null = null;
        for (const candidate of found) {
          if (images.length === MAX_THUMBNAILS) break;
          check();
          const bytes = await candidate.readBytes();
          check();
          if (bytes.length > MAX_INLINE_IMAGE_BYTES) {
            reason = "too_large_bytes";
            continue;
          }
          try {
            const header = headerImage(bytes, candidate.mime);
            check();
            images.push({
              id: candidate.id,
              thumbDataUri: dataUri(bytes, header.mime),
              mime: header.mime,
              width: header.width,
              height: header.height,
            });
          } catch (error) {
            check();
            reason = error instanceof LookupError ? error.reason : "invalid_image";
          }
        }
        return { images, total: found.length, reason };
      }, reason => ({ images: [], total: 0, reason }), result => result.reason);
    },
    image(input: RpcInput<typeof promptImageRpc>, context: PluginHandlerContext): Promise<ImageResult> {
      return guarded<ImageResult>("prompt.image", async (signal, check) => {
        const found = await find(input, context, signal, check);
        const candidate = found.find(image => image.id === input.id);
        if (!candidate) throw new LookupError("not_found");
        const bytes = await candidate.readBytes();
        check();
        if (bytes.length > MAX_INLINE_IMAGE_BYTES) throw new LookupError("image_too_large");
        const header = headerImage(bytes, candidate.mime);
        check();
        return { dataUri: dataUri(bytes, header.mime), mime: header.mime, width: header.width, height: header.height, bytes: bytes.length, error: null };
      }, emptyImage, result => result.error);
    },
  };
}
