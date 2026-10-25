"use strict";

const { mkdirSync, writeFileSync, statSync } = require("node:fs");
const { join } = require("node:path");
const { homedir } = require("node:os");
const { execFileSync } = require("node:child_process");
const assert = require("node:assert/strict");

/** Fixed 1200px stage; the iframe is the real responsive browser viewport. */
async function captureDemo({ page, origin, work, root, errors, plan, settle, verifyFonts }) {
  const frames = join(work, "frames");
  mkdirSync(frames, { recursive: true });
  await page.setViewportSize({ width: plan.width, height: plan.height });
  await page.route(`${origin}/stage`, route => route.fulfill({
    contentType: "text/html", body: `<!doctype html><html lang="en"><title>Clear Chat demo</title>
      <body style="margin:0;background:#edf0f5;display:flex;justify-content:center;height:100vh;overflow:hidden">
      <iframe title="demo-shop conversation" src="/?animate=1&theme=light" style="width:1200px;height:800px;border:0;flex-shrink:0;box-shadow:0 0 0 1px #d5dbe5"></iframe></body></html>`,
  }));
  await page.goto(`${origin}/stage`);
  const demo = page.frameLocator("iframe");
  await demo.getByTestId("demo").waitFor();
  const frame = page.frames().find(frame => frame.url().includes("animate=1"));
  await settle(frame);
  const phase = value => frame.evaluate(value => window.dispatchEvent(new CustomEvent("demo-phase", { detail: value })), value);
  const scroll = () => demo.getByTestId("step-detail-scroll");
  const readingPosition = () => scroll().evaluate(node => {
    const top = node.getBoundingClientRect().top;
    const cell = [...node.querySelectorAll('[data-testid^="step-detail-cell-"]')].find(cell => cell.getBoundingClientRect().top <= top && cell.getBoundingClientRect().bottom > top);
    return { key: cell?.getAttribute("data-testid"), offset: cell ? Math.round(top - cell.getBoundingClientRect().top) : 0, scrollTop: node.scrollTop };
  });
  const report = { fps: plan.fps, seconds: plan.seconds, frames: plan.fps * plan.seconds };
  let before;
  const started = Date.now();
  for (let index = 0; index < report.frames; index++) {
    // Run all six steps, showing each active card before it folds to one row.
    if ([6, 24, 42, 60, 78, 96, 108].includes(index)) await phase(index === 108 ? 6 : (index - 6) / 18);
    if (index === 114) {
      await demo.getByRole("button", { name: "View details: cart.ts · +3 −1" }).click();
      await page.mouse.move(2, 2);
      await settle(frame);
      assert.equal(await demo.getByTestId("step-detail-panel").getAttribute("data-presentation"), "side");
    }
    if (index === 144) {
      await demo.getByRole("button", { name: "View details: $ npm test" }).click();
      await page.mouse.move(2, 2);
      await settle(frame);
      assert.ok((await demo.getByTestId("step-detail-panel").innerText()).includes("$49.99"));
      report.fonts = await verifyFonts(page, frame.url());
    }
    if (index >= 156 && index < 192) await scroll().evaluate(node => { node.scrollTop += 7; });
    if (index === 198) {
      before = await readingPosition();
      assert.ok(before.scrollTop > 50 && before.key, "The test output must be scrolled before resizing");
    }
    // Cross both responsive breakpoints while the same output remains open.
    if (index >= 204 && index <= 228) {
      const width = Math.round(1200 - 810 * (index - 204) / 24);
      await page.locator("iframe").evaluate((node, width) => { node.style.width = `${width}px`; }, width);
    }
    if (index === 240) {
      assert.equal(await demo.getByTestId("step-detail-panel").getAttribute("data-presentation"), "sheet");
      const after = await readingPosition();
      assert.equal(after.key, before.key, `The visible output chunk must survive the viewport change: ${JSON.stringify({ before, after })}`);
      assert.ok(Math.abs(after.offset - before.offset) <= 2, `Reading position changed: ${JSON.stringify({ before, after })}`);
      report.readingPosition = { before, after };
    }
    if (index === 264) {
      await demo.getByTestId("step-detail-close").click();
      await demo.getByTestId("demo-chat").evaluate(node => { node.scrollTop = node.scrollHeight; });
      await demo.getByTestId("demo-reply").waitFor();
    }
    const remaining = started + index * 1000 / plan.fps - Date.now();
    if (remaining > 0) await new Promise(done => setTimeout(done, remaining));
    await page.screenshot({ path: join(frames, `${String(index).padStart(4, "0")}.png`), scale: "css" });
  }
  assert.deepEqual(errors, []);
  const input = ["-framerate", String(plan.fps), "-i", join(frames, "%04d.png")];
  const evidence = join(homedir(), "evidence-cc-s6");
  mkdirSync(evidence, { recursive: true });
  execFileSync("ffmpeg", ["-y", ...input, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(evidence, "demo.mp4")], { stdio: "pipe" });
  const destination = join(root, plan.light);
  execFileSync("ffmpeg", ["-y", ...input, "-filter_complex", "[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle", "-loop", "0", destination], { stdio: "pipe" });
  report.bytes = statSync(destination).size;
  assert.ok(report.bytes <= 10_000_000, "Demo GIF must be at most 10 MB");
  writeFileSync(join(work, "demo-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`${plan.light}: ${report.bytes} bytes, ${plan.width}×${plan.height}, ${plan.seconds}s, ${report.frames} frames`);
}
module.exports = { captureDemo };
