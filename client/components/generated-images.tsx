import React from "react";
import { View, Linking, Platform } from "react-native";
import { useRpc } from "@getpaseo/plugin/client";
import { revealPathRpc } from "../../shared/file-rpc";
import { useImageFile } from "../image-file";
import type { GeneratedImage } from "../generated-images";
import { ImagePreview } from "./image-preview";
import { openLink } from "./open-link";
import type { ExtendedThemeTokens } from "./theme-tokens";

/** Embedded images need a browser-local URL; the daemon cannot open one. */
export function openImage(source: string): void {
  if (/^https?:\/\//i.test(source)) {
    void openLink(source);
    return;
  }
  if (Platform.OS !== "web") {
    void Linking.openURL(source).catch(() => {});
    return;
  }
  try {
    // Keep embedded SVG in an image context, including when the source opens
    // in a new tab. The viewer's policy prevents active document content.
    const escaped = source.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const viewer = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:"><img alt="Generated image" src="${escaped}">`;
    const target = URL.createObjectURL(new Blob([viewer], { type: "text/html" }));
    setTimeout(() => URL.revokeObjectURL(target), 60_000);
    globalThis.open?.(target, "_blank", "noopener,noreferrer");
  } catch {
    // A malformed embedded image still retains its reported address.
  }
}

function GeneratedImagePreview({ image, cwd, tokens, renderUnavailable }: {
  image: GeneratedImage;
  cwd: string | null;
  tokens: ExtendedThemeTokens;
  renderUnavailable?: (image: GeneratedImage) => React.ReactNode;
}) {
  const reveal = useRpc(revealPathRpc);
  const local = useImageFile(image.path, cwd);
  const file = image.path ? local : {
    dataUri: image.source, width: null, height: null, bytes: null, error: null,
  };
  // Guessed tool-output images stay silent when unreadable: a wrong guess should
  // not disturb the user. Explicit reply callers supply a reason/address fallback
  // because the agent deliberately offered that image. Neither exposes RPC errors.
  if (!file) return null;
  const unavailable = renderUnavailable?.(image);
  if (!file.dataUri || file.error) return unavailable ?? null;
  return <ImagePreview
    path={image.source}
    file={file}
    unavailable={unavailable}
    tokens={tokens}
    revealLabel={image.path ? `Show ${image.source} in the file manager` : "Open image source"}
    onReveal={() => {
      if (image.path) void reveal({ cwd: cwd ?? "", path: image.path }).catch(() => {});
      else openImage(image.source);
    }}
  />;
}

export function GeneratedImages({ images, cwd = null, tokens, renderUnavailable }: {
  images: GeneratedImage[];
  cwd?: string | null;
  tokens: ExtendedThemeTokens;
  /** Explicit replies retain a generic reason and address; guesses omit this. */
  renderUnavailable?: (image: GeneratedImage) => React.ReactNode;
}) {
  if (!images.length) return null;
  return <View testID="generated-images" style={{ gap: 8 }}>
    {images.map((image, index) => <GeneratedImagePreview key={`${index}:${image.source}`} image={image} cwd={cwd} tokens={tokens} renderUnavailable={renderUnavailable} />)}
  </View>;
}
