const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const ts = require("typescript");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const filename = resolve(__dirname, "../server/turn-window.ts");
const mod = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(createRequire(filename), mod, mod.exports);
const {
  createTurnWindows, parseNumstatPath, collectFileDetails,
  MAX_DIFF_BYTES, DIFF_TRUNCATED_MARKER, NO_TEXT_DIFF, DIFF_OMITTED_FILE_LIMIT, MAX_DIFF_FILES,
} = mod.exports;
const schemaFilename = resolve(__dirname, "../client/components/turn-window-schema.ts");
const schemaMod = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(fs.readFileSync(schemaFilename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(createRequire(schemaFilename), schemaMod, schemaMod.exports);
const { turnWindowItemSchema } = schemaMod.exports;

const state = entries => ({ kind: "ok", files: new Map(entries), root: "/repo" });
const diffExecute = ({ numstat = "", patch = "" } = {}) => async (_cwd, args) => {
  if (args.includes("--numstat")) return Buffer.from(numstat);
  if (args.includes("diff")) return Buffer.from(patch);
  throw new Error(`Unexpected Git command: ${args.join(" ")}`);
};

function card(snapshot) {
  const h = createToolHarness("web", {});
  const Card = h.load("client/components/turn-window-card.tsx").TurnWindowCard;
  const element = { type: Card, props: { snapshot, tokens: h.tokens } };
  return { h, element };
}

function openedText(snapshot) {
  const { h, element } = card(snapshot);
  const first = h.draw(element);
  const toggle = h.nodes(first, node => node.props?.testID === "turn-window-toggle")[0];
  if (toggle) toggle.props.onPress();
  const text = h.text(h.draw(element));
  h.unmount();
  return text;
}

test("numstat parsing covers simple, braced and arrow renames", () => {
  assert.deepEqual(parseNumstatPath("src/a.ts"), { path: "src/a.ts", renamedFrom: null });
  assert.deepEqual(parseNumstatPath("src/{old => new}.ts"), { path: "src/new.ts", renamedFrom: "src/old.ts" });
  assert.deepEqual(parseNumstatPath("old.txt => new.txt"), { path: "new.txt", renamedFrom: "old.txt" });
});

test("per-file stats come from git diff --numstat and label binary, rename and deletion", async () => {
  const captures = [
    state([["src/a.ts", "1"], ["img/logo.png", "1"], ["src/old.ts", "1"], ["gone.txt", "1"]]),
    state([["src/a.ts", "2"], ["img/logo.png", "2"], ["src/new.ts", "2"]]),
  ];
  const numstat = ["3\t1\tsrc/a.ts", "-\t-\timg/logo.png", "2\t0\tsrc/{old => new}.ts", "0\t9\tgone.txt"].join("\n");
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,4 @@",
    " line",
    "+new line",
    "+another line",
    "diff --git a/img/logo.png b/img/logo.png",
    "index 1111111..2222222 100644",
    "Binary files a/img/logo.png and b/img/logo.png differ",
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 90%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "--- a/src/old.ts",
    "+++ b/src/new.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1,9 +0,0 @@",
    "-one",
    "-two",
  ].join("\n");
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat, patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.deepEqual(result.files, ["gone.txt", "img/logo.png", "src/a.ts", "src/new.ts"]);
  assert.deepEqual(
    { added: result.details["src/a.ts"].added, deleted: result.details["src/a.ts"].deleted },
    { added: 3, deleted: 1 },
  );
  assert.match(result.details["src/a.ts"].diff, /\+new line/);
  assert.equal(result.details["img/logo.png"].binary, true);
  assert.equal(result.details["img/logo.png"].added, null);
  assert.match(result.details["img/logo.png"].note, /binary/);
  assert.equal(result.details["src/new.ts"].renamedFrom, "src/old.ts");
  assert.deepEqual(
    { added: result.details["src/new.ts"].added, deleted: result.details["src/new.ts"].deleted },
    { added: 2, deleted: 0 },
  );
  assert.match(result.details["src/new.ts"].diff, /rename from src\/old\.ts/);
  assert.equal(result.details["src/old.ts"], undefined);
  assert.ok(!result.files.includes("src/old.ts"));
  assert.deepEqual(
    { added: result.details["gone.txt"].added, deleted: result.details["gone.txt"].deleted },
    { added: 0, deleted: 9 },
  );
  const visible = openedText(result);
  assert.ok(visible.includes("src/a.ts  +3 / -1"), visible);
  assert.ok(visible.includes("binary file"), visible);
  assert.ok(visible.includes("renamed from src/old.ts"), visible);
});

test("a large diff is truncated with an explicit marker and stays bounded", async () => {
  const captures = [state([["big.ts", "1"]]), state([["big.ts", "2"]])];
  const body = "x".repeat(MAX_DIFF_BYTES * 2);
  const patch = ["diff --git a/big.ts b/big.ts", "--- a/big.ts", "+++ b/big.ts", "@@ -1 +1 @@", `+${body}`].join("\n");
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat: "1\t0\tbig.ts", patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.equal(result.details["big.ts"].truncated, true);
  assert.ok(result.details["big.ts"].diff.includes(DIFF_TRUNCATED_MARKER));
  assert.ok(Buffer.byteLength(result.details["big.ts"].diff, "utf8") <= MAX_DIFF_BYTES + 64);
});

test("paths beyond the diff file limit are labelled, not silently dropped", async () => {
  const before = [];
  const after = [];
  for (let index = 0; index < MAX_DIFF_FILES + 1; index += 1) {
    before.push([`file-${index}.txt`, "before"]);
    after.push([`file-${index}.txt`, "after"]);
  }
  const captures = [state(before), state(after)];
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({}));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.equal(result.files.length, MAX_DIFF_FILES + 1);
  const omitted = Object.entries(result.details).filter(([, stats]) => stats.note === DIFF_OMITTED_FILE_LIMIT);
  assert.equal(omitted.length, 1);
  assert.equal(omitted[0][1].diff, null);
  assert.equal(omitted[0][1].added, null);
});

