import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { promptImageRpc, promptImagesRpc } from "../../shared/prompt-images-rpc";
import { MAX_IMAGE_BYTES } from "./read-only";

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

export interface PromptImageResolver {
  /** Paseo 0.13 snapshots expose the provider ID, not its configured command. */
  matches(provider: string): boolean;
  find(context: ResolverContext): Promise<FoundImage[]>;
}

/** Provider adapters are added separately; production lookups currently find none. */
export const promptImageResolvers: readonly PromptImageResolver[] = [];

const MAX_THUMBNAILS = 3;
const THUMBNAIL_EDGE = 512;
const MAX_PIXELS = 24 * 1024 * 1024;
const IMAGE_MIMES: Record<string, string> = {
  png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

type Reason = "unknown_provider" | "agent_not_found" | "provider_mismatch" | "not_found" |
  "timeout" | "lookup_failed" | "image_too_large" | "invalid_image";

class LookupError extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}

function emptyImage(error: Reason): ImageResult {
  return { dataUri: null, mime: null, width: null, height: null, bytes: null, error };
}

function dataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Lazy, pure-JS decode; first animation frame only, with an allocation bound. */
async function decodeImage(bytes: Buffer, mime: string) {
  const { decode, Image, ImageType } = await import("imagescript");
  const kind = ImageType.getType(bytes);
  if (!kind || !IMAGE_MIMES[kind] || IMAGE_MIMES[kind] !== mime) throw new LookupError("invalid_image");
  const decoded = await decode(bytes, { onlyFirstFrame: true, maxPixels: MAX_PIXELS });
  const image = decoded instanceof Image ? decoded : decoded[0];
  if (!image) throw new LookupError("invalid_image");
  return image;
}

/**
 * prompt.images returns up to three PNG thumbnails; total precedes all caps.
 * Dimensions describe each thumbnail. prompt.image returns original bytes and
 * dimensions, scoped by the same message and opaque image ID. Failures use only
 * fixed reason/error codes; no local paths or provider errors cross the RPC.
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
    return found;
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
          if (bytes.length > MAX_IMAGE_BYTES) { reason = "image_too_large"; continue; }
          const image = await decodeImage(bytes, candidate.mime);
          check();
          const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(image.width, image.height));
          image.resize(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
          const thumbnail = await image.encode();
          check();
          images.push({ id: candidate.id, thumbDataUri: dataUri(thumbnail, "image/png"), mime: "image/png", width: image.width, height: image.height });
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
        if (bytes.length > MAX_IMAGE_BYTES) throw new LookupError("image_too_large");
        const image = await decodeImage(bytes, candidate.mime);
        check();
        return { dataUri: dataUri(bytes, candidate.mime), mime: candidate.mime, width: image.width, height: image.height, bytes: bytes.length, error: null };
      }, emptyImage, result => result.error);
    },
  };
}
