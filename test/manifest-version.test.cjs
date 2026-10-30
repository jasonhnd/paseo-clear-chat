const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { manifestVersion } = require("../scripts/manifest-version.cjs");

const root = path.resolve(__dirname, "..");
const read = file => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

function physicalPath(file) {
  const suffix = [];
  while (!fs.existsSync(file)) {
    const parent = path.dirname(file);
    if (parent === file) break;
    suffix.unshift(path.basename(file));
    file = parent;
  }
  return path.join(fs.realpathSync(file), ...suffix);
}

function isolatedEnv(dir) {
  const home = path.join(dir, "home");
  const env = {
    PATH: [path.join(dir, "bin"), path.join(dir, "fallback")].join(path.delimiter),
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata"),
    TMP: path.join(home, "tmp"), TEMP: path.join(home, "tmp"), TMPDIR: path.join(home, "tmp"),
    npm_config_userconfig: path.join(home, ".npmrc"), npm_config_globalconfig: path.join(home, "global.npmrc"), npm_config_cache: path.join(home, "cache"),
  };
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
    assert.ok(systemRoot, "Windows SystemRoot is required to start cmd.exe");
    env.SystemRoot = systemRoot;
    env.ComSpec = path.join(systemRoot, "System32", "cmd.exe");
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
    env.HOMEDRIVE = path.parse(home).root.slice(0, 2);
    env.HOMEPATH = home.slice(env.HOMEDRIVE.length);
  }
  return env;
}

function resolution(dir) {
  const script = `const Module = require("node:module");
const requireFromInstaller = Module.createRequire(process.argv[1]);
let resolved = null;
try { resolved = requireFromInstaller.resolve("zod"); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; }
console.log(JSON.stringify({ resolved, paths: requireFromInstaller.resolve.paths("zod"), globals: Module.globalPaths, nodePathSet: Object.hasOwn(process.env, "NODE_PATH") }));`;
  const result = spawnSync(process.execPath, ["-e", script, path.join(dir, "scripts", "install.cjs")], { cwd: dir, encoding: "utf8", env: isolatedEnv(dir) });
  assert.equal(result.status, 0, "isolated resolution probe must succeed");
  return JSON.parse(result.stdout);
}

function assertMissingResolution(dir) {
  const probe = resolution(dir), checkout = fs.realpathSync(root);
  assert.equal(probe.nodePathSet, false, "NODE_PATH must be unset in the probe");
  assert.ok(probe.paths.includes(path.join(dir, "node_modules")), "fixture node_modules must be searched");
  assert.ok(probe.globals.every(p => probe.paths.includes(p)), "all Node global paths must be searched");
  assert.ok(probe.paths.every(p => !isWithin(checkout, physicalPath(p))), "Node search paths must not enter the checkout");
  assert.ok(probe.resolved === null, "absent fixture zod must not resolve from ancestors or global paths");
  console.log(`resolution platform=${process.platform}; fixture realpath outside checkout=true; NODE_PATH=unset; fixture search=true; checkout search=false; search paths checked=${probe.paths.length}; global paths checked=${probe.globals.length}; absent zod=MODULE_NOT_FOUND`);
}

function assertPresentResolution(dir) {
  const probe = resolution(dir), expected = path.join(dir, "node_modules", "zod", "index.js");
  assert.ok(probe.resolved && fs.realpathSync(probe.resolved) === fs.realpathSync(expected), "zod must resolve to the exact fixture module");
  console.log("resolution present zod=fixture/node_modules/zod/index.js; exact realpath=true");
}

