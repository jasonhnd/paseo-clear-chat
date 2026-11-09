const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve, dirname } = require("node:path");
const { runInThisContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// Run the actual components/handlers, with native primitives and hooks supplied
// by a tiny host. No navigator exists: a native copy must go through the SDK.
function harness(file, name, copyText, platform = "ios", scale = 1, browserWindow) {
  const state = [], timers = new Map(), cleanups = [], calls = [], toasts = [], effects = new Map();
  let cursor = 0, timerId = 0;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in state)) state[i] = typeof initial === "function" ? initial() : initial;
      return [state[i], value => { state[i] = typeof value === "function" ? value(state[i]) : value; }];
    },
    useRef(value) {
      const i = cursor++;
      return state[i] ??= { current: value };
    },
    useMemo: fn => fn(), useCallback: fn => fn,
    useEffect(fn, deps) {
      const i = cursor++, previous = effects.get(i);
      if (previous && deps && deps.every((value, index) => Object.is(value, previous.deps?.[index]))) return;
      previous?.cleanup?.();
      const entry = { deps, cleanup: fn() };
      effects.set(i, entry);
      if (entry.cleanup) cleanups.push(() => { if (effects.get(i) === entry) { entry.cleanup(); effects.delete(i); } });
    },
  };
  const translations = require("./helpers/translations.cjs").createTranslations(react);
  const sdk = {
    copyText(text) { calls.push(text); return copyText(text); },
    useToast: () => ({ show: (message, options) => toasts.push({ message, ...options }), error: message => toasts.push({ message, variant: "error" }) }),
    Modal: Object.assign(props => ({ type: "Modal", props }), { Content: "Modal.Content" }), TextInput: "SDK.TextInput",
  };
  const cache = new Map();
  function load(path) {
    let filename = resolve(__dirname, "..", path);
    if (filename.endsWith(".json")) return JSON.parse(readFileSync(filename, "utf8"));
    if (!/\.[jt]sx?$/.test(filename)) filename += ".ts";
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} }; cache.set(filename, mod);
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const localRequire = id => {
      if (id === "react") return react;
      if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "Fragment" };
      if (id === "react-native") return { View: "View", Text: "Text", ScrollView: "ScrollView", Pressable: "Pressable", Image: "Image", Modal: "Modal", Platform: { OS: platform }, StyleSheet: { create: x => x }, useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }) };
      if (id === "@getpaseo/plugin/client/ui") return sdk;
      if (id === "@getpaseo/plugin/client") return { ...translations, useRpc: () => async () => ({ images: [], total: 0, reason: null }) };
      if (id.endsWith("/messages") || id.endsWith("/translation") || id.endsWith(".json")) return load(resolve(dirname(filename), id));
      if (id === "./copy-feedback") return load(resolve(dirname(filename), id + ".tsx"));
      if (id === "./use-coarse-pointer") return load(resolve(dirname(filename), id + ".ts"));
      if (id === "./theme-tokens" || id === "../theme-tokens") return { radius: {}, withAlpha: value => value };
      if (id === "./parse") return load(resolve(dirname(filename), "parse.ts"));
      if (id === "../../generated-images") return load(resolve(dirname(filename), id + ".ts"));
      if (id === "../highlight") return { useHighlightedLines: () => null };
      if (id.startsWith(".")) return new Proxy({}, { get: (_, key) => key === "surfaceProps" ? () => ({}) : key === "detectFileType" ? () => ({}) : key });
      return createRequire(filename)(id);
    };
    runInThisContext(`(function(require,module,exports,setTimeout,clearTimeout,navigator,window){${source}\n})`, { filename })(
      localRequire, mod, mod.exports, fn => { timers.set(++timerId, fn); return timerId; }, id => timers.delete(id), undefined, browserWindow,
    );
    return mod.exports;
  }
  const Component = load(file)[name];
  const tokens = new Proxy({ fs: n => Math.round(n * scale * 2) / 2, textScale: scale }, { get: (o, k) => o[k] ?? (k === "syntax" ? {} : "#aaaaaa") });
  const text = "Full text\n日本語 / 中文\n```ts\nconst a = 1;\n```\n  ";
  const props = { text, code: text, language: "typescript", tokens, at: new Date() };
  function render() { cursor = 0; return Component(props); }
  function nodes(tree, predicate) {
    if (!tree || typeof tree !== "object") return [];
    if (Array.isArray(tree)) return tree.flatMap(t => nodes(t, predicate));
    if (typeof tree.type === "function") return nodes(tree.type(tree.props), predicate);
    return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
  }
  return { render, nodes, calls, toasts, text, props, timers, cleanups };
}

