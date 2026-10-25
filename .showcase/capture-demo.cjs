"use strict";

const { mkdirSync, writeFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");

/** Record the real components at 12 samples per second on a fixed 1200px stage.
 * The iframe is a browser viewport: narrowing it triggers the responsive panel.
 * No device emulation, cursor overlays, captions, network data or live host.
 */
async function captureDemo({ page, server, work, output, temp, errors, plan }) {
  const frames = join(work, "frames");
  mkdirSync(frames, { recursive: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.setViewportSize({ width: plan.width, height: plan.height });
  await page.route(`${origin}/?stage=1`, route => route.fulfill({
    contentType: "text/html", body: `<!doctype html><html lang="en"><title>Clear Chat demo</title>
      <body style="margin:0;background:#edf0f5;display:flex;justify-content:center;height:100vh;overflow:hidden">
      <iframe title="demo-shop conversation" src="/?demo=1&theme=light" style="width:1200px;height:800px;border:0;flex-shrink:0;box-shadow:0 0 0 1px #d5dbe5"></iframe></body></html>`,
  }));
  await page.goto(`${origin}/?stage=1`);
  const demo = page.frameLocator("iframe");
  await demo.getByTestId("demo").waitFor();
  const frame = page.frames().find(value => value.url().includes("demo=1"));
  await frame.evaluate(() => document.fonts.ready);
  const phase = value => frame.evaluate(value => window.dispatchEvent(new CustomEvent("demo-phase", { detail: value })), value);
  const scroll = () => demo.getByTestId("step-detail-scroll");
  const readingPosition = () => scroll().evaluate(node => {
    const top = node.getBoundingClientRect().top;
    const cells = [...node.querySelectorAll('[data-testid^="step-detail-cell-"]')];
    const cell = cells.find(cell => cell.getBoundingClientRect().top <= top && cell.getBoundingClientRect().bottom > top);
    return { key: cell?.getAttribute("data-testid"), offset: cell ? Math.round(top - cell.getBoundingClientRect().top) : 0, scrollTop: node.scrollTop };
  });
  const report = { fps: plan.fps, seconds: plan.seconds, frames: plan.fps * plan.seconds };
  let before;
  const started = Date.now();
  for (let index = 0; index < report.frames; index++) {
    if ([24, 48, 72, 96].includes(index)) await phase(index / 24);
    if (index === 108) {
      await demo.getByTestId("demo-step-3").getByRole("button").first().click();
      await demo.getByTestId("step-detail-panel").waitFor();
      assert.equal(await demo.getByTestId("step-detail-panel").getAttribute("data-presentation"), "side");
    }
    if (index >= 132 && index < 180) {
      // Small, fixed increments keep the long test output readable while moving.
      await scroll().evaluate(node => { node.scrollTop += 15; });
    }
    if (index === 192) before = await readingPosition();
    if (index >= 204 && index <= 228) {
      const width = Math.round(1200 - (1200 - 390) * (index - 204) / 24);
      await page.locator("iframe").evaluate((node, width) => { node.style.width = `${width}px`; }, width);
    }
    if (index === 240) {
      assert.equal(await demo.getByTestId("step-detail-panel").getAttribute("data-presentation"), "sheet");
      const after = await readingPosition();
      assert.equal(after.key, before.key, "The visible output chunk must survive the viewport change");
      assert.ok(Math.abs(after.offset - before.offset) <= 2, "The reading position must stay within two pixels");
      report.readingPosition = { before, after };
    }
    if (index === 264) {
      await demo.getByTestId("step-detail-close").click();
      await phase(5);
      await demo.getByTestId("demo-reply").waitFor();
      await demo.getByTestId("demo-chat").evaluate(node => { node.scrollTop = node.scrollHeight; });
    }
    // Fixed sampling deadlines; encoded frames always have exactly 1/fps duration.
    const remaining = started + index * 1000 / plan.fps - Date.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    const png = await page.screenshot({ path: join(frames, `${String(index).padStart(4, "0")}.png`), scale: "css" });
    if ([0, 36, 84, 102, 120, 192, 240, 300].includes(index)) writeFileSync(join(temp, `demo-review-${index}.png`), png);
  }
  if (errors.length) throw new Error(errors.join("\n"));
  const input = ["-framerate", String(plan.fps), "-i", join(frames, "%04d.png")];
  const evidence = join(homedir(), "evidence-cc-s2");
  mkdirSync(evidence, { recursive: true });
  execFileSync("ffmpeg", ["-y", ...input, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(evidence, "demo.mp4")], { stdio: "pipe" });
  execFileSync("ffmpeg", ["-y", ...input, "-vf", "palettegen=stats_mode=diff", "-frames:v", "1", join(work, "palette.png")], { stdio: "pipe" });
  const destination = join(output, plan.light);
  execFileSync("ffmpeg", ["-y", ...input, "-i", join(work, "palette.png"), "-lavfi", "paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", destination], { stdio: "pipe" });
  report.bytes = statSync(destination).size;
  assert.ok(report.bytes <= 10_000_000, "Demo GIF must be at most 10 MB");
  writeFileSync(join(temp, "demo-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`${plan.light}: ${report.bytes} bytes, ${plan.width}×${plan.height}, ${plan.seconds}s, ${plan.fps}fps`);
}

module.exports = { captureDemo };
