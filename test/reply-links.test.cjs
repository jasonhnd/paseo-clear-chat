const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const capturedReplies = require("./fixtures/real-assistant-links.json");
const { replyLinkCases } = require("./helpers/reply-link-cases.cjs");

const markdownTarget = "https://example.org/guide?from=reply&mode=full#links";
const bareTarget = "https://example.org/reference";
const reply = `[**Read the guide**](${markdownTarget} "Guide") and ${bareTarget}.`;

function renderReply(h, text = reply) {
  return h.mount({ type: "assistant_message", text }).tree;
}

function linksIn(h, tree) {
  return h.nodes(tree, node => node.props.accessibilityRole === "link");
}

function press(link) {
  let stopped = false;
  link.props.onPress({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, "link presses do not bubble into surrounding controls");
}

for (const [platform, device, isPad] of [["web", "web", false], ["ios", "iOS", false], ["ios", "iPadOS", true], ["android", "Android", false]]) {
  test(`every captured and synthetic reply link uses the exact ${device} opener arguments`, () => {
    const browser = [], native = [];
    const h = createToolHarness(platform, {
      markdown: true,
      replyFooter: true,
      isPad,
      openURL: (...args) => native.push(args),
      globals: {
        ...(platform === "web" ? {} : { paseoDesktop: { opener: { openUrl() { assert.fail("desktop bridge used outside desktop"); } } } }),
        open: (...args) => browser.push(args),
      },
    });
    const expected = [];
    for (const { item, targets } of replyLinkCases) {
      const source = structuredClone(item);
      const { tree } = h.mount(source);
      const links = linksIn(h, tree);
      assert.equal(links.length, targets.length);
      const copy = h.nodes(tree, node => node.props.accessibilityLabel === "Copy reply")[0];
      assert.ok(copy);
      assert.equal(linksIn(h, copy).length, 0, "copy never wraps reply links");
      links.forEach(press);
      assert.deepEqual(h.links, platform === "web" ? [] : targets);
      assert.deepEqual(h.copies, [], "link taps never trigger copy");
      assert.deepEqual(source, item, "replays do not mutate captured items");
      expected.push(...targets);
      assert.deepEqual(browser, platform === "web" ? expected.map(url => [url, "_blank", "noopener,noreferrer"]) : []);
      assert.deepEqual(native, platform === "web" ? [] : expected.map(url => [url]));
    }
  });
}

test("bare mailto links preserve encoded parameters, punctuation and code boundaries", () => {
  const h = createToolHarness("android", { markdown: true });
  const target = "mailto:first_last+tag@example.org?subject=Hello%20world&cc=other@example.org";
  const tree = renderReply(h, `Email\uff1a${target}\u3002 Plain hello@example.org and xmailto:hello@example.org.\n\n\`${target}\`\n\n\`\`\`text\n${target}\n\`\`\``);
  const links = linksIn(h, tree);
  assert.equal(links.length, 1);
  assert.equal(h.text(links[0]), target);
  press(links[0]);
  assert.deepEqual(h.links, [target]);
  assert.ok(h.text(tree).includes("\u3002"));
});

for (const [index, source] of capturedReplies.entries()) {
  for (const platform of ["web", "ios", "android"]) {
    test(`captured reply ${index + 1} autolinks a URL after fullwidth punctuation on ${platform}`, () => {
      const browser = [];
      const h = createToolHarness(platform, { markdown: true, globals: { open: (...args) => browser.push(args) } });
      const item = structuredClone(source);
      const transformed = h.transformers.get(item.type).transform({ item, phase: "complete" });
      assert.equal(transformed.items[0].kind, "omp-assistant");
      assert.equal(transformed.items[0].data.text, source.text);
      const { tree } = h.mount(item);
      const links = linksIn(h, tree);
      const bare = links.filter(link => h.text(link) === "https://example.com/sample/project");
      assert.equal(bare.length, 1, "the captured bare URL becomes an inline link");
      assert.equal(links.length, index === 0 ? 2 : 3, "explicit links and image links stay intact");
      assert.equal(h.nodes(tree, node => node.type === "Image").length, index === 0 ? 0 : 2);
      press(bare[0]);
      assert.deepEqual(browser, platform === "web" ? [["https://example.com/sample/project", "_blank", "noopener,noreferrer"]] : []);
      assert.deepEqual(h.links, platform === "web" ? [] : ["https://example.com/sample/project"]);
      assert.deepEqual(item, source, "the projected item stays unchanged");
    });
  }
}

test("bare URLs respect Unicode punctuation, adjacent code and word boundaries", () => {
  const h = createToolHarness("ios", { markdown: true });
  const text = [
    "Label\uff1ahttps://example.com/colon\u3002",
    "\u201chttps://example.com/quoted\u201d\uff0c",
    "\uff08https://example.com/parenthesized\uff09\uff1b",
    "https://example.com/adjacent`code`",
    "\u03b1https://example.com/word xhttps://example.com/word _https://example.com/word",
    "`https://example.com/code`",
  ].join("\n\n");
  const tree = renderReply(h, text);
  const links = linksIn(h, tree);
  assert.deepEqual(links.map(link => h.text(link)), ["colon", "quoted", "parenthesized", "adjacent"].map(path => `https://example.com/${path}`));
  links.forEach(press);
  assert.deepEqual(h.links, links.map(link => h.text(link)));
  for (const literal of ["\uff1a", "\u3002", "\u201c", "\u201d", "\uff0c", "\uff08", "\uff09", "\uff1b", "code"]) {
    assert.ok(h.text(tree).includes(literal), "surrounding punctuation and code remain visible");
  }
});

for (const client of ["desktop", "web", "ios", "android"]) {
  test(`upstream #4: Markdown links and bare URLs open through the ${client} client`, async () => {
    const opened = [], browser = [];
    const opener = { openUrl(url) { assert.equal(this, opener); opened.push(url); return Promise.resolve(); } };
    const h = createToolHarness(client === "desktop" ? "web" : client, {
      markdown: true,
      globals: {
        ...(client === "desktop" ? { paseoDesktop: { opener } } : {}),
        open: (...args) => browser.push(args),
      },
    });
    const tree = renderReply(h);
    const links = linksIn(h, tree);
    assert.equal(links.length, 2);
    assert.equal(h.text(links[0]), "Read the guide");
    assert.equal(h.text(links[1]), bareTarget);
    for (const link of links) {
      assert.equal(link.type, "Text", "links remain inline with the reply");
      assert.equal(link.props.href, undefined, "a press cannot navigate the app window");
      press(link);
    }
    await Promise.resolve();
    const targets = [markdownTarget, bareTarget];
    assert.deepEqual(opened, client === "desktop" ? targets : []);
    assert.deepEqual(browser, client === "web" ? targets.map(url => [url, "_blank", "noopener,noreferrer"]) : []);
    assert.deepEqual(h.links, client === "ios" || client === "android" ? targets : []);
  });
}

test("upstream #4: iOS linked runs avoid selection gestures in all Markdown blocks and variants", () => {
  const text = [
    "# [**Heading**](https://example.org/heading)",
    "",
    "*Emphasis with [a link](https://example.org/emphasis)* and `code`.",
    "",
    "- ~~[List link](https://example.org/list)~~",
    "",
    "- [x] https://example.org/task",
    "",
    "> [Quote link](https://example.org/quote)",
    "",
    "| [Header link](https://example.org/header) | Plain |",
    "| --- | --- |",
    "| https://example.org/cell | Plain |",
    "",
    "Ordinary selectable prose.",
  ].join("\n");
  for (const variant of ["document", "compact", "terminal"]) {
    const h = createToolHarness("ios", { markdown: true, preferences: { markdownVariant: variant } });
    const tree = renderReply(h, text);
    const links = linksIn(h, tree);
    assert.equal(links.length, 7);
    for (const run of h.nodes(tree, node => node.type === "Text" && linksIn(h, node).length > 0)) {
      assert.equal(run.props.selectable, false, "linked text and every enclosing text run disable selection");
      for (const child of h.nodes(run, node => node.type === "Text")) {
        assert.notEqual(child.props.selectable, true, "formatted link labels cannot reenable selection");
      }
    }
    const prose = h.nodes(tree, node => node.type === "Text" && h.text(node) === "Ordinary selectable prose.")[0];
    assert.equal(prose.props.selectable, true);
    links.forEach(press);
    assert.deepEqual(h.links, ["heading", "emphasis", "list", "task", "quote", "header", "cell"].map(path => `https://example.org/${path}`));
  }
});

test("upstream #4: iOS links alongside reply images remain tappable", () => {
  const h = createToolHarness("ios", { markdown: true });
  const tree = renderReply(h, `[Guide](${markdownTarget}) ![Diagram](https://example.org/diagram.png) and ${bareTarget}.`);
  const links = linksIn(h, tree);
  assert.equal(links.length, 3);
  assert.equal(h.nodes(tree, node => node.type === "Image").length, 1, "reply images stay outside inline text");
  for (const run of h.nodes(tree, node => node.type === "Text" && linksIn(h, node).length > 0)) {
    assert.equal(run.props.selectable, false);
  }
  links.forEach(press);
  assert.deepEqual(h.links, [markdownTarget, "https://example.org/diagram.png", bareTarget]);
});

for (const platform of ["web", "android"]) {
  test(`upstream #4: ${platform} retains selectable linked prose`, () => {
    const h = createToolHarness(platform, { markdown: true, globals: {} });
    const tree = renderReply(h);
    for (const run of h.nodes(tree, node => node.type === "Text" && linksIn(h, node).length > 0)) {
      assert.equal(run.props.selectable, true);
    }
  });
}

test("upstream #4: iOS reply copy is a separate control and never handles a link tap", async () => {
  const h = createToolHarness("ios", { markdown: true, replyFooter: true, timelineTail: true });
  const tree = renderReply(h);
  const link = linksIn(h, tree)[0];
  const copy = h.nodes(tree, node => node.props.accessibilityLabel === "Copy reply")[0];
  assert.ok(copy);
  assert.equal(linksIn(h, copy).length, 0, "copy hit area does not wrap reply links");
  press(link);
  assert.deepEqual(h.links, [markdownTarget]);
  assert.deepEqual(h.copies, []);
  await copy.props.onPress();
  assert.deepEqual(h.copies, [reply]);
  assert.deepEqual(h.links, [markdownTarget]);
});

for (const failure of ["throw", "reject"]) {
  test(`upstream #4: desktop bridge ${failure} falls back to the browser`, async () => {
    const browser = [];
    const h = createToolHarness("web", { globals: {
      paseoDesktop: { opener: { openUrl() {
        if (failure === "throw") throw new Error("Bridge unavailable");
        return Promise.reject(new Error("Bridge unavailable"));
      } } },
      open: (...args) => browser.push(args),
    } });
    await h.load("client/components/open-link").openLink(markdownTarget);
    assert.deepEqual(browser, [[markdownTarget, "_blank", "noopener,noreferrer"]]);
    assert.deepEqual(h.links, []);
  });
}

test("upstream #4: an incomplete desktop bridge uses the browser during the press", () => {
  const browser = [];
  const h = createToolHarness("web", { globals: { paseoDesktop: { opener: {} }, open: (...args) => browser.push(args) } });
  void h.load("client/components/open-link").openLink(markdownTarget);
  assert.deepEqual(browser, [[markdownTarget, "_blank", "noopener,noreferrer"]], "web opening retains synchronous user activation");
});

for (const platform of ["ios", "android"]) {
  test(`${platform} uses Linking even if browser globals are present`, async () => {
    const h = createToolHarness(platform, { globals: {
      paseoDesktop: { opener: { openUrl() { assert.fail("desktop bridge used on native"); } } },
      open() { assert.fail("browser used on native"); },
    } });
    await h.load("client/components/open-link").openLink(markdownTarget);
    assert.deepEqual(h.links, [markdownTarget]);
  });
}

test("upstream #4: unavailable URL handlers do not reject the press", async () => {
  const hosts = [
    createToolHarness("web", { globals: {} }),
    createToolHarness("web", { globals: { open() { throw new Error("Opening denied"); } } }),
    createToolHarness("ios", { openURL: () => Promise.reject(new Error("No handler")) }),
    createToolHarness("ios", { openURL() { throw new Error("Opening denied"); } }),
    createToolHarness("android", { openURL: () => Promise.reject(new Error("No handler")) }),
    createToolHarness("android", { openURL() { throw new Error("Opening denied"); } }),
  ];
  for (const h of hosts) await assert.doesNotReject(h.load("client/components/open-link").openLink(markdownTarget));
});

test("upstream #4: unsafe and malformed Markdown destinations never reach any opener", async () => {
  for (const platform of ["web", "ios", "android"]) {
    const opened = [];
    const h = createToolHarness(platform, { markdown: true, globals: {
      paseoDesktop: { opener: { openUrl: url => opened.push(url) } },
      open: url => opened.push(url),
    } });
    const tree = renderReply(h, "[Script](javascript:alert(1)) [File](file:///tmp/example) [Relative](/guide) [Data](data:text/plain,example)");
    assert.equal(linksIn(h, tree).length, 4);
    linksIn(h, tree).forEach(press);
    const openLink = h.load("client/components/open-link").openLink;
    for (const url of ["", "not a URL", "ftp://example.org/file", "tel:123"]) await openLink(url);
    assert.deepEqual(opened, []);
    assert.deepEqual(h.links, []);
  }
});

test("upstream #4: www URLs open as HTTPS, mailto links work, and code URLs stay literal", () => {
  const h = createToolHarness("ios", { markdown: true });
  const tree = renderReply(h, "www.example.org/guide, [Email](mailto:hello@example.org) and `https://example.org/code`.\n\n```text\nhttps://example.org/fenced\n```");
  const links = linksIn(h, tree);
  assert.equal(links.length, 2);
  links.forEach(press);
  assert.deepEqual(h.links, ["https://www.example.org/guide", "mailto:hello@example.org"]);
});
