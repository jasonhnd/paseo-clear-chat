import type { HermesCcImageInput, HermesCcImageKey } from "./store";

export interface ImageSaveFailure {
  reason: string;
  attempts: number;
}

export type ImageSaveOutcome =
  | { result: "saved" | "conflict"; failure?: undefined }
  | { failure: ImageSaveFailure; result?: undefined };

/** Wait between retries: three retries after the first attempt. */
export const SAVE_RETRY_DELAYS_MS: readonly number[] = [100, 400, 1600];

function errorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  if (error.message === "image_lock_timeout") return "image_lock_timeout";
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string" && code) return code;
  const reason = (error as Error & { reason?: unknown }).reason;
  if (typeof reason === "string" && reason) return reason;
  return null;
}

/** Only lock contention and transient fd/busy errors are worth another attempt. */
export function retryableSaveReason(error: unknown): string | null {
  const code = errorCode(error);
  return code === "image_lock_timeout" || code === "EAGAIN" || code === "EMFILE" || code === "EBUSY" ? code : null;
}

/**
 * Save with at most three transient retries. A permanent failure (including a
 * non-retryable errno such as ENOSPC or EACCES) returns its reason after the
 * first attempt so the caller can record a per-message "save failed" marker.
 */
export async function saveWithRetry(
  store: { save(key: HermesCcImageKey, images: readonly HermesCcImageInput[]): Promise<"saved" | "conflict"> },
  key: HermesCcImageKey,
  images: readonly HermesCcImageInput[],
  delays: readonly number[] = SAVE_RETRY_DELAYS_MS,
): Promise<ImageSaveOutcome> {
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return { result: await store.save(key, images) };
    } catch (error) {
      const retryable = retryableSaveReason(error);
      if (retryable === null || attempts > delays.length) {
        return { failure: { reason: retryable ?? errorCode(error) ?? "image_store_failed", attempts } };
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempts - 1]));
    }
  }
}
