import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { presentationSettings } from "../shared/settings";
import { STARTUP_MESSAGES } from "../shared/startup-diagnostics";

const LEGACY_PLUGIN_ID = "beautiful-chat";
const PLUGIN_ID = "clear-chat";

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

/**
 * The SDK scopes settings to the installation ID but exposes no directory API.
 * Its Node worker can copy the existing envelope before settings are registered.
 * Keep this synchronous: a contribution must return its cleanup synchronously.
 * Migration is best effort: log failures and let settings registration continue
 * with SDK defaults when no document exists. Keep legacy data for a later retry.
 */
export function migrateHostSettings(): void {
  const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const root = join(paseoHome, "plugin-settings");
  const filename = `${presentationSettings.id}.json`;
  const source = join(root, LEGACY_PLUGIN_ID, filename);
  const directory = join(root, PLUGIN_ID);
  const target = join(directory, filename);

  try {
    try {
      lstatSync(target);
      return;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }

    let raw: Buffer;
    try {
      raw = readFileSync(source);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }

    mkdirSync(directory, { recursive: true });
    const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, raw, { flag: "wx", mode: 0o600 });
      try {
        // Publish a complete, independent copy atomically. Linking the temporary
        // copy (never the source) fails with EEXIST if new settings already exist.
        linkSync(temporary, target);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch {
    console.error(STARTUP_MESSAGES.migrationFailed);
  }
}
