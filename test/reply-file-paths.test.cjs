const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const captured = require("./fixtures/real-hermes-image-path-reply.json");
const fileLinks = (h, tree) => h.nodes(tree, node => /^(Show|Copy) file path:/.test(node.props.accessibilityLabel ?? ""));
const press = async link => {
  let stopped = false;
  await link.props.onPress({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
};

for (const width of [1440, 1024, 820, 390]) {
  test(`reply file links resolve through the host at web width ${width}`, async () => {
    const h = createToolHarness("web", { markdown: true, width });
    const mounted = h.mount({ ...captured, text: captured.text.replaceAll("image.png", "report.txt") });
    const links = fileLinks(h, mounted.tree);
    assert.equal(links.length, 1, "a bare filename in prose is deliberately ambiguous");
    await press(links[0]);
    if (width < 1024) {
      assert.deepEqual(h.copies, ["/workspace/sample/report.txt"]);
      assert.deepEqual(h.reveals, []);
      assert.match(h.toasts.at(-1), /Path copied.*host computer/i);
    } else {
      assert.deepEqual(h.reveals, [{ cwd: "/workspace/demo", path: "/workspace/sample/report.txt" }]);
    }
  });
}

for (const platform of ["web", "ios", "android"]) {
  test(`absolute, relative, spaced and explicit reply paths on ${platform}`, async () => {
    const h = createToolHarness(platform, { markdown: true });
    const paths = ["/workspace/sample/report.txt", "./reports/notes.md", "../shared/result.csv", "src/main.ts", "./reports/monthly report.pdf", "/workspace/sample/annual report.pdf", "README.md", "C:\\sample\\report.txt"];
    const text = [
      `Absolute: ${paths[0]}. Relative: ${paths[1]}, ${paths[2]} and ${paths[3]}.`,
      `Spaced: "${paths[4]}" and ${paths[5]}.`,
      `\`${paths[6]}\` and \`${paths[7]}\`.`,
      "[Report](<./reports/quarterly report.pdf>)",
    ].join("\n\n");
    const { tree } = h.mount({ type: "assistant_message", text });
    const links = fileLinks(h, tree);
    assert.equal(links.length, 9);
    for (const link of links) await press(link);
    const targets = [...paths, "./reports/quarterly report.pdf"];
    assert.deepEqual(platform === "web" ? h.reveals.map(value => value.path) : h.copies, targets);
    assert.equal(h.links.length, 0, "filesystem paths never reach a URL handler");
    if (platform !== "web") {
      assert.deepEqual(h.reveals, []);
      assert.match(h.toasts.at(-1), /Path copied.*host computer/i);
    }
    if (platform === "ios") {
      for (const run of h.nodes(tree, node => node.type === "Text" && fileLinks(h, node).length)) assert.equal(run.props.selectable, false);
    }
  });
}

test("conservative path detection preserves prose, URLs, escaped markers and fenced code", () => {
  const h = createToolHarness("web", { markdown: true });
  const text = "ordinary words and/or yes/no example.org v1.0.1 ./ / //server/share file.txt\n\nhttps://example.org/docs/page.txt\n\n```text\n/workspace/code.txt ==literal==\n```";
  const { tree } = h.mount({ type: "assistant_message", text });
  assert.equal(fileLinks(h, tree).length, 0);
  assert.equal(h.nodes(tree, node => node.props.accessibilityRole === "link").length, 1);
  assert.match(h.text(tree), /==literal==/);
});

for (const failure of ["missing", "transport"]) {
  test(`reply file ${failure} failure gives a clear safe hint`, async () => {
    const h = createToolHarness("web", { markdown: true, revealRpc: async () => {
      if (failure === "transport") throw new Error("Private diagnostic");
      return { revealed: null, error: "ENOENT: private diagnostic" };
    } });
    const { tree } = h.mount({ type: "assistant_message", text: "./missing.txt" });
    await press(fileLinks(h, tree)[0]);
    assert.match(h.toasts.at(-1), /could not.*host|does not exist/i);
    assert.doesNotMatch(h.toasts.at(-1), /ENOENT|Private|private diagnostic/);
  });
}

test("mobile path copying failures retain the path in the existing manual-copy dialog", async () => {
  const h = createToolHarness("ios", { markdown: true, copyText: async () => { throw new Error("Denied"); } });
  const mounted = h.mount({ type: "assistant_message", text: "./reports/result.txt" });
  await press(fileLinks(h, mounted.tree)[0]);
  const field = h.nodes(mounted.render(), node => node.props.accessibilityLabel === "Text to copy")[0];
  assert.equal(field.props.value, "./reports/result.txt");
});

test("relative paths without a session cwd never fall back to the daemon directory", async () => {
  const h = createToolHarness("web", { markdown: true, agent: { cwd: null } });
  const { tree } = h.mount({ type: "assistant_message", text: "./report.txt" });
  await press(fileLinks(h, tree)[0]);
  assert.deepEqual(h.reveals, []);
  assert.match(h.toasts.at(-1), /working directory.*unavailable/i);
});

test("file reveal resolves real absolute, relative and spaced files and reports missing paths", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "reply-files-"));
  const calls = [];
  const h = createToolHarness("web", { modules: { "node:child_process": { spawn(command, args) {
    calls.push({ command, args });
    const child = new EventEmitter(); child.unref = () => {};
    setImmediate(() => child.emit("spawn"));
    return child;
  } } } });
  const handlers = new Map();
  h.load("index.server.ts").default({ registerSettings() {}, handle(contract, handler) { handlers.set(contract.name, handler); } });
  const reveal = handlers.get("file.reveal");
  try {
    fs.writeFileSync(join(root, "monthly report.txt"), "sample");
    for (const path of [join(root, "monthly report.txt"), "./monthly report.txt", "./monthly report.txt:12:3"]) {
      const result = await reveal({ cwd: root, path });
      assert.equal(result.revealed, join(root, "monthly report.txt"));
      assert.equal(result.error, null);
    }
    assert.equal(calls.length, 3);
    const missing = await reveal({ cwd: root, path: "./missing.txt" });
    assert.equal(missing.revealed, null);
    assert.match(missing.error, /does not exist|cannot be accessed/i);
    assert.doesNotMatch(missing.error, /ENOENT|stat/);
    const noCwd = await reveal({ cwd: "", path: "./monthly report.txt" });
    assert.equal(noCwd.revealed, null);
    assert.match(noCwd.error, /working directory/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
