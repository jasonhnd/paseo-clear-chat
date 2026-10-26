const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const test = require("node:test");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

const LEGACY_PLUGIN_ID = "beautiful-chat";
const PLUGIN_ID = "clear-chat";
const oldRaw = JSON.stringify({
  version: 1,
  values: {
    preferences: { accent: "jade", textScale: 1.3, enhancedUserBubble: false },
    legacyMigrated: true,
  },
});

function fixture(t, { env = {}, fsOverrides = {} } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), "clear-chat-migration-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = new Map();
  const errors = [];
  const environment = { PASEO_HOME: root, ...env };
  function load(relative) {
    const filename = resolve(__dirname, "..", relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} };
    cache.set(filename, mod);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const realRequire = createRequire(filename);
    const localRequire = (id) => {
      if (id === "node:fs") return { ...fs, ...fsOverrides };
      if (id === "node:os") return { homedir: () => root };
      if (id.startsWith(".")) return load(resolve(dirname(filename), `${id}.ts`));
      return realRequire(id);
    };
    runInThisContext(`(function(require,module,exports,process,console){${compiled}\n})`, { filename })(
      localRequire, mod, mod.exports, { env: environment }, { error: (...args) => errors.push(args) },
    );
    return mod.exports;
  }
  function path(id, home = root) {
    return join(home, "plugin-settings", id, "presentation.json");
  }
  function seed(id, raw = oldRaw, home = root) {
    const filename = path(id, home);
    fs.mkdirSync(dirname(filename), { recursive: true });
    fs.writeFileSync(filename, raw);
    return filename;
  }
  return { root, load, path, seed, errors };
}

function assertMigrationError(h) {
  assert.equal(h.errors.length, 1);
  const [message, ...details] = h.errors[0];
  assert.equal(typeof message, "string");
  assert.match(message, /could not copy the Beautiful Chat settings.*back them up.*read and write access.*reload Clear Chat to retry/);
  assert.equal(message.includes(h.root), false, "Log must not expose private paths");
  assert.deepEqual(details, [], "Log must not include an error or stack trace");
}

test("host migration copies the SDK envelope and keeps the old settings", (t) => {
  const h = fixture(t);
  const old = h.seed(LEGACY_PLUGIN_ID);
  h.load("server/settings-migration.ts").migrateHostSettings();
  assert.equal(fs.readFileSync(h.path(PLUGIN_ID), "utf8"), oldRaw);
  assert.equal(fs.readFileSync(old, "utf8"), oldRaw);
  assert.equal(fs.statSync(h.path(PLUGIN_ID)).mode & 0o777, 0o600);
  // Editing the copy must not mutate a shared inode belonging to the old ID.
  fs.writeFileSync(h.path(PLUGIN_ID), "new choices");
  assert.equal(fs.readFileSync(old, "utf8"), oldRaw);
});

test("host migration preserves the legacy settings SHA256 and source bytes", (t) => {
  const h = fixture(t);
  const raw = Buffer.from(`${JSON.stringify(JSON.parse(oldRaw), null, 2).replace(/\n/g, "\r\n")}\r\n`);
  const source = h.seed(LEGACY_PLUGIN_ID, raw);
  const original = fs.readFileSync(source);
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const originalHash = sha256(original);

  h.load("server/settings-migration.ts").migrateHostSettings();

  assert.equal(sha256(fs.readFileSync(h.path(PLUGIN_ID))), originalHash);
  assert.equal(fs.existsSync(source), true);
  assert.deepEqual(fs.readFileSync(source), original);
  assert.deepEqual(h.errors, []);
});

test("presentation version one upgrades to version two preserving every existing value", async (t) => {
  const h = fixture(t);
  const values = {
    preferences: {
      accent: "violet",
      uiFont: "system",
      codeFont: "plain",
      textScale: 1.15,
      frostedGlass: false,
      pointerGlow: false,
      enhancedUserBubble: false,
      selectionActions: false,
      assistantMarkdown: false,
      markdownVariant: "terminal",
    },
    legacyMigrated: false,
  };
  const raw = JSON.stringify({ version: 1, values });
  const source = h.seed(LEGACY_PLUGIN_ID, raw);
  h.load("server/settings-migration.ts").migrateHostSettings();
  const envelope = JSON.parse(fs.readFileSync(h.path(PLUGIN_ID), "utf8"));
  const definition = h.load("shared/settings.ts").presentationSettings;

  assert.equal(envelope.version, 1);
  assert.equal(definition.id, "presentation");
  assert.equal(definition.version, 2);
  const migrated = definition.schema.parse(await definition.migrate(envelope.values, envelope.version));
  assert.deepEqual(migrated, values);
  assert.deepEqual(envelope.values, values);
  assert.equal(fs.readFileSync(source, "utf8"), raw);
});