test("changes with no worktree diff are labelled instead of showing +0 / -0", async () => {
  const captures = [state([["new.txt", "missing"]]), state([["new.txt", "file:33188:abc"]])];
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({}));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.equal(result.details["new.txt"].added, null);
  assert.equal(result.details["new.txt"].deleted, null);
  assert.equal(result.details["new.txt"].note, NO_TEXT_DIFF);
  assert.ok(openedText(result).includes(NO_TEXT_DIFF));
});

test("an empty change set produces no files and no card", async () => {
  const windows = createTurnWindows(async () => state([["same.txt", "x"]]), diffExecute({}));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.details, {});
  const h = createToolHarness("web", {});
  const Card = h.load("client/components/turn-window-card.tsx").TurnWindowCard;
  const element = { type: Card, props: { snapshot: { files: [], details: {}, message: null, warning: null, incomplete: false }, tokens: h.tokens } };
  const tree = h.draw(element);
  assert.equal(h.nodes(tree, node => node.props?.testID === "turn-window-card").length, 0);
  h.unmount();
});

test("a file row opens the read-only diff and closes again", async () => {
  const snapshot = {
    files: ["src/a.ts"],
    details: { "src/a.ts": { added: 2, deleted: 1, binary: false, renamedFrom: null, diff: "+added\n-removed", truncated: false, note: null } },
    message: null, warning: null, incomplete: true,
  };
  const { h, element } = card(snapshot);
  let tree = h.draw(element);
  h.nodes(tree, node => node.props?.testID === "turn-window-toggle")[0].props.onPress();
  tree = h.draw(element);
  assert.equal(h.nodes(tree, node => node.props?.testID === "turn-window-diff-0").length, 0);
  h.nodes(tree, node => node.props?.testID === "turn-window-file-0")[0].props.onPress();
  tree = h.draw(element);
  assert.equal(h.nodes(tree, node => node.props?.testID === "turn-window-diff-0").length, 1);
  assert.ok(h.text(tree).includes("+added"));
  h.nodes(tree, node => node.props?.testID === "turn-window-file-0")[0].props.onPress();
  tree = h.draw(element);
  assert.equal(h.nodes(tree, node => node.props?.testID === "turn-window-diff-0").length, 0);
  h.unmount();
  h.dispose();
});

test("snapshots without details still render file names", async () => {
  const visible = openedText({ files: ["legacy.txt"], message: null, warning: null, incomplete: true });
  assert.ok(visible.includes("legacy.txt"));
});

test("the timeline schema keeps per-file details after parse", async () => {
  const payload = {
    files: ["src/a.ts", "img/logo.png"],
    details: {
      "src/a.ts": { added: 2, deleted: 1, binary: false, renamedFrom: null, diff: "+two\n-one", truncated: false, note: null },
      "img/logo.png": { added: null, deleted: null, binary: true, renamedFrom: null, diff: null, truncated: false, note: "binary file" },
    },
    message: null, warning: null, incomplete: true,
  };
  const parsed = turnWindowItemSchema.parse(payload);
  assert.deepEqual(parsed.details, payload.details);
  const visible = openedText(parsed);
  assert.ok(visible.includes("src/a.ts  +2 / -1"), visible);
  assert.ok(visible.includes("binary file"), visible);
});

