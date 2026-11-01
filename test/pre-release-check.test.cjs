const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const legacy = [0, 13, 2, 2].join(".");
const current = [8, 1, 0, 2].join(".");
const prior = [8, 1, 0, 1].join(".");
const readmes = ["README.md", "README.zh-CN.md", "README.ja.md"];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-chat-release-check-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(root, "scripts/pre-release-check.cjs"), path.join(dir, "scripts/pre-release-check.cjs"));
  const write = (name, value) => fs.writeFileSync(path.join(dir, name), value);
  write("package.json", JSON.stringify({ version: current }));
  write("package-lock.json", JSON.stringify({ version: current, packages: { "": { version: current } } }));
  write("paseo-plugin.json", JSON.stringify({ description: `v${current} · fixture`, translations: { example: { description: `v${current} · fixture` } } }));
  write("CHANGELOG.md", `## [8.1.0.3]\n## [${current}]\n## [${prior}]\n## [${legacy}]\n`);
  for (const name of readmes) {
    const lines = fs.readFileSync(path.join(root, name), "utf8").split("\n").filter(line => line.includes(legacy));
    assert.equal(lines.length, 4);
    write(name, lines.join("\n") + "\n");
  }
  for (const name of ["OVERVIEW.md", "OVERVIEW.zh-CN.md"]) write(name, "fixture\n");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  for (const name of ["npm", "npx"]) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { dir, write };
}

function run(dir, args = []) {
  return spawnSync(process.execPath, [path.join(dir, "scripts/pre-release-check.cjs"), ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: path.join(dir, "bin") + path.delimiter + process.env.PATH },
  });
}

test("default scan selects the two releases older than the package and permits documented compatibility lines", t => {
  const { dir, write } = fixture(t);
  const clean = run(dir);
  assert.match(clean.stdout, new RegExp(`Searching for: "${prior.replaceAll(".", "\\.")}", "${legacy.replaceAll(".", "\\.")}"`));
  assert.equal(clean.status, 0, clean.stderr);
  write("stale.txt", `stale ${prior}\n`);
  const stale = run(dir);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /FAIL stale version scan: stale\.txt:1:/);
});

test("explicit scan permits only the exact compatibility lines in their README files", t => {
  const { dir, write } = fixture(t);
  const clean = run(dir, [legacy]);
  assert.equal(clean.status, 0, clean.stderr);
  for (const name of readmes) {
    const original = fs.readFileSync(path.join(dir, name), "utf8");
    write(name, original + `stale ${legacy}\n`);
    const stale = run(dir, [legacy]);
    assert.equal(stale.status, 1, name);
    assert.ok(stale.stderr.includes(`FAIL stale version scan: ${name}:5:`), stale.stderr);
    write(name, original + original.split("\n")[1] + "\n");
    const duplicate = run(dir, [legacy]);
    assert.equal(duplicate.status, 1, name);
    assert.ok(duplicate.stderr.includes(`FAIL stale version scan: ${name}:5:`), duplicate.stderr);
    write(name, original);
  }
  write("stale.txt", fs.readFileSync(path.join(dir, readmes[0]), "utf8").split("\n")[0] + "\n");
  const copied = run(dir, [legacy]);
  assert.equal(copied.status, 1);
  assert.match(copied.stderr, /FAIL stale version scan: stale\.txt:1:/);
});