for (const id of [LEGACY_PLUGIN_ID, PLUGIN_ID]) {
  test(`version one ${id} settings upgrade without changing existing choices`, async (t) => {
    const h = fixture(t);
    h.seed(id);
    h.load("server/settings-migration.ts").migrateHostSettings();
    const envelope = JSON.parse(fs.readFileSync(h.path(PLUGIN_ID), "utf8"));
    const definition = h.load("shared/settings.ts").presentationSettings;
    assert.equal(definition.version, 2);
    const migrated = definition.schema.parse(await definition.migrate(envelope.values, envelope.version));
    assert.deepEqual(migrated, envelope.values);
    assert.equal(migrated.preferences.enhancedUserBubble, false);
    assert.equal(migrated.preferences.textScale, 1.3);
    assert.equal(migrated.legacyMigrated, true);
  });
}

test("version two settings retain fold choices during schema migration", async (t) => {
  const h = fixture(t);
  const definition = h.load("shared/settings.ts").presentationSettings;
  const values = { preferences: { accent: "rose", foldFinishedSteps: false, foldLongOutputAfter: "never" }, legacyMigrated: true };
  assert.deepEqual(definition.schema.parse(await definition.migrate(values, 2)), values);
  assert.deepEqual(definition.schema.parse(await definition.migrate({}, 1)), { preferences: {}, legacyMigrated: false });
});

for (const current of [JSON.stringify({ version: 1, values: { preferences: { accent: "rose" } } }), ""]) {
  test(`host migration leaves an existing new document untouched (${current || "empty"})`, (t) => {
    const h = fixture(t);
    h.seed(LEGACY_PLUGIN_ID);
    h.seed(PLUGIN_ID, current);
    h.load("server/settings-migration.ts").migrateHostSettings();
    assert.equal(fs.readFileSync(h.path(PLUGIN_ID), "utf8"), current);
    assert.equal(fs.readFileSync(h.path(LEGACY_PLUGIN_ID), "utf8"), oldRaw);
  });
}

test("host migration with neither document leaves SDK defaults and no files", (t) => {
  const h = fixture(t);
  h.load("server/settings-migration.ts").migrateHostSettings();
  assert.equal(fs.existsSync(join(h.root, "plugin-settings")), false);
  assert.deepEqual(h.load("shared/settings.ts").presentationSettings.schema.parse({}), {
    preferences: {}, legacyMigrated: false,
  });
});

test("host migration is idempotent and does not reimport changed old settings", (t) => {
  const h = fixture(t);
  h.seed(LEGACY_PLUGIN_ID);
  const { migrateHostSettings } = h.load("server/settings-migration.ts");
  migrateHostSettings();
  h.seed(LEGACY_PLUGIN_ID, "changed legacy data");
  migrateHostSettings();
  assert.equal(fs.readFileSync(h.path(PLUGIN_ID), "utf8"), oldRaw);
  assert.equal(fs.readFileSync(h.path(LEGACY_PLUGIN_ID), "utf8"), "changed legacy data");
  assert.deepEqual(fs.readdirSync(dirname(h.path(PLUGIN_ID))), ["presentation.json"]);
});

test("host migration respects PASEO_HOME and does not use the default home", (t) => {
  const h = fixture(t);
  h.seed(LEGACY_PLUGIN_ID);
  h.seed(LEGACY_PLUGIN_ID, "default home data", join(h.root, ".paseo"));
  h.load("server/settings-migration.ts").migrateHostSettings();
  assert.equal(fs.readFileSync(h.path(PLUGIN_ID), "utf8"), oldRaw);
  assert.equal(fs.existsSync(h.path(PLUGIN_ID, join(h.root, ".paseo"))), false);
});

