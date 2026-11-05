const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const current = [8, 1, 0, 2].join(".");
const next = [9, 2, 1, 3].join(".");
const metadata = ["package.json", "package-lock.json", "paseo-plugin.json"];
const documents = ["README.md", "README.zh-CN.md", "README.ja.md", "OVERVIEW.md", "OVERVIEW.zh-CN.md", "CHANGELOG.md"];

function fixture(t) {
  const base = path.join(root, ".tmp");
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, "bump-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(root, "scripts/bump-version.cjs"), path.join(dir, "scripts/bump-version.cjs"));
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), value);
  write("package.json", JSON.stringify({ name: "fixture", version: current }, null, 2) + "\n");
  write("package-lock.json", JSON.stringify({ version: current, packages: { "": { version: current }, dependency: { version: current } } }, null, 2) + "\n");
  write("paseo-plugin.json", JSON.stringify({ description: `v${current} · English`, translations: { example: { description: `v${current} · Translation` }, another: { description: `v${current} · Another` } } }, null, 2) + "\n");
  for (const name of documents) write(name, `Needs Paseo 0.14.0 or later.\n${name} Clear Chat ${current}\n`);
  write("CHANGELOG.md", `Needs Paseo 0.14.0 or later.\n## [${current}]\n[${current}]: https://example.com/v${current}\n`);
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, "scripts/bump-version.cjs"), ...args], { cwd: dir, encoding: "utf8" });
const read = (dir, name) => fs.readFileSync(path.join(dir, name), "utf8");
const snapshot = dir => [...metadata, ...documents].map(name => read(dir, name));

test("updates all metadata and reports every matching document line", t => {
  const dir = fixture(t), result = run(dir, next);
  assert.equal(result.status, 0, result.stderr);
  const pkg = JSON.parse(read(dir, metadata[0])), lock = JSON.parse(read(dir, metadata[1])), manifest = JSON.parse(read(dir, metadata[2]));
  assert.equal(pkg.version, next);
  assert.equal(lock.version, next);
  assert.equal(lock.packages[""].version, next);
  assert.equal(lock.packages.dependency.version, current);
  assert.equal(manifest.description, `v${next} · English`);
  assert.equal(manifest.translations.example.description, `v${next} · Translation`);
  assert.equal(manifest.translations.another.description, `v${next} · Another`);
  for (const name of documents) assert.ok(result.stdout.includes(`${name}:2:`), name);
  assert.ok(result.stdout.includes("CHANGELOG.md:3:"));
  assert.doesNotMatch(result.stdout, /Needs Paseo 0\.14\.0 or later/);
  for (const name of documents) assert.ok(read(dir, name).includes(current));
});

test("dry run produces the same report and leaves files byte-identical", t => {
  const dir = fixture(t), before = snapshot(dir);
  const dry = run(dir, next, "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(snapshot(dir), before);
  const actual = run(dir, next);
  assert.equal(actual.status, 0, actual.stderr);
  assert.equal(dry.stdout.replace(" (dry run)", ""), actual.stdout);
});

test("rejects bad arguments and the current version without writing", t => {
  const dir = fixture(t), before = snapshot(dir);
  for (const args of [[], ["1.2.3"], ["1.2.3.x"], ["01.2.3.4"], [next, "extra"], [next, "--dry-run", "--dry-run"], [current]]) {
    const result = run(dir, ...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.deepEqual(snapshot(dir), before);
  }
});

test("validates metadata and document shapes before any writes", async t => {
  for (const problem of ["lock mismatch", "root lock missing", "default prefix", "translation prefix", "translation shape", "manifest version", "missing document", "invalid JSON"]) {
    await t.test(problem, t => {
      const dir = fixture(t), lockFile = path.join(dir, metadata[1]), manifestFile = path.join(dir, metadata[2]);
      const lock = JSON.parse(read(dir, metadata[1])), manifest = JSON.parse(read(dir, metadata[2]));
      if (problem === "lock mismatch") lock.version = next;
      if (problem === "root lock missing") delete lock.packages[""];
      if (problem === "default prefix") manifest.description = "unexpected";
      if (problem === "translation prefix") manifest.translations.example.description = `v${next} · Translation`;
      if (problem === "translation shape") manifest.translations = [];
      if (problem === "manifest version") manifest.version = next;
      fs.writeFileSync(lockFile, JSON.stringify(lock));
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      if (problem === "missing document") fs.rmSync(path.join(dir, documents[0]));
      if (problem === "invalid JSON") fs.writeFileSync(lockFile, "{");
      const before = metadata.map(name => read(dir, name));
      assert.notEqual(run(dir, next).status, 0);
      assert.deepEqual(metadata.map(name => read(dir, name)), before);
    });
  }
});

test("updates an existing manifest version field", t => {
  const dir = fixture(t), file = path.join(dir, metadata[2]);
  const manifest = JSON.parse(read(dir, metadata[2]));
  manifest.version = current;
  fs.writeFileSync(file, JSON.stringify(manifest));
  const result = run(dir, next);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(read(dir, metadata[2])).version, next);
});
