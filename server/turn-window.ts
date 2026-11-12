import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginServerContext } from "@getpaseo/plugin/server";

export const OVERLAP_WARNING = "Other conversations were running in this workspace during this period, so these changes may not all belong to this turn.";
export const NOT_GIT = "This workspace is not a Git repository; changes cannot be shown yet.";
export const INCOMPLETE = "Snapshot timing or overlap with other conversations may be incomplete.";

type Snapshot = { kind: "ok"; files: Map<string, string>; head?: string | null } | { kind: "not-git" | "error" };
type Result = { files: string[]; message: string | null; warning: string | null; incomplete: boolean };
type Window = { agentId: string; workspace: string | null; cwd: string; before: Promise<Snapshot>; overlap: boolean; ended: boolean; invalid?: boolean; finishing?: Promise<void>; result?: Result };
async function git(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await promisify(execFile)("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
    cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

/** Read Git's status and fingerprints without changing its index or worktree. */
export async function snapshot(cwd: string, execute: typeof git = git): Promise<Snapshot> {
  let root: string;
  try { root = (await execute(cwd, ["rev-parse", "--show-toplevel"])).toString().trim(); }
  catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString() ?? "";
    return { kind: stderr.includes("not a git repository") ? "not-git" : "error" };
  }
  try {
    const [status, index, head] = await Promise.all([
      execute(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]),
      execute(root, ["ls-files", "--stage", "-z"]),
      execute(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(value => value.toString().trim()).catch(() => null),
    ]);
    const indexEntries = new Map<string, string[]>();
    for (const entry of index.toString().split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      if (tab < 0) throw new Error("Invalid index");
      const path = entry.slice(tab + 1);
      indexEntries.set(path, [...(indexEntries.get(path) ?? []), entry.slice(0, tab)]);
    }
    const files = new Map<string, string>();
    for (const entry of status.toString().split("\0")) {
      if (!entry) continue;
      const path = entry.slice(3);
      let content: string;
      try {
        const full = join(root, path);
        const info = await lstat(full);
        if (info.isSymbolicLink()) content = `link:${await readlink(full)}`;
        else if (info.isFile()) content = `file:${info.mode}:${createHash("sha256").update(await readFile(full)).digest("hex")}`;
        else if (info.isDirectory()) content = `directory:${info.mode}:${info.mtimeMs}`;
        else throw new Error("Unsupported entry");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") content = "missing";
        else throw error;
      }
      files.set(path, JSON.stringify([entry.slice(0, 2), indexEntries.get(path) ?? [], content]));
    }
    return { kind: "ok", files, head };
  } catch { return { kind: "error" }; }
}

export function createTurnWindows(capture: (cwd: string) => Promise<Snapshot> = snapshot) {
  const windows = new Map<string, Window>();
  const key = (agentId: string, turnId: string | null) => JSON.stringify([agentId, turnId]);
  const unavailable = (): Result => ({ files: [], message: INCOMPLETE, warning: null, incomplete: true });
  return {
    before(agentId: string, turnId: string | null, workspace: string | null, cwd: string) {
      const id = key(agentId, turnId);
      const existing = windows.get(id);
      if (existing) { existing.invalid = true; if (existing.ended) existing.result = unavailable(); return existing.before.then(() => {}); }
      const window: Window = { agentId, workspace, cwd, before: capture(cwd), overlap: false, ended: false };
      for (const other of windows.values()) {
        if (!other.ended && other.agentId !== agentId && workspace !== null && other.workspace === workspace) {
          other.overlap = window.overlap = true;
        }
      }
      windows.set(id, window);
      return window.before.then(() => {});
    },
    after(agentId: string, turnId: string | null, cwd: string): Promise<void> {
      const id = key(agentId, turnId);
      const window = windows.get(id);
      if (!window) {
        windows.set(id, { agentId, workspace: null, cwd, before: Promise.resolve({ kind: "error" }), overlap: false, ended: true, result: unavailable() });
        return Promise.resolve();
      }
      if (window.finishing) return window.finishing;
      if (window.ended) return Promise.resolve();
      window.finishing = (async () => {
        try {
          const before = await window.before;
          const after = await capture(cwd);
          let result: Result;
          if (before.kind === "not-git" || after.kind === "not-git") result = { files: [], message: NOT_GIT, warning: window.overlap ? OVERLAP_WARNING : null, incomplete: true };
          else if (before.kind !== "ok" || after.kind !== "ok" || cwd !== window.cwd || window.invalid) result = { ...unavailable(), warning: window.overlap ? OVERLAP_WARNING : null };
          else {
            const paths = new Set([...before.files.keys(), ...after.files.keys()]);
            const message = before.head !== after.head ? "Git HEAD changed during this period; the status difference may be incomplete." : null;
            result = { files: [...paths].filter(path => before.files.get(path) !== after.files.get(path)).sort(), message, warning: window.overlap ? OVERLAP_WARNING : null, incomplete: message !== null };
          }
          window.result = result;
        } catch { window.result = { ...unavailable(), warning: window.overlap ? OVERLAP_WARNING : null }; }
        finally { window.ended = true; }
      })();
      return window.finishing;
    },
    async get(agentId: string, turnId: string): Promise<Result | null> {
      const window = windows.get(key(agentId, turnId));
      if (!window) return null;
      await window.finishing;
      return window.result ?? unavailable();
    },
  };
}

export function registerTurnWindows(server: PluginServerContext, capture?: (cwd: string) => Promise<Snapshot>) {
  const windows = createTurnWindows(capture);
  if (typeof server.addHook !== "function") return { windows, dispose: () => {} };
  const before = server.addHook("agent.turn.before", async event => { await windows.before(event.agent.id, event.turnId, event.agent.workspaceId, event.agent.cwd); });
  const after = server.addHook("agent.turn.after", async (event, context) => {
    await windows.after(event.agent.id, event.turnId, event.agent.cwd);
    const result = await windows.get(event.agent.id, event.turnId ?? "");
    if (!result || !event.turnId) return;
    if (!context?.paseo) return;
    try {
      await context.paseo.agents.ref(event.agent.id).timeline.append({
        type: "plugin", id: `turn-window:${event.turnId}`, kind: "turn-window", version: 1,
        data: result as unknown as import("@getpaseo/protocol/agent-types").JsonValue,
      });
    } catch { /* never break a turn */ }
  });
  return { windows, dispose: () => { before(); after(); } };
}