function fixture(t, base = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(base, "clear-chat-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.ok(!isWithin(fs.realpathSync(root), fs.realpathSync(dir)), "fixture physical realpath must be outside the checkout");
  for (const file of ["package.json", "package-lock.json", "paseo-plugin.json"]) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  fs.mkdirSync(path.join(dir, "scripts"));
  for (const file of ["install.cjs", "manifest-version.cjs"]) {
    fs.copyFileSync(path.join(root, "scripts", file), path.join(dir, "scripts", file));
  }
  const bin = path.join(dir, "bin"), home = path.join(dir, "home");
  for (const name of [bin, home, path.join(dir, "fallback"), path.join(home, "appdata"), path.join(home, "localappdata"), path.join(home, "tmp")]) fs.mkdirSync(name, { recursive: true });
  assertMissingResolution(dir);
  const modules = path.join(dir, "node_modules");
  for (const name of ["@shikijs/core", "@shikijs/engine-javascript", "@shikijs/langs", "@shikijs/themes", "@getpaseo/plugin", "zod", "@shikijs/langs/typescript", "@shikijs/themes/github-dark-default", "@shikijs/themes/github-light-default"]) {
    const file = path.join(modules, name, "index.js");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "module.exports = {};\n");
  }
  assertPresentResolution(dir);
  // The installer still requests npm/npm.cmd; the preload confines that request
  // to this verified fixture executable, including when it cannot be started.
  const fake = fakePath(dir);
  const runner = path.join(dir, "fake-npm.cjs");
  fs.writeFileSync(runner, String.raw`const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_MARKER, JSON.stringify({ executable: process.argv[2], args: process.argv.slice(3) }) + "\n");
if (process.env.FAKE_NPM_MODE === "corrupt") fs.writeFileSync("package-lock.json", "{");
process.exit(Number(process.env.FAKE_NPM_STATUS || 0));
`);
  const fakeContent = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${runner}" "${fake}" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${runner}" "${fake}" "$@"\n`;
  fs.writeFileSync(fake, fakeContent, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "fake.sha256"), crypto.createHash("sha256").update(fakeContent).digest("hex"));
  const guard = path.join(dir, "guard.cjs");
  fs.writeFileSync(guard, String.raw`
const fs = require("node:fs"), crypto = require("node:crypto"), child = require("node:child_process");
const original = child.spawnSync;
child.spawnSync = (command, args, options) => {
  const expected = process.platform === "win32" ? "npm.cmd" : "npm";
  const record = { command, args, shell: !!options.shell, executable: process.env.FAKE_PATH };
  try {
    if (command !== expected || JSON.stringify(args) !== JSON.stringify(["ci", "--include=dev"]) || !!options.shell !== (process.platform === "win32")) throw new Error("unexpected installer invocation");
    const stat = fs.lstatSync(process.env.FAKE_PATH);
    if (!stat.isFile() || (process.platform !== "win32" && !(stat.mode & 0o111))) throw new Error("fake is not executable");
    const digest = crypto.createHash("sha256").update(fs.readFileSync(process.env.FAKE_PATH)).digest("hex");
    if (digest !== process.env.FAKE_HASH) throw new Error("fake content changed");
  } catch (error) {
    record.rejected = true;
    fs.appendFileSync(process.env.GUARD_MARKER, JSON.stringify(record) + "\n");
    return { error: new Error("fixture npm rejected: " + error.message) };
  }
  record.rejected = false;
  fs.appendFileSync(process.env.GUARD_MARKER, JSON.stringify(record) + "\n");
  if (process.env.FAKE_NPM_MODE === "vanish") fs.unlinkSync(process.env.FAKE_PATH);
  return original(process.platform === "win32" ? '"' + process.env.FAKE_PATH + '"' : process.env.FAKE_PATH, args, options);
};
`);
  return dir;
}

function fakePath(dir) {
  return path.join(dir, "bin", process.platform === "win32" ? "npm.cmd" : "npm");
}

function markers(dir, name) {
  const file = path.join(dir, name + ".jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse) : [];
}

function assertInvocation(dir, expected = "run") {
  const guard = markers(dir, "guard"), fake = markers(dir, "fake");
  if (expected === "none") {
    assert.deepEqual(guard, []);
    assert.deepEqual(fake, []);
    console.log("fake npm markers: guard=0; executed=0");
    return;
  }
  assert.deepEqual(guard, [{ command: process.platform === "win32" ? "npm.cmd" : "npm", args: ["ci", "--include=dev"], shell: process.platform === "win32", executable: fakePath(dir), rejected: expected === "rejected" }]);
  assert.deepEqual(fake, expected === "run" ? [{ executable: fakePath(dir), args: ["ci", "--include=dev"] }] : []);
  console.log(`fake npm markers: guard=1; rejected=${expected === "rejected"}; executed=${fake.length}; args=ci,--include=dev`);
}

function clearMarkers(dir) {
  for (const name of ["guard", "fake"]) fs.rmSync(path.join(dir, name + ".jsonl"), { force: true });
}

function setVersion(dir, version) {
  const pkgFile = path.join(dir, "package.json"), lockFile = path.join(dir, "package-lock.json");
  const pkg = read(pkgFile), lock = read(lockFile);
  pkg.version = lock.version = lock.packages[""].version = version;
  write(pkgFile, pkg); write(lockFile, lock);
}

function build(dir, extra = {}) {
  const command = read(path.join(dir, "paseo-plugin.json")).build;
  assert.deepEqual(command, [["node", "scripts/install.cjs"]]);
  const fake = fakePath(dir);
  // The expected digest is saved before any fault is injected.
  const hashFile = path.join(dir, "fake.sha256");
  const env = {
    ...isolatedEnv(dir),
    FAKE_PATH: fake, FAKE_HASH: fs.readFileSync(hashFile, "utf8"), FAKE_MARKER: path.join(dir, "fake.jsonl"), GUARD_MARKER: path.join(dir, "guard.jsonl"),
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(dir, "guard.cjs"))}` + (extra.preload ? ` --require=${JSON.stringify(extra.preload)}` : ""),
  };
  if (extra.status) env.FAKE_NPM_STATUS = extra.status;
  if (extra.mode) env.FAKE_NPM_MODE = extra.mode;
  return spawnSync(process.execPath, command[0].slice(1), { cwd: dir, encoding: "utf8", env });
}