test("host migration defaults to the daemon user's .paseo directory", (t) => {
  const h = fixture(t, { env: { PASEO_HOME: undefined } });
  const home = join(h.root, ".paseo");
  h.seed(LEGACY_PLUGIN_ID, oldRaw, home);
  h.load("server/settings-migration.ts").migrateHostSettings();
  assert.equal(fs.readFileSync(h.path(PLUGIN_ID, home), "utf8"), oldRaw);
  assert.equal(fs.existsSync(h.path(PLUGIN_ID)), false);
});

test("host migration cannot overwrite a new document created during the copy", (t) => {
  const current = "concurrent new choices";
  const h = fixture(t, { fsOverrides: {
    linkSync(source, target) {
      fs.writeFileSync(target, current, { flag: "wx" });
      fs.linkSync(source, target);
    },
  } });
  h.seed(LEGACY_PLUGIN_ID);
  h.load("server/settings-migration.ts").migrateHostSettings();
  assert.equal(fs.readFileSync(h.path(PLUGIN_ID), "utf8"), current);
  assert.equal(fs.readFileSync(h.path(LEGACY_PLUGIN_ID), "utf8"), oldRaw);
  assert.deepEqual(fs.readdirSync(dirname(h.path(PLUGIN_ID))), ["presentation.json"]);
});

test("failed host migration keeps old data, removes temporary files and can retry", (t) => {
  let fail = true;
  const denied = Object.assign(new Error("Copy denied"), { code: "EACCES" });
  const h = fixture(t, { fsOverrides: {
    linkSync(source, target) {
      if (fail) throw denied;
      fs.linkSync(source, target);
    },
  } });
  h.seed(LEGACY_PLUGIN_ID);
  const { migrateHostSettings } = h.load("server/settings-migration.ts");
  assert.doesNotThrow(() => migrateHostSettings());
  assertMigrationError(h, denied);
  assert.equal(fs.existsSync(h.path(PLUGIN_ID)), false);
  assert.equal(fs.readFileSync(h.path(LEGACY_PLUGIN_ID), "utf8"), oldRaw);
  assert.deepEqual(fs.readdirSync(dirname(h.path(PLUGIN_ID))), []);
  fail = false;
  migrateHostSettings();
  assert.equal(fs.readFileSync(h.path(PLUGIN_ID), "utf8"), oldRaw);
});

test("unreadable host source is logged without deleting data and can retry", (t) => {
  let fail = true;
  const denied = Object.assign(new Error("Source unreadable"), { code: "EACCES" });
  const h = fixture(t, { fsOverrides: {
    readFileSync(...args) {
      if (fail) throw denied;
      return fs.readFileSync(...args);
    },
  } });
  const old = h.seed(LEGACY_PLUGIN_ID);
  const { migrateHostSettings } = h.load("server/settings-migration.ts");
  assert.doesNotThrow(() => migrateHostSettings());
  assertMigrationError(h, denied);
  assert.equal(fs.readFileSync(old, "utf8"), oldRaw);
  assert.equal(fs.existsSync(dirname(h.path(PLUGIN_ID))), false);
  fail = false;
  migrateHostSettings();
  assert.equal(fs.readFileSync(h.path(PLUGIN_ID), "utf8"), oldRaw);
});

test("a directory at the host source path is logged and left untouched", (t) => {
  const h = fixture(t);
  const old = h.path(LEGACY_PLUGIN_ID);
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(join(old, "keep"), "original contents");
  assert.doesNotThrow(() => h.load("server/settings-migration.ts").migrateHostSettings());
  assertMigrationError(h, "EISDIR");
  assert.equal(fs.readFileSync(join(old, "keep"), "utf8"), "original contents");
  assert.equal(fs.existsSync(dirname(h.path(PLUGIN_ID))), false);
});