const components = [
  ["client/components/turn-footer.tsx", "AssistantFooter", "Copy reply"],
  ["client/components/user-message.tsx", "UserMessage", "Copy prompt"],
  ["client/components/syntax-highlight.tsx", "SyntaxHighlightBlock", "Copy code"],
];
test("syntax preview copies the complete source supplied by the tool output fold", async () => {
  const h = harness("client/components/syntax-highlight.tsx", "SyntaxHighlightBlock", async () => {});
  h.props.copyText = h.text;
  h.props.code = "A folded preview";
  const button = h.nodes(h.render(), n => n.type === "Pressable" && n.props.accessibilityLabel === "Copy code")[0];
  await button.props.onPress();
  assert.deepEqual(h.calls, [h.text]);
});
for (const [file, name, label] of components) {
  test(`${name}: native press copies verbatim, reports success only after SDK resolves`, async () => {
    let finish;
    const h = harness(file, name, () => new Promise(resolve => { finish = resolve; }));
    const button = h.nodes(h.render(), n => n.type === "Pressable" && n.props.accessibilityLabel === label)[0];
    assert.ok(button, "accessible copy control exists");
    const style = Object.assign({}, ...[button.props.style].flat());
    assert.ok(style.minWidth >= 44 && style.minHeight >= 44, "native touch target is at least 44 points");
    const pending = button.props.onPress();
    assert.deepEqual(h.calls, [h.text]);
    assert.equal(h.toasts.length, 0);
    finish(); await pending;
    assert.equal(h.toasts[0]?.variant, "success");
    assert.match(h.toasts[0]?.message, /copied/i);
    assert.equal(h.nodes(h.render(), n => n.type === "Modal").length, 0);
  });
  for (const synchronous of [false, true]) {
    test(`${name}: ${synchronous ? "throw" : "rejection"} shows error and readonly full-text fallback`, async () => {
      const h = harness(file, name, () => { if (synchronous) throw new Error("Unavailable"); return Promise.reject(new Error("Denied")); });
      const button = h.nodes(h.render(), n => n.type === "Pressable" && n.props.accessibilityLabel === label)[0];
      assert.ok(button);
      await button.props.onPress();
      assert.deepEqual(h.calls, [h.text]);
      assert.equal(h.toasts[0]?.variant, "error");
      assert.match(h.toasts[0]?.message, /could not copy/i);
      assert.equal(h.toasts.some(t => t.variant === "success"), false);
      const tree = h.render();
      const modal = h.nodes(tree, n => n.type === "Modal")[0];
      assert.equal(modal?.props.open, true);
      const input = h.nodes(tree, n => n.type === "SDK.TextInput")[0];
      assert.equal(input?.props.value, h.text, "includes unicode, markdown and trailing whitespace");
      assert.equal(input?.props.multiline, true);
      assert.equal(input?.props.readOnly, true);
      assert.equal(input?.props.selectTextOnFocus, true);
      h.props.text = h.props.code = "Changed during streaming";
      assert.equal(h.nodes(h.render(), n => n.type === "SDK.TextInput")[0]?.props.value, h.text, "fallback keeps the pressed text");
      modal.props.onOpenChange(false);
      assert.equal(h.nodes(h.render(), n => n.type === "Modal").length, 0);
    });
  }
}


for (const [file, name] of components) {
  test(`${name}: Large and XL enlarge visible text and line heights without enlarging icons`, () => {
    const rendered = scale => {
      const h = harness(file, name, async () => {}, "ios", scale);
      const tree = h.render();
      const styles = h.nodes(tree, n => n.type === "Text").map(n => Object.assign({}, ...[n.props.style].flat())).filter(s => s.fontSize);
      const icons = h.nodes(tree, n => n.type === "Glyph").map(n => n.props.size);
      return { styles, icons };
    };
    const base = rendered(1);
    assert.ok(base.styles.length > 0);
    assert.ok(base.icons.length > 0);
    for (const scale of [1.15, 1.3]) {
      const large = rendered(scale);
      assert.deepEqual(large.icons, base.icons);
      assert.equal(large.styles.length, base.styles.length);
      large.styles.forEach((style, i) => {
        assert.ok(style.fontSize > base.styles[i].fontSize);
        if (base.styles[i].lineHeight) assert.ok(style.lineHeight > base.styles[i].lineHeight);
      });
    }
  });
}

