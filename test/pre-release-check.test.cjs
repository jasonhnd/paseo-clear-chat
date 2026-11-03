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
  write("CHANGELOG.md", `## [${current}]\n## [${prior}]\n## [${legacy}]\n`);
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

test("first changelog version heading must match the release metadata", t => {
  const { dir, write } = fixture(t);
  for (const heading of ["8.1.0.3", prior]) {
    write("CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n## [${heading}] - 2026-11-04\n## [${current}]\n## [${prior}]\n## [${legacy}]\n`);
    const result = run(dir, [legacy]);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.stderr.split("\n").filter(line => line.startsWith("FAIL version consistency")),
      [`FAIL version consistency: CHANGELOG.md:5: version heading "${heading}" differs from package.json:1 version "${current}"`]);
  }
  write("CHANGELOG.md", `# Changelog\n\n## [Unreleased]\n\n## [${current}] - 2026-11-04\n## [${prior}]\n## [${legacy}]\n`);
  const matching = run(dir);
  assert.equal(matching.status, 0, matching.stderr);
  assert.match(matching.stdout, /PASS all pre-release checks/);

  write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n");
  const missing = run(dir, [legacy]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /FAIL version consistency: CHANGELOG\.md:1: cannot find a version heading/);
});

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

test("latest release compare reference permits its previous version without hiding unrelated stale strings", t => {
  const { dir, write } = fixture(t);
  write("CHANGELOG.md", `## [${current}]\n## [${prior}]\n## [${legacy}]\n\n[${current}]: https://example.com/compare/v${prior}...v${current}\n`);
  const clean = run(dir);
  assert.equal(clean.status, 0, clean.stderr);

  write("stale.txt", `stale ${prior}\n`);
  const stale = run(dir);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /FAIL stale version scan: stale\.txt:1:/);
  assert.doesNotMatch(stale.stderr, /FAIL stale version scan: CHANGELOG\.md:/);
});

test("stale reference definitions before historical sections are reported", t => {
  const { dir, write } = fixture(t);
  write("CHANGELOG.md", `[other]: https://example.com/v${prior}\n## [${current}]\n## [${prior}]\n## [${legacy}]\n`);
  const result = run(dir);
  assert.match(result.stderr, /FAIL stale version scan: CHANGELOG\.md:1:/, "reports the stale non-matching reference definition");
  assert.equal(result.status, 1);
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

test("release date checks only the current changelog heading", t => {
  const { dir, write } = fixture(t);
  for (const marker of ["Unreleased", "未发布", "未公開"]) {
    write("CHANGELOG.md", `## [${current}] - ${marker}\n## [${prior}] - ${marker}\n## [${legacy}]\n`);
    const result = run(dir);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.stderr.split("\n").filter(line => line.startsWith("FAIL")),
      [`FAIL release date: CHANGELOG.md:1: found "${marker}"`]);
  }
  write("CHANGELOG.md", `## [${current}] - 2026-11-03\nUnreleased work is described here.\n## [${prior}] - Unreleased\n## [${legacy}]\n`);
  const dated = run(dir);
  assert.equal(dated.status, 0, dated.stderr);
  assert.match(dated.stdout, /PASS release date/);
});

test("optional release notes report unreleased markers with their file and line", t => {
  const { dir, write } = fixture(t);
  for (const marker of ["Unreleased", "未发布", "未公開"]) {
    write("release-notes.md", `# Release\nRelease date: **${marker}**\n`);
    const result = run(dir, ["--release-notes", "release-notes.md", prior]);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.stderr.split("\n").filter(line => line.startsWith("FAIL")),
      [`FAIL release date: release-notes.md:2: found "${marker}"`]);
    assert.ok(result.stdout.includes(`Searching for: "${prior}"`));
  }
  write("release-notes.md", "# Release\nRelease date: **2026-11-03**\n");
  const dated = run(dir, ["--release-notes", "release-notes.md"]);
  assert.equal(dated.status, 0, dated.stderr);
  const missing = run(dir, ["--release-notes", "missing.md"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /FAIL release date: missing\.md:1:/);
  const noArgument = run(dir, ["--release-notes"]);
  assert.equal(noArgument.status, 1);
  assert.match(noArgument.stderr, /FAIL release date: scripts\/pre-release-check\.cjs:1:/);
});