test("a file at the host target directory is logged without deleting either file", (t) => {
  const h = fixture(t);
  const old = h.seed(LEGACY_PLUGIN_ID);
  const directory = dirname(h.path(PLUGIN_ID));
  fs.writeFileSync(directory, "keep target contents");
  assert.doesNotThrow(() => h.load("server/settings-migration.ts").migrateHostSettings());
  assertMigrationError(h, "ENOTDIR");
  assert.equal(fs.readFileSync(old, "utf8"), oldRaw);
  assert.equal(fs.readFileSync(directory, "utf8"), "keep target contents");
  assert.deepEqual(fs.readdirSync(dirname(directory)).sort(), [LEGACY_PLUGIN_ID, PLUGIN_ID].sort());
});

test("a failed target check preserves existing new and old settings", (t) => {
  const denied = Object.assign(new Error("Target inaccessible"), { code: "EACCES" });
  const h = fixture(t, { fsOverrides: { lstatSync() { throw denied; } } });
  const old = h.seed(LEGACY_PLUGIN_ID);
  const current = h.seed(PLUGIN_ID, "existing new choices");
  assert.doesNotThrow(() => h.load("server/settings-migration.ts").migrateHostSettings());
  assertMigrationError(h, denied);
  assert.equal(fs.readFileSync(old, "utf8"), oldRaw);
  assert.equal(fs.readFileSync(current, "utf8"), "existing new choices");
});

test("disk full while copying leaves old settings and removes the partial temporary file", (t) => {
  const full = Object.assign(new Error("Disk full"), { code: "ENOSPC" });
  const h = fixture(t, { fsOverrides: {
    writeFileSync(filename, raw, options) {
      fs.writeFileSync(filename, raw.subarray(0, 4), options);
      throw full;
    },
  } });
  const old = h.seed(LEGACY_PLUGIN_ID);
  assert.doesNotThrow(() => h.load("server/settings-migration.ts").migrateHostSettings());
  assertMigrationError(h, full);
  assert.equal(fs.readFileSync(old, "utf8"), oldRaw);
  assert.equal(fs.existsSync(h.path(PLUGIN_ID)), false);
  assert.deepEqual(fs.readdirSync(dirname(h.path(PLUGIN_ID))), []);
});

test("server startup still registers settings with defaults and RPCs after migration fails", (t) => {
  const denied = Object.assign(new Error("Source unreadable"), { code: "EACCES" });
  const h = fixture(t, { fsOverrides: { readFileSync() { throw denied; } } });
  const old = h.seed(LEGACY_PLUGIN_ID);
  let registered = false;
  const methods = [];
  let cleanup;
  assert.doesNotThrow(() => {
    cleanup = h.load("index.server.ts").default({
      registerSettings(definition) {
        if (definition.id === "hermes-cc") {
          assert.equal(definition.scope, "host");
          assert.deepEqual(definition.schema.parse({}), { enabled: true });
          return;
        }
        if (definition.id !== "presentation") {
          assert.equal(definition.id, "tool-expansion");
          assert.equal(definition.scope, "host");
          assert.deepEqual(definition.schema.parse({}), { entries: {} });
          return;
        }
        assert.equal(definition.id, "presentation");
        assert.deepEqual(definition.schema.parse({}), { preferences: {}, legacyMigrated: false });
        registered = true;
      },
      handle(contract) { methods.push(contract.name); },
    });
  });
  assertMigrationError(h, denied);
  assert.equal(registered, true);
  assert.ok(methods.includes("file.reveal"));
  assert.ok(methods.includes("file.image"));
  assert.ok(methods.includes("prompt.images"));
  assert.ok(methods.includes("prompt.image"));
  assert.equal(typeof cleanup, "function");
  assert.equal(fs.readFileSync(old, "utf8"), oldRaw);
  assert.equal(fs.existsSync(h.path(PLUGIN_ID)), false);
  cleanup();
});

test("server startup migrates before registering the SDK settings", (t) => {
  const h = fixture(t);
  h.seed(LEGACY_PLUGIN_ID);
  let registered = false;
  const cleanup = h.load("index.server.ts").default({
    registerSettings(definition) {
      if (definition.id !== "presentation") return;
      assert.equal(definition.id, "presentation");
      assert.equal(fs.readFileSync(h.path(PLUGIN_ID), "utf8"), oldRaw);
      registered = true;
    },
    handle() {},
  });
  assert.equal(registered, true);
  assert.equal(typeof cleanup, "function");
  cleanup();
});
