import { useRpc, useTranslation } from "@getpaseo/plugin/client";
import { messages } from "../messages";
import { translate as t } from "../translation";
import React, { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet, Image, Modal, Platform, useWindowDimensions } from "react-native";
import { CopyFallbackDialog, copyTouchTarget, useCopyText } from "./copy-feedback";
import { Glyph } from "./glyph";
import { Pop } from "./motion";
import { radius } from "./theme-tokens";
import type { ExtendedThemeTokens } from "./theme-tokens";
import { selectableSurface } from "./selection";
import { selectionSurface } from "./selection-actions";
import { MessageOutput } from "./message-output";
import type { ToolExpansionIdentity } from "../tool-expansion-store";
import { promptImageRpc, promptImagesRpc } from "../../shared/prompt-images-rpc";

export interface TurnUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  contextWindowUsedTokens?: number;
  contextWindowMaxTokens?: number;
}

interface UserMessageProps {
  text: string;
  timestamp?: Date;
  /** Pasted or attached images, as anything `<Image>` accepts. */
  images?: string[];
  /** Total attachments, including images whose data is unavailable. */
  imageCount?: number;
  /** Host agent id. The timeline renderer has it; the transformer does not. */
  agentId?: string;
  /** Provider message id, when the timeline item carried one. */
  messageId?: string;
  /** Composer message id, when the timeline item carried one. */
  clientMessageId?: string;
  tokens: ExtendedThemeTokens;
  /** Absent until the turn reports usage, and absent entirely for turns this
   * client did not observe live — usage is not persisted on timeline items. */
  usage?: TurnUsage | null;
  /** True while the turn is still running, so the figures are still climbing. */
  pending?: boolean;
  expansionIdentity?: ToolExpansionIdentity;
}

/**
 * Token counts run to six digits. One decimal is kept through the whole
 * thousands range: rounding 94,336 to `94k` hides the movement between turns,
 * which is the only reason to watch the number.
 */
function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  // Rounding is done on integers: 97850 / 1000 is held as 97.8499…, so
  // `toFixed(1)` would report 97.8 for a value that is 97.9k.
  if (value < 1_000_000) return t("prompt.tokensK", { count: value / 1000, replace: { count: (Math.round(value / 100) / 10).toFixed(1) } });
  return t("prompt.tokensM", { count: value / 1_000_000, replace: { count: (Math.round(value / 100_000) / 10).toFixed(1) } });
}

/** Tallest pasted thumbnail. Width follows the image and the bubble. */
const MAX_THUMB_HEIGHT = 96;
const THUMB_GAP = 6;
const MORE_CHIP_WIDTH = 44;

interface PastedThumb {
  id: string;
  thumbDataUri: string;
  mime: string;
  width: number | null;
  height: number | null;
}

interface PastedList {
  images: PastedThumb[];
  total: number;
}

type PastedCache = PastedList | { failed: true };

const pastedCache = new Map<string, PastedCache>();
const pastedInflight = new Map<string, Promise<PastedCache>>();
const fullImageCache = new Map<string, string | null>();

/**
 * Message key for the image lookup. Prefer the provider id, then the composer
 * id, then the text when the host gave neither id.
 */
function pastedMessageKey(messageId?: string | null, clientMessageId?: string | null, text?: string): string {
  if (messageId) return `m:${messageId}`;
  if (clientMessageId) return `c:${clientMessageId}`;
  return `t:${text ?? ""}`;
}

function pastedCacheKey(agentId: string, messageId?: string | null, clientMessageId?: string | null, text?: string): string {
  return `${agentId}\0${pastedMessageKey(messageId, clientMessageId, text)}`;
}

/** Interior of the 82% bubble after its own horizontal padding. */
function bubbleInnerWidth(windowWidth: number): number {
  return Math.max(120, Math.floor(windowWidth * 0.82) - 22);
}

