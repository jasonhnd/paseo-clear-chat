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

for (const [platform, width, label] of [["ios", 390, "iOS"], ["ios", 820, "iPadOS"], ["android", 390, "Android"]]) {
  test(`${label} replay copies a formatted path and preserves highlights at width ${width}`, async () => {
    const h = createToolHarness(platform, { markdown: true, width });
    const { tree } = h.mount({ type: "assistant_message", text: "==Ready==: **[Report](./reports/result.txt)**" });
    assert.equal(h.nodes(tree, node => node.props.testID === "markdown-highlight").length, 1);
    const links = fileLinks(h, tree);
    assert.equal(links.length, 1);
    await press(links[0]);
    assert.deepEqual(h.copies, ["./reports/result.txt"]);
    assert.deepEqual(h.reveals, []);
  });
}

test("path candidates end at CJK punctuation and line selectors stay attached", () => {
  const h = createToolHarness("web", { markdown: true });
  const { tree } = h.mount({ type: "assistant_message", text: "Report\uff1a/workspace/result.txt\u3002 Next\uff1a./src/main.ts:55:3\uff0c **src/config.ts** and `~/notes.md`." });
  assert.deepEqual(fileLinks(h, tree).map(link => link.props.accessibilityLabel.replace(/^Show file path: /, "")), ["/workspace/result.txt", "./src/main.ts:55:3", "src/config.ts", "~/notes.md"]);
});

test("file reveal surfaces a missing platform opener without an unhandled process error", async () => {
  const h = createToolHarness("web", { modules: { "node:child_process": { spawn() {
    const child = new EventEmitter(); child.unref = () => {};
    setImmediate(() => child.emit("error", new Error("Private opener error")));
    return child;
  } } } });
  const handlers = new Map();
  h.load("index.server.ts").default({ registerSettings() {}, handle(contract, handler) { handlers.set(contract.name, handler); } });
  const result = await handlers.get("file.reveal")({ cwd: process.cwd(), path: "./package.json" });
  assert.equal(result.revealed, null);
  assert.match(result.error, /could not be shown on the host/);
  assert.doesNotMatch(result.error, /Private opener error/);
});


test("inline filenames retain their line selectors as one file action", async () => {
  const h = createToolHarness("web", { markdown: true });
  const { tree } = h.mount({ type: "assistant_message", text: "`README.md:55:3`" });
  const links = fileLinks(h, tree);
  assert.equal(links.length, 1);
  await press(links[0]);
  assert.deepEqual(h.reveals, [{ cwd: "/workspace/demo", path: "README.md:55:3" }]);
});

test("spaced paths stop at fullwidth punctuation before the next sentence", () => {
  const h = createToolHarness("web", { markdown: true });
  const { tree } = h.mount({ type: "assistant_message", text: "Report: /workspace/sample/monthly report.pdf\u3002 Next: ./notes.txt" });
  assert.deepEqual(fileLinks(h, tree).map(link => link.props.accessibilityLabel.replace(/^Show file path: /, "")), ["/workspace/sample/monthly report.pdf", "./notes.txt"]);
});

// Derived from real-hermes-image-path-reply.json: same captured projected item
// shape, with roots absent from the sanitized captures substituted in its prose.
test("captured reply shape preserves unquoted dotted and spaced project roots", async () => {
  const item = require("./fixtures/derived-root-path-dot-space-reply.json");
  const h = createToolHarness("web", { markdown: true });
  const { tree } = h.mount(item);
  const links = fileLinks(h, tree);
  const paths = item.text.split("\n").map(line => line.slice(6).replace(/[.,。] Next step\.$/, ""));
  assert.deepEqual(links.map(link => link.props.accessibilityLabel.replace(/^Show file path: /, "")), paths);
  assert.equal(h.text(tree).replace(/\s+/g, ""), item.text.replace(/\s+/g, ""));
  for (const link of links) await press(link);
  assert.deepEqual(h.reveals.map(value => value.path), paths);
});

for (const platform of ["web", "ios", "android"]) {
  for (const [text, paths] of [
    ["See /workspace/sample/report.txt in src/main.ts", ["/workspace/sample/report.txt", "src/main.ts"]],
    ["Check /tmp/app.v2 then read src/main.ts", ["/tmp/app.v2", "src/main.ts"]],
    ["src/my.project files/x.ts", ["src/my.project files/x.ts"]],
  ]) {
    test(`space directory boundaries on ${platform}: ${text}`, () => {
      const h = createToolHarness(platform, { markdown: true });
      const { tree } = h.mount({ type: "assistant_message", text });
      assert.deepEqual(fileLinks(h, tree).map(link => link.props.accessibilityLabel.replace(/^(Show|Copy) file path: /, "")), paths);
    });
  }
}

for (const platform of ["web", "ios", "android"]) {
  test(`dotted and spaced path preservation on ${platform}`, () => {
    const h = createToolHarness(platform, { markdown: true });
    const paths = ["/home/a/my.project files/report.txt", "~/my.project files/report.txt", "./my.project files/report.txt", "C:\\my.project files\\report.txt"];
    const fixture = require("./fixtures/derived-root-path-dot-space-reply.json");
    const fixturePaths = fixture.text.split("\n").map(line => line.slice(6).replace(/[.,。] Next step\.$/, ""));
    const text = paths.map(path => `${path}. ${path}, (${path}) ${path}。`).join("\n") + "\n" + fixture.text + "\nversion 1.2 is out";
    const { tree } = h.mount({ type: "assistant_message", text });
    assert.deepEqual(fileLinks(h, tree).map(link => link.props.accessibilityLabel.replace(/^(Show|Copy) file path: /, "")), [...paths.flatMap(path => [path, path, path, path]), ...fixturePaths]);
  });
}

