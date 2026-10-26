import { nativeSessionKeyFromPersistence } from "../hermes-cc/session-key";
import type { HermesCcStoredImage } from "../hermes-cc/store";
import type { FoundImages, PromptImageResolver } from "./registry";

const empty = (): FoundImages => ({ matchedMessages: 0, images: [] });
function sameImages(left: HermesCcStoredImage[], right: HermesCcStoredImage[]): boolean {
  return left.length === right.length && left.every((image, index) => {
    const other = right[index]!;
    return image.mime === other.mime && image.sha256 === other.sha256;
  });
}

export const hermesCcPromptImageResolver: PromptImageResolver = {
  matches: provider => provider.startsWith("hermes") && provider.endsWith("-cc"),
  async find(context) {
    if (context.signal.aborted || !context.hermesCcImageStore) return empty();
    const sessionKey = nativeSessionKeyFromPersistence(context.sessionId, context.nativeHandle);
    if (!sessionKey) return empty();
    // Paseo v0.13.0 packages/plugin/src/server/acp-internal/connection.ts:594-604
    // emits the prompt's clientMessageId as both live user-message identifiers.
    const ids = [...new Set([context.messageId, context.clientMessageId].filter(
      (id): id is string => typeof id === "string" && !!id.trim() && id.length <= 512 && !id.includes("\0"),
    ))];
    let selected: HermesCcStoredImage[] | null = null;
    for (const messageId of ids) {
      const images = await context.hermesCcImageStore.load({ sessionKey, messageId });
      if (context.signal.aborted) return empty();
      if (!images?.length) continue;
      if (selected && !sameImages(selected, images)) return { matchedMessages: 2, images: [] };
      selected = images;
    }
    if (!selected) return empty();
    // No prompt text, time, order, workspace path or Hermes files participate in lookup.
    // The registry applies its existing thumbnail, byte, pixel and MIME/header guards.
    return { matchedMessages: 1, images: selected.map((image, index) => ({
      id: String(index), mime: image.mime, readBytes: async () => Buffer.from(image.bytes),
    })) };
  },
};
