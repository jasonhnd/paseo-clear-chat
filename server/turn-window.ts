import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PluginServerContext } from "@getpaseo/plugin/server";

export const OVERLAP_WARNING = "Other conversations were running in this workspace during this period, so these changes may not all belong to this turn.";
export const NOT_GIT = "This workspace is not a Git repository; changes cannot be shown yet.";
export const INCOMPLETE = "Snapshot timing or overlap with other conversations may be incomplete.";
export const MAX_DIFF_BYTES = 12 * 1024;
export const MAX_DIFF_FILES = 40;
export const MAX_TOTAL_DIFF_BYTES = 96 * 1024;
export const DIFF_TRUNCATED_MARKER = "... [diff truncated]";
export const NO_TEXT_DIFF = "untracked or no textual diff in Git";
export const DIFF_OMITTED_FILE_LIMIT = "diff omitted (file limit)";
export const DIFF_OMITTED_TOTAL_LIMIT = "diff omitted (total size limit)";

export type FileLineStats = {
  added: number | null;
  deleted: number | null;
  binary: boolean;
  renamedFrom: string | null;
  diff: string | null;
  truncated: boolean;
  note: string | null;
};
type Snapshot = { kind: "ok"; files: Map<string, string>; root?: string; head?: string | null } | { kind: "not-git" | "error" };
type Result = { files: string[]; details: Record<string, FileLineStats>; message: string | null; warning: string | null; incomplete: boolean; messageCode?: string | null; warningCode?: string | null };
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
    return { kind: "ok", files, root, head };
  } catch { return { kind: "error" }; }
}

/** Split a worktree-vs-index patch into one text block per file. */
function patchChunks(patch: string): { header: string; text: string }[] {
  const chunks: { header: string; text: string }[] = [];
  let lines: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (lines.length) chunks.push({ header: lines[0] ?? "", text: lines.join("\n") });
      lines = [line];
    } else if (lines.length) lines.push(line);
  }
  if (lines.length) chunks.push({ header: lines[0] ?? "", text: lines.join("\n") });
  return chunks;
}

/** Read `added`/`deleted` and the rename source out of one --numstat line's path field. */
export function parseNumstatPath(raw: string): { path: string; renamedFrom: string | null } {
  const brace = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return { path: `${brace[1] ?? ""}${brace[3] ?? ""}${brace[4] ?? ""}`, renamedFrom: `${brace[1] ?? ""}${brace[2] ?? ""}${brace[4] ?? ""}` };
  const arrow = raw.match(/^(.*) => (.*)$/);
  if (arrow) return { path: arrow[2] ?? "", renamedFrom: arrow[1] ?? null };
  return { path: raw, renamedFrom: null };
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  return text.slice(0, end);
}

function emptyStats(): FileLineStats {
  return { added: null, deleted: null, binary: false, renamedFrom: null, diff: null, truncated: false, note: null };
}

