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
  assert.deepEqual(result.files, ["gone.txt", "img/logo.png", "src/a.ts", "src/new.ts", "src/old.ts"]);
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
  assert.match(result.details["src/old.ts"].note, /renamed to src\/new\.ts/);
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