test("managed build automatically generates both descriptions from the package version", async t => {
  for (const version of ["1.2.3.4", "10.20.30.40"]) {
    await t.test(version, t => {
      const dir = fixture(t), manifestFile = path.join(dir, "paseo-plugin.json");
      const original = read(manifestFile);
      setVersion(dir, version);
      const result = build(dir);
      assertInvocation(dir);
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
      assertInvocation(dir);
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
      const result = build(dir, { status: "42" });
      assertInvocation(dir, "none");
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
    const before = fs.readFileSync(file, "utf8"), result = build(dir, { status: "42" });
    assertInvocation(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dependencies could not be installed/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
  await t.test("manifest write", t => {
    const dir = fixture(t), file = path.join(dir, "paseo-plugin.json"), preload = path.join(dir, "fail-write.cjs");
    setVersion(dir, "1.2.3.4");
    fs.writeFileSync(preload, 'const fs = require("node:fs"); const original = fs.writeFileSync; fs.writeFileSync = (file, ...args) => { if (String(file).endsWith("paseo-plugin.json")) throw new Error("simulated write failure"); return original(file, ...args); };\n');
    const before = fs.readFileSync(file, "utf8"), result = build(dir, { preload });
    assertInvocation(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manifest version check failed.*simulated write failure/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
  await t.test("missing dependency", t => {
    const dir = fixture(t), file = path.join(dir, "paseo-plugin.json");
    setVersion(dir, "1.2.3.4");
    fs.rmSync(path.join(dir, "node_modules", "zod"), { recursive: true });
    assertMissingResolution(dir);
    const before = fs.readFileSync(file, "utf8"), result = build(dir);
    assertInvocation(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not find zod/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
    console.log("installer missing zod: exit=1; missing dependency reported; manifest unchanged");
  });
  await t.test("metadata changed by dependency installation", t => {
    const dir = fixture(t), file = path.join(dir, "paseo-plugin.json");
    setVersion(dir, "1.2.3.4");
    const before = fs.readFileSync(file, "utf8"), result = build(dir, { mode: "corrupt" });
    assertInvocation(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manifest version check failed/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("unusable fake cannot fall back and restoration succeeds", t => {
  const dir = fixture(t), fake = fakePath(dir);
  setVersion(dir, "1.2.3.4");
  const fakeContent = fs.readFileSync(fake);
  // Verify the normal fake before injecting faults.
  const positive = build(dir);
  assert.equal(positive.status, 0, positive.stderr);
  assertInvocation(dir);
  console.log("installer fixture zod present: exit=0");
  clearMarkers(dir);
  // The sentinel is a harmless controlled fallback, never a user or system npm.
  const sentinel = path.join(dir, "sentinel.jsonl"), fallback = path.join(dir, "fallback", path.basename(fake));
  const fallbackRunner = path.join(dir, "fallback.cjs");
  fs.writeFileSync(fallbackRunner, `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "fallback ran");\n`);
  fs.writeFileSync(fallback, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${fallbackRunner}"\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${fallbackRunner}"\n`, { mode: 0o755 });
  const relevant = ["package.json", "package-lock.json", "paseo-plugin.json"].map(name => path.join(dir, name));
  const before = relevant.map(name => fs.readFileSync(name));
  let failed;
  for (const fault of ["missing", "malformed", "vanish"]) {
    if (fault === "missing") fs.rmSync(fake);
    if (fault === "malformed") fs.writeFileSync(fake, "not the fixture executable", { mode: 0o755 });
    const result = build(dir, fault === "vanish" ? { mode: "vanish" } : {});
    failed = result;
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /dependencies could not be installed/);
    if (fault !== "vanish") assert.match(result.stderr, /fixture npm rejected/);
    assertInvocation(dir, fault === "vanish" ? "not-started" : "rejected");
    assert.equal(fs.existsSync(sentinel), false);
    assert.deepEqual(relevant.map(name => fs.readFileSync(name)), before);
    console.log(`safety ${fault}: sentinel absent; fixture bytes unchanged`);
    fs.writeFileSync(fake, fakeContent, { mode: 0o755 });
    clearMarkers(dir);
    const restored = build(dir);
    assert.equal(restored.status, 0, restored.stderr);
    assertInvocation(dir);
    assert.equal(fs.existsSync(sentinel), false);
    assert.deepEqual(relevant.map(name => fs.readFileSync(name)), before);
    console.log(`restored after ${fault}: sentinel absent; fixture bytes unchanged`);
    clearMarkers(dir);
  }
  if (process.env.CLEAR_CHAT_TEST_NEGATIVE_CONTROL === "1") {
    assert.equal(failed.status, 0, "intentional safety control: unusable fake must not report build success");
  }
});

test("controlled ancestor dependency violates the isolation boundary", t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "clear-chat-boundary-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dependency = path.join(parent, "node_modules", "zod", "index.js");
  fs.mkdirSync(path.dirname(dependency), { recursive: true });
  fs.writeFileSync(dependency, "module.exports = {};\n");
  assert.throws(() => fixture(t, parent), {
    code: "ERR_ASSERTION",
    message: "absent fixture zod must not resolve from ancestors or global paths",
  });
});
