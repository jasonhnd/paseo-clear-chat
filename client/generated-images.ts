import type { GeneratedImage } from "../shared/contracts";
export type { GeneratedImage } from "../shared/contracts";

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#].*)?$/i;
const IMAGE_DATA = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i;

export function imageSource(source: string, explicit = false): GeneratedImage | null {
  const value = source.trim();
  if (!value) return null;
  if (value.startsWith("//")) return null;
  if (IMAGE_DATA.test(value) || /^blob:/i.test(value)) return { source: value };
  if (/^https?:\/\//i.test(value)) {
    return !/\s/.test(value) && (explicit || IMAGE_EXTENSION.test(value)) ? { source: value } : null;
  }
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return null;
      const path = decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, "$1");
      return IMAGE_EXTENSION.test(path) ? { source: value, path } : null;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null;
  if (/[\r\n]/.test(value) || (/\s/.test(value) && !explicit && !/^(?:[./~\\]|[a-z]:[\\/])/i.test(value))) return null;
  return IMAGE_EXTENSION.test(value) ? { source: value, path: value } : null;
}

/**
 * Collect only output values; callers deliberately leave tool inputs out and
 * exclude file contents. Tool text needs an image-generation tool or an explicit
 * generation report; an image address alone does not establish a generated image.
 * toolOutput candidates are guesses, so unreadable images must disappear without
 * disturbing the user. Reply Markdown and written paths express the agent's intent:
 * those renderers must retain a generic failure reason and the image address.
 * The explicit flag below only controls parsing; it does not change that policy.
 */
export function extractGeneratedImages(value: unknown, options: { toolOutput?: boolean; generated?: boolean } = {}): GeneratedImage[] {
  // Keep occurrences: separate output entries can share a source.
  const images: GeneratedImage[] = [];
  // Guard ancestor cycles without suppressing repeated list entries.
  const seen = new Set<object>();
  const add = (source: string, explicit = false) => {
    const image = imageSource(source, explicit);
    if (image) images.push(image);
  };
  const text = (source: string) => {
    if (options.toolOutput) {
      // Listing columns describe filenames, not standalone image addresses.
      // Remove the entire row before scanning quotes, links or path prefixes.
      source = source.split(/\r?\n/).filter((line) =>
        !/^\s*[bcdlps?-][rwxstST-]{9}[@+.]?\s+\d+\s/.test(line)).join("\n");
      // A bare filename is unambiguous only when it fills a complete line.
      source = source.split(/\r?\n/).map((line) => {
        if (!/\s/.test(line.trim()) && imageSource(line)) {
          add(line);
          return "";
        }
        return line;
      }).join("\n");
    }
    // Direct image addresses may fill the whole value; local paths are scanned below.
    const whole = imageSource(source);
    if (whole && !whole.path && !source.includes("\n")) {
      add(source);
      return;
    }
    let rest = source.replace(/(!?)\[[^\]\n]*\]\((<[^>\n]+>|(?:[^\s()]|\([^()\n]*\))+?)(?:\s+["'][^\n]*?["'])?\)/g,
      (match, image: string, target: string) => {
        add(target.replace(/^<|>$/g, "").replace(/\\([!-\/:-@\[-`{-~])/g, "$1"), image === "!" || target.startsWith("<"));
        return " ";
      });
    rest = rest.replace(/[`"']([^`"'\n]+)[`"']/g, (match, target: string) => {
      if (!imageSource(target, true)) return match;
      add(target, true);
      return " ";
    });
    // Consume URLs before scanning local paths so their slashes cannot be
    // mistaken for a filesystem root.
    rest = rest.replace(/(?:https?:\/\/|file:\/\/|blob:)[^\s<>"'`]+/gi, (target) => {
      add(target.replace(/[),.;!]+$/, ""));
      return " ";
    });
    // A path prefix fixes the starting point even when the filename contains
    // spaces. Consume the full path before the token scan, which would otherwise
    // rediscover its last word as a different file relative to the agent cwd.
    rest = rest.replace(/(^|[^\w./\\:-])((?:[a-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/]|[\w.-]+[\\/])[^\r\n<>"'`()[\]]*?\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg))(?=$|[\s),;!?]|\.(?:\s|$))/gi, (match, boundary: string, target: string, offset: number) => {
      if (options.toolOutput && !/^(?:[a-z]:[\\/]|[./~\\])/i.test(target)) {
        // An unrooted path after prose could be the tail of a spaced directory
        // name. Require a line start or an explicit field separator instead.
        const prefix = rest.slice(rest.lastIndexOf("\n", offset - 1) + 1, offset + boundary.length).trim();
        if (prefix && !/[:=]$/.test(prefix)) return `${boundary} `;
      }
      add(target, true);
      return `${boundary} `;
    });
    // Replies retain the prose fallback; tool text must not yield a suffix of
    // an unquoted filename containing spaces or another ambiguous phrase.
    if (options.toolOutput) return;
    for (const match of rest.matchAll(/(?:https?:\/\/|file:\/\/|blob:)[^\s<>"'`]+|(?:[a-z]:[\\/]|[./~\\]|\b)[^\s<>"'`()[\]]*\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)(?:[?#][^\s<>"'`()[\]]*)?/gi)) {
      add(match[0].replace(/[),.;!]+$/, ""));
    }
  };
  const visit = (entry: unknown, depth: number, explicit = false, generated = options.generated === true): void => {
    if (depth > 12 || entry === null || entry === undefined) return;
    if (typeof entry === "string") {
      if (options.toolOutput && !explicit && !generated &&
        !/^\s*(?:[-*]\s+)?(?:(?:generated|created|saved)\s+(?:an?\s+)?images?\b|images?\s+(?:was\s+|were\s+)?generated\b)/im.test(entry)) return;
      if (explicit && imageSource(entry, true)) add(entry, true);
      else text(entry);
      return;
    }
    if (typeof entry !== "object" || seen.has(entry)) return;
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child, depth + 1, explicit, generated);
      seen.delete(entry);
      return;
    }
    const obj = entry as Record<string, unknown>;
    const mime = obj.mimeType ?? obj.mediaType ?? obj.media_type;
    const data = obj.data ?? obj.base64;
    if (typeof mime === "string" && mime.startsWith("image/") && typeof data === "string") {
      add(data.startsWith("data:") ? data : `data:${mime};base64,${data}`);
    }
    const image = explicit || obj.type === "image" || obj.type === "image_url" || obj.type === "output_image" || obj.type === "generated_image" || (typeof mime === "string" && mime.startsWith("image/"));
    for (const [key, child] of Object.entries(obj)) {
      if (key === "data" || key === "base64" || key === "mimeType" || key === "mediaType" || key === "media_type") continue;
      const generatedField = key === "generated_image" || key === "generated_images";
      visit(child, depth + 1,
        generatedField || ((!options.toolOutput || generated) && ["images", "image", "image_url"].includes(key)) ||
          (image && ["source", "url", "uri", "path", "file_path", "image_path", "image_url"].includes(key)),
        generated || generatedField);
    }
    seen.delete(entry);
  };
  visit(value, 0);
  return images;
}
