const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..");
const readJson = file => JSON.parse(readFileSync(file, "utf8"));
const target = "0.13.0";

test("the installed SDK and protocol peers match the development SDK contract", () => {
  const manifest = readJson(join(root, "package.json"));
  const lock = readJson(join(root, "package-lock.json"));
  const sdk = readJson(join(dirname(require.resolve("@getpaseo/plugin")), "..", "package.json"));
  assert.equal(manifest.devDependencies["@getpaseo/plugin"], target);
  assert.equal(sdk.version, target);
  for (const name of ["@getpaseo/plugin", "@getpaseo/client", "@getpaseo/protocol"]) {
    const installed = readJson(join(root, "node_modules", name, "package.json"));
    assert.equal(installed.version, target, `${name}: installed version`);
    assert.equal(lock.packages[`node_modules/${name}`].version, target, `${name}: locked version`);
  }
});

test("installation requires Paseo 0.14 or later", () => {
  const manifest = readJson(join(root, "paseo-plugin.json"));
  assert.equal(manifest.requirements.paseo, ">=0.14.0");
});