test("legacy timeline items without details still parse", () => {
  const parsed = turnWindowItemSchema.parse({ files: ["legacy.txt"], message: null, warning: null, incomplete: true });
  assert.deepEqual(parsed.details, {});
});

test("the client registers the turn-window renderer with the shared schema", () => {
  const source = fs.readFileSync(resolve(__dirname, "../index.client.tsx"), "utf8");
  assert.ok(source.includes('from "./client/components/turn-window-schema"'));
  assert.ok(source.includes("schema: turnWindowItemSchema"));
  assert.equal((source.match(/turnWindowItemSchema/g) || []).length >= 2, true);
});

test("a content line that looks like a diff header never steals another file's chunk", async () => {
  const captures = [state([["fixture.ts", "1"], ["some/long/path.ts", "1"]]), state([["fixture.ts", "2"], ["some/long/path.ts", "2"]])];
  const numstat = ["1\t0\tfixture.ts", "1\t0\tsome/long/path.ts"].join("\n");
  const patch = [
    "diff --git a/fixture.ts b/fixture.ts",
    "--- a/fixture.ts",
    "+++ b/fixture.ts",
    "@@ -1,1 +1,2 @@",
    " keep",
    "+++ b/some/long/path.ts",
    "diff --git a/some/long/path.ts b/some/long/path.ts",
    "--- a/some/long/path.ts",
    "+++ b/some/long/path.ts",
    "@@ -1,1 +1,2 @@",
    " keep",
    "+real change",
  ].join("\n");
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat, patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.match(result.details["fixture.ts"].diff, /diff --git a\/fixture\.ts b\/fixture\.ts/);
  assert.match(result.details["fixture.ts"].diff, /\+{3} b\/some\/long\/path\.ts/);
  assert.match(result.details["some/long/path.ts"].diff, /\+real change/);
  assert.ok(!result.details["some/long/path.ts"].diff.includes("diff --git a/fixture.ts"), "fixture chunk must not attach to the longer path");
});

test("binary and truncated labels are shown once, not repeated", () => {
  const snapshot = {
    files: ["img.bin", "big.ts"],
    details: {
      "img.bin": { added: null, deleted: null, binary: true, renamedFrom: null, diff: null, truncated: false, note: "binary file" },
      "big.ts": { added: 1, deleted: 0, binary: false, renamedFrom: null, diff: "+x\n... [diff truncated]", truncated: true, note: "output cut at the size limit" },
    },
    message: null, warning: null, incomplete: true,
  };
  const visible = openedText(snapshot);
  assert.equal((visible.match(/binary file/g) || []).length, 1, visible);
  assert.equal((visible.match(/output cut at the size limit/g) || []).length, 1, visible);
  assert.equal((visible.match(/diff truncated/g) || []).length, 0, visible);
});

test("a file without a diff gets no expand arrow and no open action", () => {
  const snapshot = {
    files: ["img.bin"],
    details: { "img.bin": { added: null, deleted: null, binary: true, renamedFrom: null, diff: null, truncated: false, note: "binary file" } },
    message: null, warning: null, incomplete: true,
  };
  const { h, element } = card(snapshot);
  let tree = h.draw(element);
  h.nodes(tree, node => node.props?.testID === "turn-window-toggle")[0].props.onPress();
  tree = h.draw(element);
  const row = h.nodes(tree, node => node.props?.testID === "turn-window-file-0")[0];
  assert.equal(row.props.disabled, true);
  assert.equal(typeof row.props.onPress, "undefined");
  assert.ok(!h.text(tree).includes("▾"));
  assert.equal(h.nodes(tree, node => node.props?.testID === "turn-window-diff-0").length, 0);
  h.unmount(); h.dispose();
});

function expandedCard(snapshot, index) {
  const { h, element } = card(snapshot);
  let tree = h.draw(element);
  h.nodes(tree, node => node.props?.testID === "turn-window-toggle")[0].props.onPress();
  tree = h.draw(element);
  const row = h.nodes(tree, node => node.props?.testID === `turn-window-file-${index}`)[0];
  if (typeof row?.props?.onPress === "function") row.props.onPress();
  tree = h.draw(element);
  const hasDiff = h.nodes(tree, node => node.props?.testID === `turn-window-diff-${index}`).length === 1;
  const text = h.text(tree);
  h.unmount();
  h.dispose();
  return { hasDiff, text };
}

