import { useEffect, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { imageRpc } from "../shared/image-rpc";
import { stripFileSelector } from "../shared/file-path";

/** What the daemon side could tell the client about one image file. */
export interface ImageFile {
  dataUri: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  error: string | null;
}

/**
 * File extensions worth previewing.
 *
 * The client decides whether to ask at all, so a read of a `.ts` file never
 * costs an RPC. The daemon holds the same list and refuses anything outside
 * it, because that side is the one handing bytes to an `<img>`.
 */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "ico",
  "svg",
]);

/** True when this path names a file the chat can draw rather than tokenise. */
export function isImagePath(path: string | undefined): boolean {
  if (!path) return false;
  const clean = stripFileSelector(path);
  const dot = clean.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMAGE_EXTENSIONS.has(clean.slice(dot + 1).toLowerCase());
}

/**
 * Reads an image through the plugin's own daemon-side RPC.
 *
 * Null while the read is in flight. Failures carry a generic message so no
 * consumer can accidentally display daemon filesystem or RPC error details.
 */
export function useImageFile(path: string | undefined, cwd: string | null): ImageFile | null {
  const load = useRpc(imageRpc);
  const [loaded, setLoaded] = useState<{ path: string; cwd: string | null; file: ImageFile } | null>(null);
  const wanted = path !== undefined && isImagePath(path);

  useEffect(() => {
    if (!wanted || path === undefined) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    setLoaded(null);
    load({ cwd: cwd ?? "", path })
      .then((result) => {
        if (cancelled) return;
        setLoaded({ path, cwd, file: {
          dataUri: result.dataUri,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          error: result.error ? "Image could not be loaded." : null,
        } });
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded({ path, cwd, file: {
          dataUri: null,
          width: null,
          height: null,
          bytes: null,
          error: "Image could not be loaded.",
        } });
      });
    return () => {
      cancelled = true;
    };
  }, [load, path, cwd, wanted]);

  return wanted && loaded?.path === path && loaded.cwd === cwd ? loaded.file : null;
}
