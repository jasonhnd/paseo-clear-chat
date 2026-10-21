const { readFileSync, existsSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve, dirname, relative } = require("node:path");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

// Exercise the registered transformer, schema, live renderer and card bodies.
// Only the host runtime, animation, syntax painting and unrelated UI are shims.
function createToolHarness(platform = "ios") {
  const root = resolve(__dirname, "../..");
  const cache = new Map(), frames = new Map(), transformers = new Map(), renderers = new Map();
  const reveals = [], links = [];
  let frame;
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const passthrough = props => props.children ?? null;
  const noop = () => {};
  const cleanup = () => noop;
  const preferences = { enhancedUserBubble: true, assistantMarkdown: true };
  const tokens = new Proxy({ fs: n => n, boxShadow: {}, syntax: {}, isDark: true }, { get: (obj, key) => obj[key] ?? "#888888" });
  function next(initial) {
    const index = frame.cursor++;
    if (!(index in frame.values)) frame.values[index] = typeof initial === "function" ? initial() : initial;
    return index;
  }
  const react = {
    useState(initial) {
      const owner = frame, index = next(initial);
      return [owner.values[index], value => {
        owner.values[index] = typeof value === "function" ? value(owner.values[index]) : value;
      }];
    },
    useRef: value => frame.values[next(() => ({ current: value }))],
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useEffect(fn, deps) {
      const index = frame.cursor++;
      const previous = frame.values[index];
      if (!previous || deps?.some((value, i) => value !== previous[i])) {
        frame.values[index] = deps;
        fn();
      }
    },
  };
  class Value {
    constructor(value) { this.value = value; }
    interpolate() { return this.value; }
  }
  const native = {
    View: "View", Text: "Text", Pressable: "Pressable", Image: "Image", ScrollView: "ScrollView",
    Platform: { OS: platform }, StyleSheet: { create: value => value },
    Animated: { Value, View: "Animated.View", timing: () => ({ start: noop, stop: noop }) },
    Linking: { openURL: url => { links.push(url); return Promise.resolve(); } },
  };
  const stubs = {
    "client/preferences": { initializeEnhancerPreferences: async () => {}, areEnhancerPreferencesReady: () => true, getEnhancerPreferences: () => preferences, useEnhancerPreferences: () => preferences },
    "client/settings-page": { ClearChatSettingsPage: noop },
    "client/image-file": { useImageFile: noop, isImagePath: path => /\.(png|jpe?g|gif|webp)$/i.test(path ?? "") },
    "shared/file-rpc": { revealPathRpc: {} },
    "client/hub-activity": { publishHubSnapshot: noop },
    "client/timeline-tail": { useIsTimelineTail: () => false },
    "client/system-envelope": { parseSystemEnvelope: () => null },
    "client/components/embed-fonts": { embedFonts: cleanup },
    "client/components/frosted": { frosted: {}, installFrostedGlass: cleanup },
    "client/components/shimmer": { installShimmer: cleanup },
    "client/components/glow": { glowing: () => ({}), usePointerGlow: noop, installPointerGlow: cleanup },
    "client/components/host-notice": { installHostNoticeStyle: cleanup },
    "client/components/chat-find": { installChatFind: cleanup },
    "client/components/theme-tokens": { buildThemeTokens: () => tokens, radius: {} },
    "client/components/view-props": { surfaceProps: () => ({}) },
    "client/components/selection-actions": { useSelectionActions: noop, selectionCodeText: {}, selectionSurface: {} },
    "client/components/selection": { selectableSurface: {}, unselectable: {} },
    "client/components/host-font-escape": { hostFontEscape: {} },
    "client/components/prompt-anchor": { promptRowAnchor: () => ({}) },
    "client/components/glyph": { Glyph: props => jsx("Glyph", props) },
    "client/components/motion": { Rotate: passthrough, Glow: passthrough },
    "client/components/breathe": { Breathe: passthrough },
    "client/components/pulse-dot": { PulseDot: noop },
    "client/components/file-type-logo": { FileTypeLogo: noop },
    "client/components/image-preview": { ImagePreview: noop },
    "client/components/hub-live": { TimelineTailHub: noop },
    "client/components/reasoning-trace": { ReasoningTrace: noop },
    "client/components/user-message": { UserMessage: noop },
    "client/components/notice-callout": { NoticeCallout: noop },
    "client/components/markdown/markdown-view": { MarkdownView: noop },
    "client/components/turn-footer": { AssistantFooter: noop },
    "client/components/system-card": { SystemCard: noop },
    "client/components/hub-callout": { HubCallout: props => jsx("Text", { children: props.data.text ?? props.data.kind }) },
    "client/components/paseo-tool-callouts": { PaseoToolCallout: props => jsx("Text", { children: props.data.tool }) },
    "client/components/syntax-highlight": {
      renderTerminalOutput: text => text,
      SyntaxHighlightBlock: props => jsx("View", { children: [
        props.filename ? jsx("Pressable", { accessibilityLabel: `Reveal ${props.filename}`, onPress: props.onRevealFile, children: jsx("Text", { children: props.filename }) }) : null,
        jsx("Text", { children: props.code }),
      ] }),
    },
  };
  function load(path) {
    let filename = resolve(root, path);
    if (!existsSync(filename)) filename += existsSync(filename + ".ts") ? ".ts" : ".tsx";
    const key = relative(root, filename).replace(/\.tsx?$/, "");
    if (key in stubs) return stubs[key];
    if (cache.has(filename)) return cache.get(filename).exports;
    const mod = { exports: {} }; cache.set(filename, mod);
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const localRequire = id => {
      if (id === "react") return react;
      if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (id === "react-native") return native;
      if (id === "@getpaseo/plugin/client") return {
        useRpc: () => async value => { reveals.push(value); return {}; },
        useAgent: (_, selector) => selector({ cwd: "/workspace/demo" }),
      };
      if (id === "@getpaseo/plugin/client/react-native") return { useRevealedText: text => text };
      if (id.startsWith(".")) return load(resolve(dirname(filename), id));
      return createRequire(filename)(id);
    };
    runInThisContext(`(function(require,module,exports){${source}\n})`, { filename })(localRequire, mod, mod.exports);
    return mod.exports;
  }
  load("index.client.tsx").default({
    rpc: noop,
    addSettingsScreen: cleanup,
    addTimelineTransformer(value) { transformers.set(value.query.itemType, value); return noop; },
    addTimelineRenderer(value) { renderers.set(value.kind, value); return noop; },
  });
  function draw(element, path = "root") {
    if (Array.isArray(element)) return element.map((child, i) => draw(child, `${path}.${i}`));
    if (!element || typeof element !== "object") return element;
    if (typeof element.type === "function") {
      const key = `${path}:${element.type.name}`;
      const owner = frames.get(key) ?? { values: [], cursor: 0 };
      frames.set(key, owner); owner.cursor = 0;
      const parent = frame; frame = owner;
      const result = element.type(element.props); frame = parent;
      return draw(result, `${key}.child`);
    }
    return { ...element, props: { ...element.props, children: draw(element.props.children, `${path}.children`) } };
  }
  function nodes(tree, predicate) {
    if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
    if (!tree || typeof tree !== "object") return [];
    return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
  }
  function text(tree) {
    if (Array.isArray(tree)) return tree.map(text).filter(Boolean).join("\n");
    if (tree === undefined || tree === null || typeof tree === "boolean") return "";
    if (typeof tree !== "object") return String(tree);
    return text(tree.props?.children);
  }
  return {
    load, nodes, text, reveals, links, transformers, renderers,
    mount(item, expand = true) {
      frames.clear(); reveals.length = links.length = 0;
      const transformed = transformers.get(item.type).transform({ item, phase: "complete" });
      const pluginItem = transformed.items[0];
      const renderer = renderers.get(pluginItem.kind);
      const data = renderer.schema.parse(pluginItem.data);
      const render = () => draw(jsx(renderer.Component, { agentId: "demo-agent", item: { ...pluginItem, data }, theme: { colors: {} }, timestamp: new Date("2026-01-01T12:00:00Z") }));
      let tree = render();
      if (expand) {
        const button = nodes(tree, node => node.type === "Pressable" && node.props.accessibilityState?.expanded === false)[0];
        button?.props.onPress();
        tree = render();
      }
      return { tree, render, data };
    },
  };
}

module.exports = { createToolHarness };