for (const platform of ["web", "ios", "android"]) {
  for (const [text, paths] of [
    ["See src/main.ts if/when ready", ["src/main.ts"]],
    ["See src/main.ts release/notes", ["src/main.ts"]],
    ["Use src/main.ts for/with tests.", ["src/main.ts"]],
    ["Check src/app.config before/after edit.", ["src/app.config"]],
    ["docs/v1.2 release/notes", ["docs/v1.2"]],
    ["src/app.v2 release/notes", ["src/app.v2"]],
    ["See src/main.ts and/or src/other.ts", ["src/main.ts", "src/other.ts"]],
  ]) {
    test(`relative file before slash prose on ${platform}: ${text}`, async () => {
      const h = createToolHarness(platform, { markdown: true });
      const { tree } = h.mount({ type: "assistant_message", text });
      const links = fileLinks(h, tree);
      assert.deepEqual(links.map(link => link.props.accessibilityLabel.replace(/^(Show|Copy) file path: /, "")), paths);
      for (const link of links) await press(link);
      assert.deepEqual(platform === "web" ? h.reveals.map(value => value.path) : h.copies, paths);
    });
  }
}

// One assistant message / paragraph: joinSoft runs before inline path detection.
const softbreakReply = require("./fixtures/softbreak-path-reply.json");
const softbreakRanges = [
  { text: "src/main.ts", start: 4, end: 15 },
  { text: "src/main.ts", start: 34, end: 45 },
  { text: "src/main.ts", start: 64, end: 75 },
  { text: "src/app.config", start: 98, end: 112 },
  { text: "docs/v1.2", start: 132, end: 141 },
  { text: "src/app.v2", start: 156, end: 166 },
  { text: "src/main.ts", start: 185, end: 196 },
  { text: "src/other.ts", start: 204, end: 216 },
  { text: "/workspace/sample/my.project files/report.txt", start: 217, end: 262 },
  { text: "/workspace/sample/src/main.ts", start: 268, end: 297 },
  { text: "src/main.ts", start: 301, end: 312 },
  { text: "src/my.project files/x.ts", start: 317, end: 342 },
  { text: "/workspace/sample/my.project files/report.txt", start: 350, end: 395 },
  { text: "src/main.ts", start: 402, end: 413 },
];
const renderedText = tree => Array.isArray(tree) ? tree.map(renderedText).join("")
  : tree == null || typeof tree === "boolean" ? ""
  : typeof tree === "object" ? renderedText(tree.props?.children) : String(tree);

for (const platform of ["web", "ios", "android"]) {
  for (const [lineCount, linkCount] of [[7, 8], [12, 14]]) {
    test(`one softbreak paragraph preserves ${linkCount} exact path ranges on ${platform}`, async () => {
      const h = createToolHarness(platform, { markdown: true });
      const text = softbreakReply.text.split("\n").slice(0, lineCount).join("\n");
      const visible = text.replaceAll("\n", " ");
      const expected = softbreakRanges.slice(0, linkCount);
      const { parseMarkdown, inlineToText } = h.load("client/components/markdown/parse.ts");
      const blocks = parseMarkdown(text);
      assert.equal(blocks.length, 1);
      assert.equal(blocks[0].kind, "paragraph");
      assert.equal(inlineToText(blocks[0].spans), visible);
      let offset = 0;
      const ranges = [];
      for (const span of blocks[0].spans) {
        const value = inlineToText([span]);
        if (span.kind === "link") {
          assert.equal(span.filePath, value);
          ranges.push({ text: value, start: offset, end: offset + value.length });
        } else assert.equal(span.kind, "text", "all remaining prose stays plain text");
        offset += value.length;
      }
      assert.deepEqual(ranges, expected);

      const { tree } = h.mount({ ...softbreakReply, text });
      const paragraph = h.nodes(tree, node => node.type === "Text" && renderedText(node) === visible)[0];
      assert.ok(paragraph, "rendered paragraph preserves every prose character and punctuation");
      const renderedRanges = [];
      let renderedOffset = 0;
      function walk(node) {
        if (Array.isArray(node)) return node.forEach(walk);
        if (node && typeof node === "object") {
          const start = renderedOffset;
          walk(node.props?.children);
          if (/^(Show|Copy) file path:/.test(node.props?.accessibilityLabel ?? "")) {
            renderedRanges.push({ text: renderedText(node), start, end: renderedOffset });
          }
        } else renderedOffset += renderedText(node).length;
      }
      walk(paragraph);
      assert.deepEqual(renderedRanges, expected);
      const links = fileLinks(h, tree);
      assert.equal(links.length, linkCount);
      for (const link of links) await press(link);
      assert.deepEqual(platform === "web" ? h.reveals.map(value => value.path) : h.copies, expected.map(value => value.text));
    });
  }
}

for (const platform of ["web", "ios", "android"]) {
  for (const path of [
    "./my.project files/annual report.pdf",
    "src/my.project files/annual report.pdf",
    "/home/a/My.Project Name/annual report.pdf",
  ]) {
    test(`dotted directories preserve spaced filenames on ${platform}: ${path}`, async () => {
      const h = createToolHarness(platform, { markdown: true });
      const { tree } = h.mount({ type: "assistant_message", text: `See ${path}.` });
      const links = fileLinks(h, tree);
      assert.deepEqual(links.map(link => link.props.accessibilityLabel.replace(/^(Show|Copy) file path: /, "")), [path]);
      assert.deepEqual(links.map(link => renderedText(link)), [path]);
      for (const link of links) await press(link);
      assert.deepEqual(platform === "web" ? h.reveals.map(value => value.path) : h.copies, [path]);
    });
  }
}
