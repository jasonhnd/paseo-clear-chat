const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const root = resolve(__dirname, "..");
const privateError = new Error("Sensitive host details\n    at internal/file.js:12:3");
const settle = () => new Promise(setImmediate);

test("the install build uses a dependency installer that reports a safe failure", () => {
  const { install } = require("../scripts/install.cjs");
  const manifest = JSON.parse(readFileSync(resolve(root, "paseo-plugin.json"), "utf8"));
  assert.deepEqual(manifest.build, [["node", "scripts/install.cjs"]]);
  assert.ok(manifest.requirements.paseo);
  for (const result of [{ status: 1 }, { status: null, signal: "SIGTERM" }]) {
    const errors = [];
    const status = install({ run: () => result, report: text => errors.push(text) });
    assert.equal(status, 1);
    assert.match(errors.join(""), /dependencies could not be installed/);
    assert.match(errors.join(""), /Node.js and npm.*network.*retry.*Paseo CLI/i);
    assert.doesNotMatch(errors.join(""), /Sensitive|internal\/file|\n\s+at /);
  }
});

function installFailure(result) {
  const errors = [];
  const status = require("../scripts/install.cjs").install({
    run: () => { if (result instanceof Error) throw result; return result; },
    report: text => errors.push(text),
  });
  assert.equal(status, 1);
  assert.match(errors.join("\n"), /dependencies could not be installed/);
  return errors.join("\n");
}

test("npm failure appends the last 20 stderr lines instead of stdout", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `npm error line ${i}`);
  const message = installFailure({ status: 1, stderr: lines.join("\n") + "\n", stdout: "ignored stdout" });
  assert.ok(message.endsWith(lines.slice(-20).join("\n")));
  assert.doesNotMatch(message, /npm error line 9\b|ignored stdout/);
});

test("npm failure falls back to stdout when stderr is empty", () => {
  const message = installFailure({ status: 1, stderr: "", stdout: "npm stdout diagnostic" });
  assert.ok(message.endsWith("npm stdout diagnostic"));
});

// Derived compatibility fixture: docs/STEP-DETAIL-FIELDS.md documents explicit
// streams in a projected shell item's detail.output; no capture has these cases.
const installOutput = require("./fixtures/install-output.json").detail.output;

test("npm failure falls back to stdout when stderr is whitespace only", () => {
  const message = installFailure({ status: 1, ...installOutput });
  assert.ok(message.endsWith(installOutput.stdout));
});

test("npm maxBuffer failure reports too much output and retains the captured tail", () => {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(process.argv[1].repeat(100000))", installOutput.stdout + "\n"], {
    encoding: "utf8", maxBuffer: 1024,
  });
  assert.equal(result.error?.code, "ENOBUFS");
  assert.ok(result.stdout.length > 1024);
  const message = installFailure(result);
  assert.match(message, /npm failed.*too much output/i);
  assert.doesNotMatch(message, /npm could not start/i);
  assert.ok(message.endsWith(result.stdout.trimEnd().split(/\r?\n/).slice(-20).join("\n").slice(-4000)));
});

test("npm failure bounds very long output and marks truncation", () => {
  const message = installFailure({ status: 1, stderr: "discarded prefix" + "x".repeat(10000) + "final diagnostic" });
  assert.match(message, /\(truncated\)/);
  assert.ok(message.endsWith("final diagnostic"));
  assert.ok(message.length < 4400);
  assert.doesNotMatch(message, /discarded prefix/);
});

test("npm failure strips ANSI colours from output", () => {
  const message = installFailure({ status: 1, stderr: "\x1b[31mnpm error\x1b[0m: broken" });
  assert.ok(message.endsWith("npm error: broken"));
  assert.doesNotMatch(message, /\x1b/);
});

test("npm spawn errors explain that npm could not start without a stack trace", () => {
  for (const result of [{ status: null, error: new Error("spawn npm ENOENT") }, new Error("spawn npm EACCES")]) {
    const message = installFailure(result);
    assert.match(message, /npm could not start/i);
    assert.match(message, /spawn npm (ENOENT|EACCES)/);
    assert.doesNotMatch(message, /\n\s+at /);
  }
});

