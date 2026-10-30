const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { manifestVersion } = require("../scripts/manifest-version.cjs");

const root = path.resolve(__dirname, "..");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), "clear-chat-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ["package.json", "package-lock.json", "paseo-plugin.json"]) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const file of ["install.cjs", "manifest-version.cjs"]) {
    fs.copyFileSync(path.join(root, "scripts", file), path.join(dir, "scripts", file));
  }
  const modules = path.join(dir, "node_modules");
  for (const name of ["@shikijs/core", "@shikijs/engine-javascript", "@shikijs/langs", "@shikijs/themes", "@getpaseo/plugin", "zod", "@shikijs/langs/typescript", "@shikijs/themes/github-dark-default", "@shikijs/themes/github-light-default"]) {
    const file = path.join(modules, name, "index.js");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "module.exports = {};\n");
  }
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), "#!/bin/sh\nexit \"${FAKE_NPM_STATUS:-0}\"\n", { mode: 0o755 });
  return dir;
}

function setVersion(dir, version) {
  const pkgFile = path.join(dir, "package.json"), lockFile = path.join(dir, "package-lock.json");
  const pkg = read(pkgFile), lock = read(lockFile);
  pkg.version = lock.version = lock.packages[""].version = version;
  write(pkgFile, pkg); write(lockFile, lock);
}

function build(dir, env = {}) {
  const command = read(path.join(dir, "paseo-plugin.json")).build;
  assert.deepEqual(command, [["node", "scripts/install.cjs"]]);
  return spawnSync(process.execPath, command[0].slice(1), {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`, ...env },
  });
}

test("managed build automatically generates both descriptions from the package version", async t => {
  for (const version of ["1.2.3.4", "10.20.30.40"]) {
    await t.test(version, t => {
      const dir = fixture(t), manifestFile = path.join(dir, "paseo-plugin.json");
      const original = read(manifestFile);
      setVersion(dir, version);
      const result = build(dir);
      const manifest = read(manifestFile);
      for (const [actual, before] of [[manifest.description, original.description], [manifest.translations["zh-CN"].description, original.translations["zh-CN"].description]]) {
        assert.equal(actual, `v${version} · ${before.replace(/^v\d+(?:\.\d+){3} · /, "")}`, "build must automatically generate the version prefix and preserve wording");
      }
      assert.equal(result.status, 0, result.stderr);
    });
  }
});

test("a stale prefix in either description is regenerated", async t => {
  for (const locale of ["default", "zh-CN"]) {
    await t.test(locale, t => {
      const dir = fixture(t), file = path.join(dir, "paseo-plugin.json");
      const manifest = read(file), entry = locale === "default" ? manifest : manifest.translations[locale];
      entry.description = entry.description.replace("v0.14.0.2", "v1.2.3.4");
      write(file, manifest);
      const result = build(dir);
      assert.equal(result.status, 0, result.stderr);
      const updated = read(file), actual = locale === "default" ? updated : updated.translations[locale];
      assert.equal(actual.description, entry.description.replace("v1.2.3.4", "v0.14.0.2"));
    });
  }
});

test("the committed release metadata is consistent", () => manifestVersion(root));

test("invalid metadata fails the install build before dependency installation", async t => {
  for (const problem of ["missing package version", "invalid version", "lock mismatch", "root lock mismatch", "malformed lock", "missing default", "missing translation", "empty description", "missing prefix", "malformed default prefix", "malformed translation prefix", "ambiguous prefix", "ambiguous translation prefix"]) {
    await t.test(problem, t => {
      const dir = fixture(t), pkgFile = path.join(dir, "package.json"), lockFile = path.join(dir, "package-lock.json"), manifestFile = path.join(dir, "paseo-plugin.json");
      const pkg = read(pkgFile), lock = read(lockFile), manifest = read(manifestFile);
      if (problem === "missing package version") delete pkg.version;
      if (problem === "invalid version") pkg.version = "0.14.0";
      if (problem === "lock mismatch") lock.version = "1.2.3.4";
      if (problem === "root lock mismatch") lock.packages[""].version = "1.2.3.4";
      if (problem === "missing default") delete manifest.description;
      if (problem === "missing translation") delete manifest.translations["zh-CN"].description;
      if (problem === "empty description") manifest.description = " ";
      if (problem === "missing prefix") manifest.description = "wording without a prefix";
      if (problem === "malformed default prefix") manifest.description = "v1.2.3 · wording";
      if (problem === "malformed translation prefix") manifest.translations["zh-CN"].description = "v01.2.3.4 · wording";
      if (problem === "ambiguous prefix") manifest.description = "v1.2.3.4 · v2.3.4.5 · wording";
      if (problem === "ambiguous translation prefix") manifest.translations["zh-CN"].description = "v1.2.3.4 · v2.3.4.5 · wording";
      write(pkgFile, pkg); write(lockFile, lock); write(manifestFile, manifest);
      if (problem === "malformed lock") fs.writeFileSync(lockFile, "{");
      const before = fs.readFileSync(manifestFile, "utf8");
      const result = build(dir, { FAKE_NPM_STATUS: "42" });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /manifest version check failed/);
      assert.equal(fs.readFileSync(manifestFile, "utf8"), before);
    });
  }
});

test("dependency and manifest write failures fail the build", async t => {
  await t.test("dependency installation", t => {
    const dir = fixture(t), file = path.join(dir, "paseo-plugin.json");
    setVersion(dir, "1.2.3.4");
    const before = fs.readFileSync(file, "utf8"), result = build(dir, { FAKE_NPM_STATUS: "42" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dependencies could not be installed/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
  await t.test("manifest write", t => {
    const dir = fixture(t), file = path.join(dir, "paseo-plugin.json"), preload = path.join(dir, "fail-write.cjs");
    setVersion(dir, "1.2.3.4");
    fs.writeFileSync(preload, 'const fs = require("node:fs"); const original = fs.writeFileSync; fs.writeFileSync = (file, ...args) => { if (String(file).endsWith("paseo-plugin.json")) throw new Error("simulated write failure"); return original(file, ...args); };\n');
    const before = fs.readFileSync(file, "utf8"), result = build(dir, { NODE_OPTIONS: `--require=${preload}` });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manifest version check failed.*simulated write failure/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
  await t.test("missing dependency", t => {
    const dir = fixture(t), file = path.join(dir, "paseo-plugin.json");
    setVersion(dir, "1.2.3.4");
    fs.rmSync(path.join(dir, "node_modules", "zod"), { recursive: true });
    const before = fs.readFileSync(file, "utf8"), result = build(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not find zod/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
  await t.test("metadata changed by dependency installation", t => {
    const dir = fixture(t), file = path.join(dir, "paseo-plugin.json");
    setVersion(dir, "1.2.3.4");
    fs.writeFileSync(path.join(dir, "bin", "npm"), "#!/bin/sh\nprintf '{' > package-lock.json\n", { mode: 0o755 });
    const before = fs.readFileSync(file, "utf8"), result = build(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manifest version check failed/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});
