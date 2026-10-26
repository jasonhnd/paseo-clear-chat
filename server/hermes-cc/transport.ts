import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname } from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import type { AcpStream } from "@getpaseo/plugin/server/acp";
import { ndJsonStream } from "./ndjson";

/** The SDK's command adapter has no spawn cwd option (connection.ts:412-416). */
export async function hermesCcTransport(
  command: readonly [string, ...string[]],
  env: Record<string, string>,
  cwd?: string,
): Promise<AcpStream> {
  // Paseo v0.13.0 acp-agent.ts:2864-2872 keeps the session's original cwd in
  // session/load but spawns archived history from home if that directory is gone.
  const processCwd = cwd && await stat(cwd).then(entry => entry.isDirectory(), () => false) ? cwd : homedir();
  // Match SDK process.ts Windows command-script handling and argument quoting.
  const shell = process.platform === "win32" && (!extname(command[0]) || /\.(cmd|bat)$/i.test(command[0]));
  const argv = shell ? command.map(quoteWindowsArgument) : [...command];
  const child = spawn(argv[0]!, argv.slice(1), { cwd: processCwd, env, shell, windowsHide: true, stdio: "pipe" });
  child.stderr.resume();
  // Observe spawn errors before handing streams to the SDK; close owns the child.
  await once(child, "spawn");
  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const reader = stream.readable.getReader();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    await reader.cancel().catch(() => undefined);
    child.stdin.destroy();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once("close", () => resolve()));
    // Windows command scripts run behind cmd.exe; terminate its whole tree,
    // matching SDK process.ts:100-118.
    if (process.platform === "win32" && child.pid !== undefined) {
      await promisify(execFile)("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
      await exited;
      return;
    }
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
    try { await exited; } finally { clearTimeout(timer); }
  })();
  return {
    readable: new ReadableStream({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) { controller.error(error); }
      },
      cancel: close,
    }),
    writable: new WritableStream({
      async write(message) {
        const writer = stream.writable.getWriter();
        try { await writer.write(message); } finally { writer.releaseLock(); }
      },
      close,
      abort: close,
    }),
  };
}

// Paseo SDK v0.13.0 process-internal/windows-command.ts:11-32.
function quoteWindowsArgument(value: string): string {
  const quoted = value.startsWith('"') && value.endsWith('"');
  const raw = quoted ? value.slice(1, -1) : value;
  const escaped = raw.replace(/([&|^<>()!])/g, "^$1");
  if (!quoted && !/[\s"]/u.test(raw)) return escaped;
  return `"${escaped.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`)
    .replace(/\\+$/u, slashes => `${slashes}${slashes}`)}"`;
}