function readPastedList(result: {
  images?: { id?: string; thumbDataUri?: string; mime?: string; width?: number | null; height?: number | null }[];
  total?: number;
} | null | undefined): PastedCache {
  if (!result || !Array.isArray(result.images)) return { failed: true };
  const images: PastedThumb[] = [];
  for (const image of result.images) {
    if (!image || typeof image.id !== "string" || !image.id || typeof image.thumbDataUri !== "string" || !image.thumbDataUri) continue;
    images.push({
      id: image.id,
      thumbDataUri: image.thumbDataUri,
      mime: typeof image.mime === "string" ? image.mime : "",
      width: typeof image.width === "number" ? image.width : null,
      height: typeof image.height === "number" ? image.height : null,
    });
  }
  const total = typeof result.total === "number" && Number.isFinite(result.total) ? Math.max(0, result.total) : images.length;
  return { images, total };
}

function isPastedList(value: PastedCache | null): value is PastedList {
  return !!value && "images" in value;
}

function fitFrame(
  image: { width: number | null; height: number | null },
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const ratio = image.width && image.height && image.width > 0 && image.height > 0 ? image.width / image.height : 1;
  const limitW = Math.max(1, maxWidth);
  const limitH = Math.max(1, maxHeight);
  let height = limitH;
  let width = height * ratio;
  if (width > limitW) {
    width = limitW;
    height = width / ratio;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

function formatClock(value: Date): string {
  const hh = String(value.getHours()).padStart(2, "0");
  const mm = String(value.getMinutes()).padStart(2, "0");
  const ss = String(value.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

/** One labelled figure. A missing count is omitted, never shown as zero. */
function UsageFigure({
  label,
  value,
  styles,
}: {
  label: string;
  value?: number;
  styles: { usageKey: object; usageValue: object };
}) {
  if (typeof value !== "number") return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Text selectable style={styles.usageKey}>
        {label}
      </Text>
      <Text selectable style={styles.usageValue}>
        {formatTokens(value)}
      </Text>
    </View>
  );
}

/**
 * The user's turn. It sits to the right on light paper with dark text and no
 * accent: colour on this surface marks agent activity, so keeping it off the
 * prompt is what separates what the user wrote from what the agent did.
 * The body text stays left-aligned inside the block, because right-ragged
 * prose is harder to read once it wraps.
 */
export function UserMessage({
  text,
  timestamp,
  images,
  imageCount,
  agentId,
  messageId,
  clientMessageId,
  tokens,
  usage,
  pending = false,
  expansionIdentity,
}: UserMessageProps) {
  const { t } = useTranslation(messages);
  const { copied, handleCopy, fallbackText, setFallbackText } = useCopyText(text);
  const loadImages = useRpc(promptImagesRpc);
  const loadImage = useRpc(promptImageRpc);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [failedImages, setFailedImages] = useState<ReadonlySet<string>>(() => new Set());
  const [failedThumbs, setFailedThumbs] = useState<ReadonlySet<string>>(() => new Set());
  const attachmentCount = Math.max(imageCount ?? 0, images?.length ?? 0);
  const cacheKey = agentId ? pastedCacheKey(agentId, messageId, clientMessageId, text) : "";
  const [pasted, setPasted] = useState<PastedCache | null>(cacheKey ? pastedCache.get(cacheKey) ?? null : null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [fullUri, setFullUri] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId || !cacheKey) return;
    const cached = pastedCache.get(cacheKey);
    if (cached) {
      setPasted(cached);
      return;
    }
    let cancelled = false;
    let pendingLookup = pastedInflight.get(cacheKey);
    if (!pendingLookup) {
      pendingLookup = Promise.resolve()
        .then(() => loadImages({
          agentId,
          messageId: messageId ?? null,
          clientMessageId: clientMessageId ?? null,
          text,
        }))
        .then((result) => readPastedList(result))
        .catch(() => ({ failed: true }) satisfies PastedCache)
        .then((value) => {
          pastedCache.set(cacheKey, value);
          pastedInflight.delete(cacheKey);
          return value;
        });
      pastedInflight.set(cacheKey, pendingLookup);
    }
    pendingLookup.then((value) => {
      if (!cancelled) setPasted(value);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, cacheKey, clientMessageId, loadImages, messageId, text]);

  const list = isPastedList(pasted) ? pasted : null;
  const shown = (list?.images ?? []).filter((image) => !failedThumbs.has(image.id)).slice(0, 3);
  const extra = list ? Math.max(0, list.total - Math.min(3, list.images.length)) : 0;
  const openImage = shown.find((image) => image.id === viewerId) ?? list?.images.find((image) => image.id === viewerId) ?? null;

  useEffect(() => {
    if (!viewerId || !agentId) return;
    const fullKey = `${cacheKey}\0${viewerId}`;
    const cached = fullImageCache.get(fullKey);
    if (cached !== undefined) {
      setFullUri(cached);
      return;
    }
    let cancelled = false;
    loadImage({
      agentId,
      messageId: messageId ?? null,
      clientMessageId: clientMessageId ?? null,
      text,
      id: viewerId,
    })
      .then((result) => {
        const uri = result?.dataUri ?? null;
        fullImageCache.set(fullKey, uri);
        if (!cancelled) setFullUri(uri);
      })
      .catch(() => {
        fullImageCache.set(fullKey, null);
        if (!cancelled) setFullUri(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, cacheKey, clientMessageId, loadImage, messageId, text, viewerId]);

  useEffect(() => {
    if (!viewerId || Platform.OS !== "web") return;
    const doc = globalThis.document;
    if (!doc) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || event.isComposing || event.repeat ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      setViewerId(null);
    };
    doc.addEventListener("keydown", onKey, true);
    return () => doc.removeEventListener("keydown", onKey, true);
  }, [viewerId]);

  const innerWidth = bubbleInnerWidth(windowWidth);
  const thumbSlots = shown.length + (extra > 0 ? 1 : 0);
  const thumbMax = thumbSlots > 0
    ? Math.max(1, Math.floor((innerWidth - THUMB_GAP * Math.max(0, thumbSlots - 1) - (extra > 0 ? MORE_CHIP_WIDTH : 0)) / Math.max(1, shown.length)))
    : innerWidth;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          alignSelf: "flex-end",
          maxWidth: "82%",
          flexDirection: "row",
          gap: 10,
          paddingVertical: 8,
          paddingLeft: 12,
          paddingRight: 10,
          borderRadius: radius.card,
          // The square tail marks the turn's owner, matching the native stream.
          borderTopRightRadius: radius.chip,
          backgroundColor: tokens.userSurface,
          borderWidth: 1,
          borderColor: tokens.userBorder,
          ...tokens.boxShadow,
          ...selectableSurface,
        },
        body: { flex: 1, gap: 3 },
        metaRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
        },
        label: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(10),
          fontWeight: "600",
          letterSpacing: 0.4,
          textTransform: "uppercase",
          color: tokens.userTextMuted,
        },
        copyButton: {
          ...copyTouchTarget,
          paddingHorizontal: 4,
          paddingVertical: 2,
        },
        clock: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(10),
          color: tokens.userTextMuted,
        },
        text: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(13.5),
          lineHeight: tokens.fs(20),
          color: tokens.userText,
        },
        imageRow: {
          marginTop: 8,
          gap: 6,
        },
        image: {
          width: "100%",
          // Tall enough to read, bounded so a screenshot cannot take over
          // the thread.
          height: 200,
          borderRadius: radius.block,
          backgroundColor: tokens.userBorder,
        },
        attachmentCount: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(12),
          color: tokens.userTextMuted,
        },
        pastedRow: {
          marginTop: 8,
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          gap: THUMB_GAP,
          maxWidth: "100%",
        },
        thumb: {
          overflow: "hidden",
          borderRadius: radius.block,
          backgroundColor: tokens.userBorder,
        },
        thumbImage: {
          width: "100%",
          height: "100%",
        },
        moreChip: {
          width: MORE_CHIP_WIDTH,
          height: 28,
          borderRadius: radius.chip,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: tokens.userBorder,
        },
        moreText: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(12),
          fontWeight: "600",
          color: tokens.userText,
        },
        viewerBackdrop: {
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundColor: "rgba(0,0,0,0.72)",
        },
        viewerClose: {
          position: "absolute",
          top: 16,
          right: 16,
          minWidth: 44,
          minHeight: 44,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: radius.block,
          backgroundColor: tokens.surface1,
        },
        usageRow: {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-end",
          flexWrap: "wrap",
          gap: 10,
          marginTop: 7,
          paddingTop: 6,
          borderTopWidth: 1,
          borderTopColor: tokens.userBorder,
        },
        usageKey: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(10),
          color: tokens.userTextMuted,
        },
        usageValue: {
          fontFamily: tokens.fontUi,
          fontSize: tokens.fs(11),
          fontWeight: "600",
          color: tokens.userText,
        },
      }),
    [tokens],
  );

  return (
    <View {...selectionSurface} style={styles.container}>
      <CopyFallbackDialog text={fallbackText} onClose={() => setFallbackText(null)} tokens={tokens} />
      <View style={styles.body}>
        <View style={styles.metaRow}>
          <Text selectable style={styles.label}>
            {t("prompt.you")}
          </Text>
          {timestamp ? (
            <Text selectable style={styles.clock}>
              {formatClock(timestamp)}
            </Text>
          ) : null}
          <Pressable
            onPress={handleCopy}
            accessibilityRole="button"
            accessibilityLabel={t("prompt.copyA11y")}
            style={styles.copyButton}
          >
            <Pop trigger={copied}>
              <Glyph
                name={copied ? "Check" : "Copy"}
                size={11}
                color={copied ? tokens.userText : tokens.userTextMuted}
              />
            </Pop>
          </Pressable>
        </View>
        <MessageOutput text={text} tokens={tokens} identity={expansionIdentity} part="prompt">
          {(shownText) => <Text selectable style={styles.text}>{shownText}</Text>}
        </MessageOutput>
        {shown.length > 0 ? (
          <View style={styles.pastedRow}>
            {shown.map((image) => {
              const frame = fitFrame(image, thumbMax, MAX_THUMB_HEIGHT);
              return (
                <Pressable
                  key={image.id}
                  testID="prompt-pasted-thumb"
                  accessibilityRole="button"
                  accessibilityLabel={t("prompt.imageThumbA11y")}
                  onPress={() => {
                    setFullUri(fullImageCache.get(`${cacheKey}\0${image.id}`) ?? null);
                    setViewerId(image.id);
                  }}
                  style={[styles.thumb, frame]}
                >
                  <Image
                    accessible={false}
                    source={{ uri: image.thumbDataUri }}
                    style={styles.thumbImage}
                    resizeMode="contain"
                    onError={() => setFailedThumbs((previous) => new Set(previous).add(image.id))}
                  />
                </Pressable>
              );
            })}
            {extra > 0 ? (
              <View testID="prompt-pasted-more" style={styles.moreChip}>
                <Text style={styles.moreText}>{t("prompt.moreImages", { count: extra })}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {viewerId && openImage ? (
          <Modal transparent visible animationType="fade" onRequestClose={() => setViewerId(null)}>
            <View style={styles.viewerBackdrop} accessibilityViewIsModal>
              <Pressable
                testID="prompt-image-close"
                accessibilityRole="button"
                accessibilityLabel={t("prompt.closeImage")}
                onPress={() => setViewerId(null)}
                style={styles.viewerClose}
              >
                <Glyph name="X" size={18} color={tokens.foreground} />
              </Pressable>
              <Image
                testID="prompt-image-full"
                source={{ uri: fullUri || openImage.thumbDataUri }}
                accessibilityLabel={t("prompt.imageThumbA11y")}
                style={fitFrame(
                  openImage,
                  Math.max(1, Math.min(960, windowWidth - 48)),
                  Math.max(1, Math.min(720, Math.floor(windowHeight * 0.75))),
                )}
                resizeMode="contain"
              />
            </View>
          </Modal>
        ) : null}
        {attachmentCount > 0 ? (
          <View style={styles.imageRow}>
            <Text selectable style={styles.attachmentCount}>
              {t("prompt.imagesAttached", { count: attachmentCount })}
            </Text>
            {images?.filter((uri) => !failedImages.has(uri)).map((uri) => (
              <Image
                key={uri}
                source={{ uri }}
                style={styles.image}
                resizeMode="contain"
                accessibilityLabel={t("prompt.imageA11y")}
                onError={() => setFailedImages((previous) => new Set(previous).add(uri))}
              />
            ))}
          </View>
        ) : null}
        {usage ? (
          <View style={styles.usageRow}>
            <UsageFigure label={t("prompt.usageIn")} value={usage.inputTokens} styles={styles} />
            <UsageFigure label={t("prompt.usageCached")} value={usage.cachedInputTokens} styles={styles} />
            <UsageFigure label={t("prompt.usageOut")} value={usage.outputTokens} styles={styles} />
            {pending ? (
              <Text selectable style={styles.usageKey}>
                {t("prompt.counting")}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}