/** Per-file line counts and a bounded, read-only worktree diff for the given paths. */
export async function collectFileDetails(cwd: string, paths: string[], execute: typeof git = git): Promise<Record<string, FileLineStats>> {
  const details: Record<string, FileLineStats> = {};
  if (!paths.length) return details;
  const included = paths.slice(0, MAX_DIFF_FILES);
  const stats = new Map<string, FileLineStats>(included.map(path => [path, emptyStats()]));
  let numstat = "";
  let patch = "";
  try {
    numstat = (await execute(cwd, ["-c", "core.quotePath=false", "diff", "HEAD", "--numstat", "-M", "--no-color", "--no-ext-diff", "--", ...included])).toString();
  } catch { numstat = ""; }
  try {
    patch = (await execute(cwd, ["-c", "core.quotePath=false", "diff", "HEAD", "-M", "--no-color", "--no-ext-diff", "--", ...included])).toString();
  } catch { patch = ""; }
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addedText, deletedText, ...rest] = parts;
    const { path, renamedFrom } = parseNumstatPath(rest.join("\t"));
    const target = stats.get(path) ?? (renamedFrom ? stats.get(renamedFrom) : undefined);
    if (!target) continue;
    if (addedText === "-" && deletedText === "-") {
      target.binary = true;
      target.note = "binary file";
    } else {
      target.added = Number(addedText);
      target.deleted = Number(deletedText);
    }
    if (renamedFrom) {
      target.renamedFrom = renamedFrom;
      const source = stats.get(renamedFrom);
      if (source && !source.note) source.note = `renamed to ${path}`;
    }
  }
  let total = 0;
  for (const chunk of patchChunks(patch)) {
    const destination = included
      .filter(candidate => chunk.header.includes(`b/${candidate}`) || chunk.text.includes(`+++ b/${candidate}`))
      .sort((a, b) => b.length - a.length)[0];
    const path = destination ?? included
      .filter(candidate => chunk.header.includes(`a/${candidate}`))
      .sort((a, b) => b.length - a.length)[0];
    if (!path) continue;
    const target = stats.get(path);
    if (!target) continue;
    if (target.binary && !target.note) target.note = "binary file";
    const size = Buffer.byteLength(chunk.text, "utf8");
    if (total + size > MAX_TOTAL_DIFF_BYTES && total >= MAX_TOTAL_DIFF_BYTES) {
      target.note = target.note ? `${target.note}; ${DIFF_OMITTED_TOTAL_LIMIT}` : DIFF_OMITTED_TOTAL_LIMIT;
      continue;
    }
    if (size > MAX_DIFF_BYTES || total + size > MAX_TOTAL_DIFF_BYTES) {
      const budget = Math.max(0, Math.min(MAX_DIFF_BYTES, MAX_TOTAL_DIFF_BYTES - total));
      target.diff = `${truncateUtf8(chunk.text, budget)}\n${DIFF_TRUNCATED_MARKER}`;
      target.truncated = true;
      target.note = target.note ? `${target.note}; diff truncated` : "diff truncated";
    } else {
      target.diff = chunk.text;
    }
    total += Buffer.byteLength(target.diff ?? "", "utf8");
  }
  for (const path of paths.slice(MAX_DIFF_FILES)) {
    details[path] = { ...emptyStats(), note: DIFF_OMITTED_FILE_LIMIT };
  }
  for (const path of included) {
    const item = stats.get(path) ?? emptyStats();
    if (item.added === null && item.deleted === null && !item.binary && !item.renamedFrom && !item.note) item.note = NO_TEXT_DIFF;
    details[path] = item;
  }
  return details;
}

export function createTurnWindows(capture: (cwd: string) => Promise<Snapshot> = snapshot, execute: typeof git = git) {
  const windows = new Map<string, Window>();
  const key = (agentId: string, turnId: string | null) => JSON.stringify([agentId, turnId]);
  const unavailable = (): Result => ({ files: [], details: {}, message: INCOMPLETE, warning: null, incomplete: true, messageCode: "turnIncomplete" });
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
    after(agentId: string, turnId: string | null, cwd: string, outcomeKind?: "completed" | "failed" | "canceled"): Promise<void> {
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
          if (before.kind === "not-git" || after.kind === "not-git") result = { files: [], details: {}, message: NOT_GIT, warning: window.overlap ? OVERLAP_WARNING : null, incomplete: true, messageCode: "turnNotGit", warningCode: window.overlap ? "turnOverlap" : null };
          else if (before.kind !== "ok" || after.kind !== "ok" || cwd !== window.cwd || window.invalid) result = { ...unavailable(), warning: window.overlap ? OVERLAP_WARNING : null, warningCode: window.overlap ? "turnOverlap" : null };
          else {
            const paths = new Set([...before.files.keys(), ...after.files.keys()]);
            const headChanged = before.head !== after.head;
            const interrupted = outcomeKind === "failed" || outcomeKind === "canceled";
            const message = headChanged ? "Git HEAD changed during this period; the status difference may be incomplete."
              : interrupted ? "The turn ended before it completed; the observed change set may be incomplete." : null;
            const files = [...paths].filter(path => before.files.get(path) !== after.files.get(path)).sort();
            const details = await collectFileDetails(before.root ?? cwd, files, execute);
            result = { files, details, message, warning: window.overlap ? OVERLAP_WARNING : null, incomplete: headChanged || interrupted, messageCode: headChanged ? "turnHeadChanged" : interrupted ? "turnInterrupted" : null, warningCode: window.overlap ? "turnOverlap" : null };
          }
          window.result = result;
        } catch { window.result = { ...unavailable(), warning: window.overlap ? OVERLAP_WARNING : null, warningCode: window.overlap ? "turnOverlap" : null }; }
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

export function registerTurnWindows(server: PluginServerContext, capture?: (cwd: string) => Promise<Snapshot>, execute?: typeof git) {
  const windows = createTurnWindows(capture, execute);
  if (typeof server.addHook !== "function") return { windows, dispose: () => {} };
  const before = server.addHook("agent.turn.before", async event => { await windows.before(event.agent.id, event.turnId, event.agent.workspaceId, event.agent.cwd); });
  const after = server.addHook("agent.turn.after", async (event, context) => {
    await windows.after(event.agent.id, event.turnId, event.agent.cwd, event.outcome?.kind);
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
