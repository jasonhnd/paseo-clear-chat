"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

// Record only scroll sampling. Exclude screenshots, DOM snapshots and network
// bodies; traces can still contain private URLs, so keep them in local temp storage.
async function traceScroll(cdp, filename, sample) {
  if (!filename) return sample();
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const file = await fs.open(filename, "w", 0o600);
  let started = false;
  let stream;
  try {
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,v8.execute,disabled-by-default-v8.cpu_profiler",
      transferMode: "ReturnAsStream",
    });
    started = true;
    try {
      return await sample();
    } finally {
      const complete = new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
      await cdp.send("Tracing.end");
      stream = (await complete).stream;
      if (!stream) throw new Error("Chrome did not return a trace stream");
      let chunk;
      do {
        chunk = await cdp.send("IO.read", { handle: stream });
        await file.writeFile(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
      } while (!chunk.eof);
    }
  } catch (error) {
    await fs.unlink(filename).catch(() => {});
    throw error;
  } finally {
    if (stream) await cdp.send("IO.close", { handle: stream });
    await file.close();
    if (!started) await fs.unlink(filename).catch(() => {});
  }
}

module.exports = { traceScroll };