function fileRowCount(snapshot) {
  const { h, element } = card(snapshot);
  let tree = h.draw(element);
  h.nodes(tree, node => node.props?.testID === "turn-window-toggle")[0].props.onPress();
  tree = h.draw(element);
  const count = h.nodes(tree, node => typeof node.props?.testID === "string" && node.props.testID.startsWith("turn-window-file-")).length;
  h.unmount();
  h.dispose();
  return count;
}

test("a path with spaces keeps its diff and its expand action", async () => {
  const captures = [state([["my file.txt", "1"]]), state([["my file.txt", "2"]])];
  const patch = [
    "diff --git a/my file.txt b/my file.txt",
    "index 1111111..2222222 100644",
    "--- a/my file.txt\t",
    "+++ b/my file.txt\t",
    "@@ -1 +1,2 @@",
    " keep",
    "+added line",
  ].join("\n");
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat: "1\t0\tmy file.txt", patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.deepEqual(result.files, ["my file.txt"]);
  assert.equal(result.details["my file.txt"].added, 1);
  assert.match(result.details["my file.txt"].diff, /\+added line/);
  const visible = openedText(result);
  assert.ok(visible.includes("my file.txt  +1 / -0"), visible);
  assert.ok(visible.includes("▾"), visible);
  const expanded = expandedCard(result, 0);
  assert.equal(expanded.hasDiff, true);
  assert.ok(expanded.text.includes("+added line"), expanded.text);
});

test("Chinese file names (with and without a space) keep their diff and expand", async () => {
  const captures = [state([["中文.txt", "1"], ["中文 文件.txt", "1"]]), state([["中文.txt", "2"], ["中文 文件.txt", "2"]])];
  const patch = [
    "diff --git a/中文.txt b/中文.txt",
    "index 1111111..2222222 100644",
    "--- a/中文.txt",
    "+++ b/中文.txt",
    "@@ -1 +1,2 @@",
    " keep",
    "+中文新增",
    "diff --git a/中文 文件.txt b/中文 文件.txt",
    "index 3333333..4444444 100644",
    "--- a/中文 文件.txt\t",
    "+++ b/中文 文件.txt\t",
    "@@ -1 +1,2 @@",
    " keep",
    "+带空格新增",
  ].join("\n");
  const numstat = ["1\t0\t中文.txt", "1\t0\t中文 文件.txt"].join("\n");
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat, patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.equal(result.details["中文.txt"].added, 1);
  assert.match(result.details["中文.txt"].diff, /\+中文新增/);
  assert.equal(result.details["中文 文件.txt"].added, 1);
  assert.match(result.details["中文 文件.txt"].diff, /\+带空格新增/);
  const plainIndex = result.files.indexOf("中文.txt");
  const spacedIndex = result.files.indexOf("中文 文件.txt");
  assert.equal(expandedCard(result, plainIndex).hasDiff, true);
  const spaced = expandedCard(result, spacedIndex);
  assert.equal(spaced.hasDiff, true);
  assert.ok(spaced.text.includes("+带空格新增"), spaced.text);
});

test("a quoted C-escaped Chinese path is decoded and attributed", async () => {
  const name = "中文 文件.txt";
  const quoted = "\"b/\\344\\270\\255\\346\\226\\207 \\346\\226\\207\\344\\273\\266.txt\"";
  const quotedSource = "\"a/\\344\\270\\255\\346\\226\\207 \\346\\226\\207\\344\\273\\266.txt\"";
  const patch = [
    `diff --git ${quotedSource} ${quoted}`,
    "index 1111111..2222222 100644",
    `--- ${quotedSource}`,
    `+++ ${quoted}`,
    "@@ -1 +1,2 @@",
    " keep",
    "+中文新增",
  ].join("\n");
  const captures = [state([[name, "1"]]), state([[name, "2"]])];
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat: `1\t0\t${name}`, patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.deepEqual(result.files, [name]);
  assert.equal(result.details[name].added, 1);
  assert.match(result.details[name].diff, /\+中文新增/);
  const expanded = expandedCard(result, 0);
  assert.equal(expanded.hasDiff, true);
  assert.ok(expanded.text.includes("+中文新增"), expanded.text);
});

