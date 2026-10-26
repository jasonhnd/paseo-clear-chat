import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";

// Contract and protocol error responses match ACP SDK v1.4.0:
// https://github.com/agentclientprotocol/typescript-sdk/blob/v1.4.0/src/stream.ts
// https://github.com/agentclientprotocol/typescript-sdk/blob/v1.4.0/src/jsonrpc.ts
export function ndJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
): AcpStream {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  let writes = Promise.resolve();
  let cancelled = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  // Parse-error replies and application messages share the same output lock.
  function writeJson(message: unknown): Promise<void> {
    const bytes = encoder.encode(JSON.stringify(message) + "\n");
    const next = writes.then(async () => {
      const writer = output.getWriter();
      try { await writer.write(bytes); } finally { writer.releaseLock(); }
    });
    writes = next.catch(() => {});
    return next;
  }

  return {
    writable: new WritableStream<AcpStreamMessage>({ write: writeJson }),
    readable: new ReadableStream<AcpStreamMessage>({
      async start(controller) {
        const inputReader = input.getReader();
        reader = inputReader;
        let pending = "";
        async function consumeLine(line: string) {
          line = line.trim();
          if (!line) return;
          let message: unknown;
          try { message = JSON.parse(line); } catch {
            await writeJson({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
            return;
          }
          if (typeof message === "object" && message !== null) {
            controller.enqueue(message as AcpStreamMessage);
          } else {
            await writeJson({ jsonrpc: "2.0", id: null,
              error: { code: -32600, message: "Invalid request", data: message } });
          }
        }
        try {
          while (!cancelled) {
            const { value, done } = await inputReader.read();
            if (cancelled) return;
            if (done) {
              await consumeLine(pending + decoder.decode());
              break;
            }
            pending += decoder.decode(value, { stream: true });
            const lines = pending.split("\n");
            pending = lines.pop()!;
            for (const line of lines) {
              await consumeLine(line);
              if (cancelled) return;
            }
          }
          if (!cancelled) controller.close();
        } catch (error) {
          if (!cancelled) controller.error(error);
        } finally {
          reader = undefined;
          inputReader.releaseLock();
        }
      },
      cancel(reason) {
        cancelled = true;
        return reader?.cancel(reason);
      },
    }),
  };
}
