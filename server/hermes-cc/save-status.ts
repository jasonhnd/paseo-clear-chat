import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HermesCcSaveStatusKey { sessionKey: string; messageId: string }

export type HermesCcSaveStatus =
  | { state: "pending"; at: number }
  | { state: "saveFailed"; at: number; reason: string; attempts: number };

/** A pending marker older than this is treated as a failed save. */
export const PENDING_TIMEOUT_MS = 2 * 60_000;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_ENTRIES = 1024;
const FILE = /^[a-f0-9]{64}\.json$/;

export interface HermesCcSaveStatusStore {
  begin(key: HermesCcSaveStatusKey): Promise<void>;
  fail(key: HermesCcSaveStatusKey, reason: string, attempts: number): Promise<void>;
  clear(key: HermesCcSaveStatusKey): Promise<void>;
  /** Reads the marker; an expired pending is converted to saveFailed here. */
  read(key: HermesCcSaveStatusKey): Promise<HermesCcSaveStatus | null>;
  /** Drops entries older than 30 days and keeps at most 1024 newest. */
  sweep(): Promise<void>;
}

function hashKey(key: HermesCcSaveStatusKey): string {
  for (const id of [key.sessionKey, key.messageId]) {
    if (typeof id !== "string" || !id.trim() || id.length > 512 || id.includes("\0")) throw new Error("invalid_status_key");
  }
  return createHash("sha256").update(`${key.sessionKey}\0${key.messageId}`).digest("hex");
}

function valid(value: unknown): value is HermesCcSaveStatus {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) return false;
  if (record.state === "pending") return true;
  return record.state === "saveFailed" && typeof record.reason === "string"
    && typeof record.attempts === "number" && Number.isSafeInteger(record.attempts);
}

export function createHermesCcSaveStatusStore(dir: string): HermesCcSaveStatusStore {
  async function write(name: string, value: HermesCcSaveStatus): Promise<void> {
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, `.${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, join(dir, name));
  }
  async function readName(name: string, messageId?: string): Promise<HermesCcSaveStatus | null> {
    try {
      const value: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (!valid(value)) return null;
      if (value.state === "pending" && Date.now() - value.at > PENDING_TIMEOUT_MS) {
        const failed: HermesCcSaveStatus = { state: "saveFailed", at: value.at, reason: "pending_timeout", attempts: 0 };
        await write(name, failed);
        if (messageId !== undefined) {
          (console.warn ?? console.debug)?.(`[clear-chat] hermes_cc: save_failed pending_timeout message=${messageId} attempts=0`);
        }
        return failed;
      }
      return value;
    } catch { return null; }
  }
  return {
    async begin(key) { await write(`${hashKey(key)}.json`, { state: "pending", at: Date.now() }); },
    async fail(key, reason, attempts) {
      await write(`${hashKey(key)}.json`, { state: "saveFailed", at: Date.now(), reason, attempts });
    },
    async clear(key) {
      try { await unlink(join(dir, `${hashKey(key)}.json`)); } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      }
    },
    async read(key) { return await readName(`${hashKey(key)}.json`, key.messageId); },
    async sweep() {
      let names: string[];
      try { names = (await readdir(dir)).filter(name => FILE.test(name)); }
      catch { return; }
      const now = Date.now();
      const alive: { name: string; at: number }[] = [];
      for (const name of names) {
        const value = await readName(name);
        if (!value || now - value.at > MAX_AGE_MS) {
          try { await unlink(join(dir, name)); } catch { /* another sweep may win */ }
          continue;
        }
        alive.push({ name, at: value.at });
      }
      alive.sort((left, right) => right.at - left.at);
      for (const entry of alive.slice(MAX_ENTRIES)) {
        try { await unlink(join(dir, entry.name)); } catch { /* another sweep may win */ }
      }
    },
  };
}
