const assert = require("node:assert/strict");
const { readFileSync, readdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { test } = require("node:test");
const { createCapturePlan } = require("../.showcase/capture-plan.cjs");

const root = resolve(__dirname, "..");
const readme = file => readFileSync(resolve(root, file), "utf8");
const files = plan => plan.flatMap(group => [group.light, group.dark]).sort();

test("capture planning follows published references and routes both themes to their documented directories", () => {
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

test("all README languages publish the same theme pairs and every retained screenshot is referenced", () => {
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
  assert.deepEqual(actual, expected);
});