test("a quoted numstat path with an escaped quote is decoded", async () => {
  const name = 'we"ird.txt';
  const captures = [state([[name, "1"]]), state([[name, "2"]])];
  const patch = [
    'diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"',
    "index 1111111..2222222 100644",
    '--- "a/we\\"ird.txt"',
    '+++ "b/we\\"ird.txt"',
    "@@ -1 +1,2 @@",
    " keep",
    "+odd line",
  ].join("\n");
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat: '1\t0\t"we\\"ird.txt"', patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.deepEqual(result.files, [name]);
  assert.equal(result.details[name].added, 1);
  assert.equal(result.details[name].deleted, 0);
  assert.match(result.details[name].diff, /\+odd line/);
});

test("a simple rename is attributed to the new path and labelled once", async () => {
  const captures = [state([["old-name.txt", "1"]]), state([["new-name.txt", "2"]])];
  const patch = [
    "diff --git a/old-name.txt b/new-name.txt",
    "similarity index 100%",
    "rename from old-name.txt",
    "rename to new-name.txt",
  ].join("\n");
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat: "0\t0\told-name.txt => new-name.txt", patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.equal(result.details["new-name.txt"].renamedFrom, "old-name.txt");
  assert.match(result.details["new-name.txt"].diff, /rename to new-name\.txt/);
  assert.equal(result.details["new-name.txt"].added, 0);
  assert.deepEqual(result.files, ["new-name.txt"]);
  assert.ok(!result.files.includes("old-name.txt"));
  assert.equal(fileRowCount(result), 1);
  const visible = openedText(result);
  assert.equal((visible.match(/renamed from old-name\.txt/g) || []).length, 1, visible);
  assert.ok(!visible.includes("no diff available from Git"), visible);
  assert.ok(!visible.includes("no textual diff"), visible);
  const index = result.files.indexOf("new-name.txt");
  assert.equal(expandedCard(result, index).hasDiff, true);
});

test("a braced directory rename is attributed to the new path", async () => {
  const captures = [state([["dir/old/file.txt", "1"]]), state([["dir/new/file.txt", "2"]])];
  const patch = [
    "diff --git a/dir/old/file.txt b/dir/new/file.txt",
    "similarity index 90%",
    "rename from dir/old/file.txt",
    "rename to dir/new/file.txt",
    "--- a/dir/old/file.txt",
    "+++ b/dir/new/file.txt",
    "@@ -1 +1 @@",
    "-old line",
    "+new line",
  ].join("\n");
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat: "1\t1\tdir/{old => new}/file.txt", patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.equal(result.details["dir/new/file.txt"].renamedFrom, "dir/old/file.txt");
  assert.deepEqual({ added: result.details["dir/new/file.txt"].added, deleted: result.details["dir/new/file.txt"].deleted }, { added: 1, deleted: 1 });
  assert.match(result.details["dir/new/file.txt"].diff, /\+new line/);
});

test("a binary change is labelled and never gets an empty expandable diff", async () => {
  const captures = [state([["img.bin", "1"]]), state([["img.bin", "2"]])];
  const patch = [
    "diff --git a/img.bin b/img.bin",
    "index 1111111..2222222 100644",
    "Binary files a/img.bin and b/img.bin differ",
  ].join("\n");
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat: "-\t-\timg.bin", patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.equal(result.details["img.bin"].binary, true);
  assert.equal(result.details["img.bin"].added, null);
  assert.equal(result.details["img.bin"].deleted, null);
  assert.match(result.details["img.bin"].note, /binary/);
  assert.equal(result.details["img.bin"].diff, null);
  const opened = expandedCard(result, 0);
  assert.equal(opened.hasDiff, false);
  assert.ok(!opened.text.includes("▾"));
});

test("a deletion is attributed through the --- a/<path> line", async () => {
  const captures = [state([["gone file.txt", "1"]]), state([])];
  const patch = [
    "diff --git a/gone file.txt b/gone file.txt",
    "deleted file mode 100644",
    "--- a/gone file.txt\t",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-removed line",
  ].join("\n");
  const windows = createTurnWindows(async () => captures.shift(), diffExecute({ numstat: "0\t1\tgone file.txt", patch }));
  windows.before("a", "t1", "workspace", "/repo");
  await windows.after("a", "t1", "/repo");
  const result = await windows.get("a", "t1");
  assert.equal(result.details["gone file.txt"].deleted, 1);
  assert.match(result.details["gone file.txt"].diff, /-removed line/);
  const expanded = expandedCard(result, 0);
  assert.equal(expanded.hasDiff, true);
});
