const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { manifestVersion } = require("../scripts/manifest-version.cjs");

const root = path.resolve(__dirname, "..");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

function fixture(t) {
  const tempRoot = path.join(root, ".tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, "manifest-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ["package.json", "package-lock.json", "paseo-plugin.json"]) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const file of ["install.cjs", "manifest-version.cjs"]) {
    fs.copyFileSync(path.join(root, "scripts", file), path.join(dir, "scripts", file));
  }
  return dir;
}

function setVersion(dir, version) {
  const pkgFile = path.join(dir, "package.json"), lockFile = path.join(dir, "package-lock.json");
  const pkg = read(pkgFile), lock = read(lockFile);
  pkg.version = lock.version = lock.packages[""].version = version;
  write(pkgFile, pkg); write(lockFile, lock);
}

test("release generation and installed build use the same four-part package version for both descriptions", t => {
  const dir = fixture(t);
  const { install } = require(path.join(dir, "scripts/install.cjs"));
  const installOptions = { run: () => ({ status: 0 }), resolveDependency: () => {}, report: message => assert.fail(message) };
  const original = read(path.join(dir, "paseo-plugin.json"));
  for (const version of ["1.2.3.4", "10.20.30.40"]) {
    setVersion(dir, version);
    manifestVersion(dir, { write: true });
    assert.equal(install(installOptions), 0);
    const pkg = read(path.join(dir, "package.json"));
    const manifest = read(path.join(dir, "paseo-plugin.json"));
    for (const [actual, before] of [[manifest.description, original.description], [manifest.translations["zh-CN"].description, original.translations["zh-CN"].description]]) {
      assert.equal(actual, `v${pkg.version} · ${before.replace(/^v\d+(?:\.\d+){3} · /, "")}`);
    }
  }
});

test("the committed release metadata is consistent", () => manifestVersion(root));

test("missing or mismatched versions and descriptions fail the install build", async t => {
  for (const problem of ["missing package version", "invalid version", "lock mismatch", "root lock mismatch", "normal mismatch", "translation mismatch", "missing translation"]) {
    await t.test(problem, t => {
      const dir = fixture(t), pkgFile = path.join(dir, "package.json"), lockFile = path.join(dir, "package-lock.json"), manifestFile = path.join(dir, "paseo-plugin.json");
      const pkg = read(pkgFile), lock = read(lockFile), manifest = read(manifestFile);
      if (problem === "missing package version") delete pkg.version;
      if (problem === "invalid version") pkg.version = "0.14.0";
      if (problem === "lock mismatch") lock.version = "1.2.3.4";
      if (problem === "root lock mismatch") lock.packages[""].version = "1.2.3.4";
      if (problem === "normal mismatch") manifest.description = manifest.description.replace("0.14.0.2", "1.2.3.4");
      if (problem === "translation mismatch") manifest.translations["zh-CN"].description = manifest.translations["zh-CN"].description.replace("0.14.0.2", "1.2.3.4");
      if (problem === "missing translation") delete manifest.translations["zh-CN"].description;
      write(pkgFile, pkg); write(lockFile, lock); write(manifestFile, manifest);
      const messages = [];
      const status = require(path.join(dir, "scripts/install.cjs")).install({ run: () => assert.fail("npm must not run"), report: message => messages.push(message) });
      assert.equal(status, 1);
      assert.match(messages.join("\n"), /manifest version check failed/);
    });
  }
});
