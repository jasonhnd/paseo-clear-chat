const IMAGE_URI = /^(?:data:image\/|blob:|file:\/\/)/i;
const IMAGE_URL = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:\?\S*)?$/i;
const REMOTE_URI = /^https?:\/\/\S+$/i;
const IMAGE_TYPE = /^(?:image|image_url|input_image)$/i;
const CONTENT_KEYS = new Set(["attachments", "content", "blocks", "parts"]);

export interface PromptImages {
  /** Everything renderable as an `<Image>` source. */
  readonly uris: string[];
  /** Includes missing sources; null means the host supplied no attachment metadata. */
  readonly count: number | null;
  /** At least one announced image has no usable source. */
  readonly hasUnrenderable: boolean;
  /** Leave other attachment kinds to the host so they keep their affordances. */
  readonly hasOtherAttachments: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Collects image sources from a user message.
 *
 * Inspect the available payload structurally: older hosts declare only `text`,
 * while others retain image arrays or typed content blocks. Count image entries
 * independently of their sources so incomplete attachments remain visible.
 */
export function extractPromptImages(item: unknown): PromptImages {
  const uris: string[] = [];
  let count = 0;
  let hasUnrenderable = false;
  let hasOtherAttachments = false;

  const source = (value: unknown, depth: number, mimeHint?: string): string | undefined => {
    if (depth > 8) return undefined;
    if (typeof value === "string") {
      return IMAGE_URI.test(value) || REMOTE_URI.test(value) ? value : undefined;
    }
    const record = asRecord(value);
    if (!record) return undefined;
    const mime = record.mimeType ?? record.mediaType ?? record.media_type ?? record.type ?? mimeHint;
    const imageMime = typeof mime === "string" && /^image\//i.test(mime) ? mime : mimeHint;
    const data = record.data ?? record.base64;
    if (imageMime && typeof data === "string" && data.trim()) {
      return data.startsWith("data:") ? data : `data:${imageMime};base64,${data}`;
    }
    for (const [key, nested] of Object.entries(record)) {
      if (key === "text") continue;
      const uri = source(nested, depth + 1, imageMime);
      if (uri) return uri;
    }
    return undefined;
  };

  const visit = (value: unknown, depth: number, context = "") => {
    if (depth > 8) {
      hasOtherAttachments = true;
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1, context);
      return;
    }

    const record = asRecord(value);
    const mime = record?.mimeType ?? record?.mediaType ?? record?.media_type ?? record?.type;
    const isImage = context === "images" ||
      (typeof record?.type === "string" && IMAGE_TYPE.test(record.type)) ||
      (typeof mime === "string" && /^image\//i.test(mime)) ||
      (typeof value === "string" && (IMAGE_URI.test(value) || IMAGE_URL.test(value)));
    if (isImage) {
      count++;
      const uri = source(value, 0);
      if (uri) uris.push(uri);
      else hasUnrenderable = true;
      return;
    }

    if (!record) {
      if (context === "attachments" && value != null) hasOtherAttachments = true;
      return;
    }
    if (record.type === "text" || record.type === "input_text") {
      if (context === "attachments") hasOtherAttachments = true;
      return;
    }

    const before = count;
    for (const [key, nested] of Object.entries(record)) {
      if (key === "text" || nested == null) continue;
      visit(nested, depth + 1, key);
    }
    if (CONTENT_KEYS.has(context) && count === before) hasOtherAttachments = true;
  };

  visit(item, 0);
  const record = asRecord(item);
  const reportedCount = record?.imageCount;
  const hasReportedCount = typeof reportedCount === "number" && Number.isSafeInteger(reportedCount) && reportedCount >= 0;
  if (hasReportedCount && reportedCount > count) {
    count = reportedCount;
    hasUnrenderable = true;
  }

  // A stripped text-only item is indistinguishable from one whose images were
  // removed by the host. Only explicit attachment metadata establishes zero.
  const hasMetadata = hasReportedCount || ["images", "attachments", "content", "blocks", "parts"]
    .some((key) => Array.isArray(record?.[key]));
  const unique = [...new Set(uris)];
  return { uris: unique, count: count > 0 || hasMetadata ? count : null, hasUnrenderable, hasOtherAttachments };
}