for (const variant of ["document", "compact", "terminal"]) {
  test(`markdown ${variant}: body, heading and line heights scale, task icon stays the same size`, () => {
    const rendered = scale => {
      const h = createToolHarness("ios", { markdown: true, preferences: { markdownVariant: variant, textScale: scale } });
      const { tree } = h.mount({ type: "assistant_message", text: "# Heading\n\nBody text\n\n- [x] Task text" });
      const styles = h.nodes(tree, n => n.type === "Text").map(n => Object.assign({}, ...[n.props.style].flat())).filter(s => s.fontSize);
      return { styles, icons: h.nodes(tree, n => n.type === "Glyph").map(n => n.props.size) };
    };
    const base = rendered(1);
    assert.ok(base.styles.length >= 3);
    assert.ok(base.icons.length > 0);
    for (const scale of [1.15, 1.3]) {
      const large = rendered(scale);
      assert.deepEqual(large.icons, base.icons);
      large.styles.forEach((style, i) => {
        assert.ok(style.fontSize > base.styles[i].fontSize);
        if (base.styles[i].lineHeight) assert.ok(style.lineHeight > base.styles[i].lineHeight);
      });
    }
  });
}

function mediaQuery(initial) {
  const listeners = new Set();
  return { matches: initial, listeners,
    addEventListener(type, listener) { assert.equal(type, "change"); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "change"); listeners.delete(listener); },
    change(matches) { this.matches = matches; for (const listener of listeners) listener({ matches }); },
  };
}

for (const [file, name, label] of [components[0], components[2]]) {
  for (const [platform, coarse, expected] of [["web", true, 44], ["web", false, undefined], ["ios", true, 44], ["ios", false, 44]]) {
    test(`${name}: ${platform} ${coarse ? "coarse" : "fine"} copy target`, () => {
      const query = mediaQuery(coarse);
      const h = harness(file, name, async () => {}, platform, 1, { matchMedia: value => { assert.equal(value, "(pointer: coarse)"); return query; } });
      const button = h.nodes(h.render(), n => n.type === "Pressable" && n.props.accessibilityLabel === label)[0];
      const style = Object.assign({}, ...[button.props.style].flat());
      assert.equal(style.minWidth, expected);
      assert.equal(style.minHeight, expected);
    });
  }
}

test("coarse pointer hook reads, updates and cleans up the media query", () => {
  const query = mediaQuery(true);
  const h = harness("client/components/use-coarse-pointer.ts", "useCoarsePointer", async () => {}, "web", 1, { matchMedia: () => query });
  assert.equal(h.render(), true);
  query.change(false);
  assert.equal(h.render(), false);
  h.cleanups.forEach(cleanup => cleanup());
  assert.equal(query.listeners.size, 0);
  for (const browserWindow of [undefined, {}, { matchMedia: () => mediaQuery(false) }]) {
    const other = harness("client/components/use-coarse-pointer.ts", "useCoarsePointer", async () => {}, "web", 1, browserWindow);
    assert.equal(other.render(), false);
    other.cleanups.forEach(cleanup => cleanup());
  }
});

for (const [file, name, label] of [components[0], components[2]]) {
  test(`${name}: target follows pointer changes`, () => {
    const query = mediaQuery(false);
    const h = harness(file, name, async () => {}, "web", 1, { matchMedia: () => query });
    const style = () => Object.assign({}, ...[h.nodes(h.render(), n => n.type === "Pressable" && n.props.accessibilityLabel === label)[0].props.style].flat());
    assert.equal(style().minHeight, undefined);
    query.change(true);
    assert.equal(style().minHeight, 44);
    query.change(false);
    assert.equal(style().minHeight, undefined);
    h.cleanups.forEach(cleanup => cleanup());
    assert.equal(query.listeners.size, 0);
  });
}

test("unrelated prompt copy retains its web target", () => {
  const query = mediaQuery(true);
  const h = harness(components[1][0], components[1][1], async () => {}, "web", 1, { matchMedia: () => query });
  const button = h.nodes(h.render(), n => n.type === "Pressable" && n.props.accessibilityLabel === "Copy prompt")[0];
  const style = Object.assign({}, ...[button.props.style].flat());
  assert.equal(style.minWidth, undefined);
  assert.equal(style.minHeight, undefined);
});
