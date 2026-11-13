import type { HermesCcImageInput } from "./store";
import type { ImageSaveOutcome } from "./save-retry";
import type { HermesCcSaveStatusKey } from "./save-status";

export interface HermesCcCaptureStatus {
  begin(key: HermesCcSaveStatusKey): Promise<void>;
  fail(key: HermesCcSaveStatusKey, reason: string, attempts: number): Promise<void>;
  clear(key: HermesCcSaveStatusKey): Promise<void>;
}

export interface HermesCcCaptureOptions {
  status: HermesCcCaptureStatus;
  save(key: HermesCcSaveStatusKey, images: readonly HermesCcImageInput[]): Promise<ImageSaveOutcome>;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

/**
 * Register a durable pending marker and return immediately: the provider hook
 * runs before connection.send(), so awaiting the save would stall the turn for
 * as long as the disk lock lives. The save and its retries continue in the
 * background and replace the pending marker with either nothing or saveFailed.
 */
export function createHermesCcImageCapture(options: HermesCcCaptureOptions) {
  return async (key: HermesCcSaveStatusKey, images: readonly HermesCcImageInput[]): Promise<void> => {
    await options.status.begin(key);
    void options.save(key, images).then(async (outcome) => {
      if (outcome.failure) {
        await options.status.fail(key, outcome.failure.reason, outcome.failure.attempts);
        options.warn?.(`[clear-chat] hermes_cc: save_failed ${outcome.failure.reason} message=${key.messageId} attempts=${outcome.failure.attempts}`);
        return;
      }
      await options.status.clear(key);
      if (outcome.result === "conflict") options.debug?.("[clear-chat] hermes_cc: save_conflict");
    }).catch(() => {
      options.warn?.(`[clear-chat] hermes_cc: save_status_write_failed message=${key.messageId}`);
    });
  };
}