test("missing Shiki packages name the dependency and explain how to repair it", () => {
  const { install } = require("../scripts/install.cjs");
  for (const missing of ["@shikijs/core", "@shikijs/engine-javascript", "@shikijs/langs/typescript", "@shikijs/themes/github-dark-default", "@getpaseo/plugin", "zod"]) {
    const errors = [];
    const status = install({
      run: () => ({ status: 0 }),
      resolveDependency: name => { if (name === missing) throw privateError; },
      report: text => errors.push(text),
    });
    assert.equal(status, 1);
    assert.ok(errors.join("").includes(missing));
    assert.match(errors.join(""), /npm ci --include=dev.*retry.*Paseo CLI/i);
    assert.doesNotMatch(errors.join(""), /Sensitive|internal\/file/);
  }
});

test("successful installation includes development dependencies and prints no warning", () => {
  const { install } = require("../scripts/install.cjs");
  const calls = [], errors = [];
  assert.equal(install({ run: (...args) => { calls.push(args); return { status: 0 }; }, resolveDependency() {}, report: value => errors.push(value) }), 0);
  assert.deepEqual(calls[0].slice(0, 2), [process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--include=dev"]]);
  assert.deepEqual(errors, []);
});

for (const entry of ["index.server.ts", "index.client.tsx"]) {
  test(`${entry} explains missing host capabilities before startup`, () => {
    const h = createToolHarness();
    assert.throws(() => h.load(entry).default({}), error => {
      assert.match(error.message, /Paseo.*plugin.*support/i);
      assert.match(error.message, /Update Paseo.*reload Clear Chat/i);
      assert.doesNotMatch(error.message, /is not a function|Sensitive/);
      return true;
    });
  });
}

test("server registration failure hides host details and offers recovery", () => {
  const h = createToolHarness();
  assert.throws(() => h.load("index.server.ts").default({ registerSettings() { throw privateError; }, handle() {} }), error => {
    assert.match(error.message, /Clear Chat could not start/);
    assert.match(error.message, /reload.*reinstall/i);
    assert.doesNotMatch(error.message, /Sensitive|internal\/file/);
    return true;
  });
});

for (const platform of ["web", "ios", "android"]) {
  test(`${platform} settings read failure has a safe reason, recovery action and working retry`, async t => {
    let fails = true;
    const h = createToolHarness(platform, { settingsPage: true, presentationHost: { rpc: async () => {
      if (fails) throw privateError;
      return { status: "ready", revision: "0", values: { preferences: {}, legacyMigrated: true } };
    } } });
    t.after(() => h.unmount());
    await settle();
    const p = h.load("client/preferences.ts");
    assert.equal(p.areEnhancerPreferencesReady(), false);
    assert.match(p.getEnhancerPreferencesError(), /cannot read.*settings.*Reconnect.*Retry/i);
    assert.doesNotMatch(p.getEnhancerPreferencesError(), /Sensitive|internal\/file/);
    const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
    const render = () => h.draw({ type: Page, props: { theme: { colors: {} } } });
    const tree = render();
    assert.equal(h.nodes(tree, node => node.props.accessibilityRole === "alert").length, 1);
    const retry = h.nodes(tree, node => node.props.accessibilityRole === "button" && h.text(node) === "Retry")[0];
    assert.ok(retry);
    fails = false;
    await retry.props.onPress();
    assert.equal(p.areEnhancerPreferencesReady(), true);
    assert.equal(p.getEnhancerPreferencesError(), null);
    assert.equal(h.nodes(render(), node => node.props.accessibilityRole === "alert").length, 0);
  });
}

for (const result of [
  { status: "invalid", error: privateError.message },
  { status: "ready", revision: "0", values: { preferences: { accent: 123 } } },
]) {
  test("invalid settings explain backup and repair without exposing schema details", async () => {
    const h = createToolHarness("web", { presentationHost: { rpc: async () => result } });
    await settle();
    const p = h.load("client/preferences.ts");
    assert.equal(p.areEnhancerPreferencesReady(), false);
    assert.match(p.getEnhancerPreferencesError(), /settings.*invalid.*Back up.*restore.*Retry/i);
    assert.doesNotMatch(p.getEnhancerPreferencesError(), /Sensitive|internal\/file|ZodError/);
  });
}

test("healthy startup displays no diagnostic", async t => {
  const h = createToolHarness("web", { settingsPage: true, presentationHost: { rpc: async () => ({ status: "ready", revision: "0", values: { preferences: {}, legacyMigrated: true } }) } });
  t.after(() => h.unmount());
  await settle();
  const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
  assert.equal(h.nodes(h.draw({ type: Page, props: { theme: { colors: {} } } }), node => node.props.accessibilityRole === "alert").length, 0);
});
