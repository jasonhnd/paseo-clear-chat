import React, { useState } from "react";
import { Image, Text, View, StyleSheet } from "react-native";
import { CopyFallbackDialog, useCopyText } from "../copy-feedback";
import { openLink } from "../open-link";
import { radius, type ExtendedThemeTokens } from "../theme-tokens";

interface MarkdownImageProps {
  src: string;
  alt: string;
  tokens: ExtendedThemeTokens;
}

interface ImageLoadMetadata {
  source?: { width?: unknown; height?: unknown } | null;
  target?: { naturalWidth?: unknown; naturalHeight?: unknown } | number | null;
}

const MAX_HEIGHT = 280;
const styles = StyleSheet.create({
  frame: { minWidth: 0, alignSelf: "stretch" },
  image: { width: "100%", height: MAX_HEIGHT, borderRadius: radius.block },
});

function isWebImage(src: string): boolean {
  if (!/^https?:\/\//i.test(src)) return false;
  try {
    const url = new URL(src);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isImageData(src: string): boolean {
  return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,.+$/i.test(src);
}

/** Images occupy a native View, never an inline Text line box. */
export function MarkdownImage({ src, alt, tokens }: MarkdownImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [size, setSize] = useState<{ src: string; width: number; height: number } | null>(null);
  const supported = isWebImage(src) || isImageData(src);

  if (!supported || failedSrc === src) {
    return <ImageFallback src={src} alt={alt} tokens={tokens} unsupported={!supported} />;
  }

  const currentSize = size?.src === src ? size : null;
  const ratio = currentSize ? currentSize.width / currentSize.height : null;
  const imageWidth = currentSize && ratio && width > 0
    ? Math.min(width, currentSize.width, MAX_HEIGHT * ratio)
    : null;

  return (
    <View style={styles.frame} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <Image
        source={{ uri: src }}
        accessibilityLabel={alt || "Image"}
        resizeMode="contain"
        style={imageWidth !== null && ratio
          ? { width: imageWidth, height: imageWidth / ratio, borderRadius: radius.block }
          : styles.image}
        onLoad={(event) => {
          // Native reports source dimensions; Web forwards the browser load event.
          const metadata = event.nativeEvent as ImageLoadMetadata;
          const target = typeof metadata.target === "object" ? metadata.target : null;
          const loadedWidth = metadata.source?.width ?? target?.naturalWidth;
          const loadedHeight = metadata.source?.height ?? target?.naturalHeight;
          if (typeof loadedWidth === "number" && typeof loadedHeight === "number"
            && Number.isFinite(loadedWidth) && Number.isFinite(loadedHeight)
            && loadedWidth > 0 && loadedHeight > 0) {
            setSize({ src, width: loadedWidth, height: loadedHeight });
          }
        }}
        onError={() => setFailedSrc(src)}
      />
    </View>
  );
}

function ImageFallback({ src, alt, tokens, unsupported }: MarkdownImageProps & { unsupported: boolean }) {
  const { handleCopy, fallbackText, setFallbackText } = useCopyText(src);
  const web = isWebImage(src);
  const textStyle = { color: tokens.foregroundMuted, fontFamily: tokens.fontUi, fontSize: tokens.fs(13), lineHeight: tokens.fs(20) };
  return (
    <View style={{ gap: 4, minWidth: 0 }}>
      <Text selectable style={textStyle}>{alt || "Image"}</Text>
      <Text style={textStyle}>{unsupported ? "This image source is not supported." : "The image could not be loaded."}</Text>
      <Text
        selectable
        accessibilityRole={web ? "link" : "button"}
        accessibilityLabel={web ? `Open image address: ${src}` : "Copy image address"}
        onPress={web ? () => openLink(src) : handleCopy}
        style={[textStyle, { color: tokens.accent, textDecorationLine: "underline" }]}
      >
        {src || "Empty image address"}
      </Text>
      <CopyFallbackDialog text={fallbackText} onClose={() => setFallbackText(null)} tokens={tokens} />
    </View>
  );
}
