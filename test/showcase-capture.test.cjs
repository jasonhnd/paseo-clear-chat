const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createCapturePlan, readmeV2Groups, demoCapture, heroCapture } = require("../.showcase/capture-plan.cjs");

const root = resolve(__dirname, "..");
const readme = file => readFileSync(resolve(root, file), "utf8");
const files = plan => plan.flatMap(group => [group.light, group.dark]).sort();

test("published capture planning routes theme pairs to their documented directories", () => {
  const plan = createCapturePlan('<img src="images/compare-light.png"><source srcset="images/compare-dark.png">'
    + '<source srcset="docs/images/tool-read-dark.png"><img src="docs/images/tool-read-light.png">');
  assert.deepEqual(plan, [
    { id: "compare", light: "images/compare-light.png", dark: "images/compare-dark.png" },
    { id: "tool-read", dark: "docs/images/tool-read-dark.png", light: "docs/images/tool-read-light.png" },
  ]);
  assert.throws(() => createCapturePlan("No screenshots"), /no screenshot references/);
  assert.throws(() => createCapturePlan('<img src="docs/images/tool-read-light.png">'), /Missing screenshot theme/);
  assert.throws(() => createCapturePlan('<img src="images/tool-read-light.png">'), /Unexpected screenshot location/);
});

test("all README languages retain matching published pairs alongside the separate v2 inventory", () => {
  const expected = files(createCapturePlan(readme("README.md")));
  assert.equal(expected.length, 36);
  for (const file of ["README.md", "README.zh-CN.md", "README.ja.md"]) {
    const content = readme(file);
    assert.deepEqual(files(createCapturePlan(content)), expected);
    const pictures = [...content.matchAll(/<picture>([\s\S]*?)<\/picture>/g)];
    assert.equal(pictures.filter(match => match[1].includes("docs/images/")).length, 17);
    for (const [, picture] of pictures) {
      const dark = picture.match(/<source media="\(prefers-color-scheme: dark\)" srcset="([^"]+-dark\.png)">/);
      const light = picture.match(/<img[^>]+src="([^"]+-light\.png)">/);
      assert.ok(dark && light, `${file} has a light fallback and a dark source`);
      assert.equal(dark[1].replace(/-dark\.png$/, ""), light[1].replace(/-light\.png$/, ""));
    }
  }
  const actual = ["images", "docs/images"].flatMap(directory =>
    readdirSync(resolve(root, directory)).map(file => `${directory}/${file}`)).sort();
  assert.deepEqual(actual, [...new Set([...expected, ...files(readmeV2Groups), demoCapture.light])].sort());
});

test("v2 stills retain the required filenames, viewport sizes, and pixel densities", () => {
  for (const group of readmeV2Groups) {
    for (const theme of ["light", "dark"]) {
      const png = readFileSync(resolve(root, group[theme]));
      assert.equal(png.readUInt32BE(0), 0x89504e47);
      assert.equal(png.readUInt32BE(16), group.viewport.width * group.deviceScaleFactor, group[theme]);
      assert.equal(png.readUInt32BE(20), group.viewport.height * group.deviceScaleFactor, group[theme]);
    }
  }
  const gif = readFileSync(resolve(root, demoCapture.light));
  assert.equal(gif.subarray(0, 3).toString(), "GIF");
  assert.equal(gif.readUInt16LE(6), 1200);
  assert.ok(gif.length <= 10_000_000);
});

test("the hero uses default text size and uniform page scaling inside the 2000px composition", () => {
  const hero = readmeV2Groups.find(group => group.id === "hero");
  const { desktop, phone, marginX, marginY, gap } = heroCapture;
  assert.equal(hero.viewport.width, 2000);
  assert.equal(marginX, 48);
  assert.equal(marginY, 48);
  assert.equal(gap, 48);
  assert.equal(desktop.displayWidth + phone.displayWidth + gap + 2 * marginX, hero.viewport.width);
  assert.equal(desktop.deviceScaleFactor, phone.deviceScaleFactor);
  for (const device of [desktop, phone]) {
    assert.equal(device.textScale, 1);
    assert.ok(device.deviceScaleFactor > 1);
    const atReadmeWidth = device.displayWidth / device.width * 800 / hero.viewport.width;
    // At these real compact viewports the authored label is 11px; code is 12px.
    for (const authoredSize of [11, 12]) assert.ok(authoredSize * atReadmeWidth >= 11 && authoredSize * atReadmeWidth <= 12.1);
  }
  const contentHeight = desktop.height * desktop.displayWidth / desktop.width;
  assert.equal(Math.ceil(contentHeight + 2 * marginY), hero.viewport.height);
});

test("the synthetic read, edit, test output, and final reply describe the same change", () => {
  const ts = require("typescript");
  const { runInNewContext } = require("node:vm");
  const compiled = ts.transpileModule(readme(".showcase/fixtures.ts"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports });
  const { BEFORE_CODE, CODE, DIFF, EDIT_PATCH, EDIT_RESULT, CALLS, DEMO_STEPS, TEST_OUTPUT, REPLY } = exports;
  assert.equal(CALLS.read.code, BEFORE_CODE);
  assert.ok(BEFORE_CODE.includes('return "Shipping calculated at checkout";'));
  assert.ok(!BEFORE_CODE.includes("total >= 50"));
  const diffLines = DIFF.split("\n").slice(1);
  assert.equal(diffLines.filter(line => !line.startsWith("+")).map(line => line.slice(1)).join("\n"), BEFORE_CODE);
  assert.equal(diffLines.filter(line => !line.startsWith("-")).map(line => line.slice(1)).join("\n"), CODE);
  assert.equal(CALLS.edit.input, EDIT_PATCH);
  assert.ok(EDIT_PATCH.startsWith("*** Begin Patch\n*** Update File: src/cart.ts\n@@\n"));
  const patchLines = EDIT_PATCH.split("\n").slice(3, -1);
  assert.equal(patchLines.filter(line => !line.startsWith("+")).map(line => line.slice(1)).join("\n"), BEFORE_CODE);
  assert.equal(patchLines.filter(line => !line.startsWith("-")).map(line => line.slice(1)).join("\n"), CODE);
  assert.equal(CALLS.edit.copyResult, EDIT_RESULT);
  assert.equal(EDIT_RESULT, "Success. Updated the following files:\nM src/cart.ts");
  assert.equal(CALLS.edit.diff, DIFF);
  assert.equal(DEMO_STEPS.length, 6);
  assert.ok(new Set(DEMO_STEPS.map(step => step.durationMs)).size >= 5);
  assert.ok(DEMO_STEPS.every(step => step.durationMs > 0));
  for (const total of ["$49.99", "$50", "$50.01"]) {
    assert.ok(TEST_OUTPUT.split("\n").some(line => line.includes("PASS") && line.includes(total)));
  }
  assert.equal(TEST_OUTPUT.split("\n").filter(line => line.startsWith("   PASS")).length, 12);
  assert.ok(TEST_OUTPUT.endsWith("12 tests passed"));
  assert.ok(REPLY.includes("Ready to review") && REPLY.includes("12 tests passed"));
});
