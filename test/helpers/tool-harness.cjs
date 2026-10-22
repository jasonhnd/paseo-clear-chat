const { readFileSync, existsSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve, dirname, relative } = require("node:path");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");
const { createExpansionHost } = require("./expansion-host.cjs");

// Exercise the registered transformer, schema, live renderer and card bodies.
// Only the host runtime, animation, syntax painting and unrelated UI are shims.
function createToolHarness(platform = "ios", options = {}) {
  const root = resolve(__dirname, "../..");
  const cache = new Map(), frames = new Map(), transformers = options.timelineHost?.transformers ?? new Map(), renderers = options.timelineHost?.renderers ?? new Map(), panels = new Map();
  const panelOpens = [];
  const dimensions = { width: options.width ?? 1440, height: options.height ?? 900, scale: 1, fontScale: 1, ...options.dimensions };
  let activePanel;
  const reveals = [], links = [], copies = [], toasts = [], imageReads = [];
  let frame;
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const passthrough = props => props.children ?? null;
  const noop = () => {};
  const cleanup = () => noop;
  // Body replays exercise inline cards; detail/gesture suites opt into details explicitly.
  const preferences = { enhancedUserBubble: true, assistantMarkdown: true, markdownVariant: "document", textScale: 1, foldFinishedSteps: true, foldLongOutputAfter: 15, collapsedStepAction: "inline", ...options.preferences };
  const getPreferences = () => options.presentationHost ? load("client/preferences.ts").getEnhancerPreferences() : preferences;
  const expansionHost = options.expansionHost ?? createExpansionHost();
  const rpcFunctions = new Map();
  const timestamps = new WeakMap();
  let nextTimestamp = Date.parse("2026-01-01T12:00:00Z");
  const paseo = options.paseo ?? { agents: { ref: () => ({ refresh: async () => null }) } };
  const tokens = new Proxy({ fs: n => Math.round(n * getPreferences().textScale * 2) / 2, get textScale() { return getPreferences().textScale; }, boxShadow: {}, syntax: {}, isDark: true }, { get: (obj, key) => obj[key] ?? "#888888" });
  function next(initial) {
    const index = frame.cursor++;
    if (!(index in frame.values)) frame.values[index] = typeof initial === "function" ? initial() : initial;
    return index;
  }
  const react = {
    createContext(value) {
      const context = { current: value };
      context.Provider = { context };
      return context;
    },
    useContext: context => context.current,
    useState(initial) {
      const owner = frame, index = next(initial);
      return [owner.values[index], value => {
        owner.values[index] = typeof value === "function" ? value(owner.values[index]) : value;
      }];
    },
    useRef: value => frame.values[next(() => ({ current: value }))],
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useSyncExternalStore: (_, getSnapshot) => getSnapshot(),
    useEffect(fn, deps) {
      const owner = frame;
      const index = frame.cursor++;
      const previous = frame.values[index];
      if (!previous || deps?.some((value, i) => value !== previous[i])) {
        owner.effects.get(index)?.();
        frame.values[index] = deps;
        owner.effects.set(index, fn());
      }
    },
  };
  class Value {
    constructor(value) { this.value = value; }
    interpolate() { return this.value; }
  }
  const native = {
    View: "View", Text: "Text", Pressable: "Pressable", Image: "Image", ScrollView: "ScrollView",
    FlatList: props => jsx("Native.FlatList", { ...props, children: [props.ListHeaderComponent,
      props.data.slice(0, props.initialNumToRender ?? 10).map((item, index) => props.renderItem({ item, index })),
      props.ListFooterComponent] }),
    SafeAreaView: "SafeAreaView",
    Modal: props => props.visible ? jsx("Native.Modal", props) : null,
    useWindowDimensions: () => {
      if (options.width !== undefined) dimensions.width = options.width;
      if (options.height !== undefined) dimensions.height = options.height;
      return dimensions;
    },
    PanResponder: { create: handlers => ({ panHandlers: {
      onMoveShouldSetResponder: handlers.onMoveShouldSetPanResponder,
      onResponderGrant: handlers.onPanResponderGrant,
      onResponderMove: handlers.onPanResponderMove,
      onResponderRelease: handlers.onPanResponderRelease,
      onResponderTerminate: handlers.onPanResponderTerminate,
    } }) },
    Platform: { OS: platform, isPad: options.isPad ?? false }, StyleSheet: { create: value => value },
    Animated: { Value, View: "Animated.View", timing: () => ({ start: noop, stop: noop }) },
    Linking: { openURL: (...args) => { links.push(args[0]); return options.openURL?.(...args) ?? Promise.resolve(); } },
  };
  const stubs = {
    "client/preferences": { initializeEnhancerPreferences: async () => {}, areEnhancerPreferencesReady: () => true, getEnhancerPreferences: () => preferences, useEnhancerPreferences: () => preferences, useEnhancerPreferencesError: () => null, updateEnhancerPreferences: async patch => Object.assign(preferences, patch), resetEnhancerPreferences: async () => {}, OUTPUT_LINE_OPTIONS: [10, 15, 30, "never"].map(value => ({ value: String(value), label: value === "never" ? "Never" : `${value} lines` })), TEXT_SIZE_OPTIONS: [], ACCENT_PRESETS: {} },
    "client/settings-page": { ClearChatSettingsPage: noop },
    "server/settings-migration": { migrateHostSettings: noop },
    "client/image-file": { useImageFile: noop, isImagePath: path => /\.(png|jpe?g|gif|webp)$/i.test(path ?? "") },
    "shared/file-rpc": { revealPathRpc: { name: "file.reveal" } },
    "client/hub-activity": { publishHubSnapshot: noop },
    "client/timeline-tail": { useIsTimelineTail: () => options.timelineTail ?? false },
    "client/system-envelope": { parseSystemEnvelope: () => null },
    "client/components/embed-fonts": { embedFonts: cleanup },
    "client/components/frosted": { frosted: {}, installFrostedGlass: cleanup },
    "client/components/shimmer": { installShimmer: cleanup },
    "client/components/glow": { glowing: () => ({}), usePointerGlow: noop, installPointerGlow: cleanup },
    "client/components/host-notice": { installHostNoticeStyle: cleanup },
    "client/components/chat-find": { installChatFind: cleanup },
    "client/components/theme-tokens": { buildThemeTokens: () => tokens, radius: {}, withAlpha: color => color },
    "client/components/selection-actions": { useSelectionActions: noop, selectionCodeText: {}, selectionSurface: {} },
    "client/components/selection": { selectableSurface: {}, unselectable: {} },
    "client/components/host-font-escape": { hostFontEscape: {} },
    "client/components/prompt-anchor": { promptRowAnchor: () => ({}) },
    "client/components/glyph": { Glyph: props => jsx("Glyph", props) },
    "client/components/motion": { Rotate: passthrough, Glow: passthrough, Pop: passthrough },
    "client/components/breathe": { Breathe: passthrough },
    "client/components/pulse-dot": { PulseDot: noop },
    "client/components/tool-spinner": { ToolSpinner: props => jsx("Spinner", { accessibilityLabel: "Running", ...props }) },
    "client/components/file-type-logo": { FileTypeLogo: noop, detectFileType: () => "generic" },
    "client/components/image-preview": { ImagePreview: noop },
    "client/components/hub-live": { TimelineTailHub: noop },
    "client/components/reasoning-trace": { ReasoningTrace: noop },
    "client/components/user-message": { UserMessage: noop },
    "client/components/notice-callout": { NoticeCallout: noop },
    "client/components/markdown/markdown-view": { MarkdownView: props => jsx("Text", { children: props.text }) },
    "client/components/turn-footer": { AssistantFooter: noop },
    "client/components/system-card": { SystemCard: noop },
    "client/components/hub-callout": { HubCallout: props => jsx("Text", { children: props.data.text ?? props.data.kind }) },
    "client/components/paseo-tool-callouts": { PaseoToolCallout: props => jsx("Text", { children: props.data.tool }) },
    "client/components/syntax-highlight": {
      renderTerminalOutput: text => text,
      SyntaxHighlightBlock: props => jsx("View", { testID: "syntax-block", code: props.code, copyText: props.copyText, children: [
        props.filename ? jsx("Pressable", { accessibilityLabel: `Reveal ${props.filename}`, onPress: props.onRevealFile, children: jsx("Text", { children: props.filename }) }) : null,
        jsx("Text", { children: props.code }),
      ] }),
    },
  };
  if (options.realSelection) delete stubs["client/components/selection"];
  if (options.settingsPage) delete stubs["client/settings-page"];
  if (options.themeTokens) delete stubs["client/components/theme-tokens"];
  if (options.fonts) delete stubs["client/components/embed-fonts"];
  if (options.presentationHost) delete stubs["client/preferences"];
  if (options.markdown) delete stubs["client/components/markdown/markdown-view"];
  if (options.syntax) {
    delete stubs["client/components/syntax-highlight"];
    stubs["client/highlight"] = { useHighlightedLines: () => null };
  }
  if (options.userMessage) delete stubs["client/components/user-message"];
  if ((options.syntax || options.userMessage) && !options.copyFeedback) {
    stubs["client/components/copy-feedback"] = {
      useCopyText: () => ({ copied: false, handleCopy: noop, fallbackText: null, setFallbackText: noop }),
      CopyFallbackDialog: noop, copyTouchTarget: {},
    };
  }
  if (options.replyFooter) delete stubs["client/components/turn-footer"];
  if (options.images) {
    delete stubs["client/image-file"];
    delete stubs["client/components/image-preview"];
  }
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
        useRpc: contract => {
          if (contract.name === "file.image") {
            if (!rpcFunctions.has(contract.name)) rpcFunctions.set(contract.name, async value => {
              imageReads.push(value);
              return options.imageRpc ? options.imageRpc(value) : {
                dataUri: "data:image/png;base64,c2FtcGxl", mime: "image/png", width: 32, height: 24, bytes: 6, error: null,
              };
            });
            return rpcFunctions.get(contract.name);
          }
          if (contract.name?.startsWith("settings.tool-expansion.")) {
            if (!rpcFunctions.has(contract.name)) rpcFunctions.set(contract.name,
              contract.name.endsWith(".read") ? expansionHost.read : expansionHost.write);
            return rpcFunctions.get(contract.name);
          }
          return async value => { reveals.push(value); return options.revealRpc ? options.revealRpc(value) : { revealed: value.path, error: null }; };
        },
        useAgent: (_, selector) => selector(options.agent ?? { cwd: "/workspace/demo", workspaceId: "demo-workspace" }),
        usePaseo: () => paseo,
      };
      if (id === "@getpaseo/plugin/client/react-native") return {
        useRevealedText: text => text,
        copyText: async text => { copies.push(text); await options.copyText?.(text); },
        useToast: () => ({ show: message => toasts.push(message), error: message => toasts.push(message) }),
        Modal: Object.assign(passthrough, { Content: "Modal.Content" }),
        TextInput: "SDK.TextInput",
      };
      if (id.startsWith(".")) return load(resolve(dirname(filename), id));
      return options.modules?.[id] ?? createRequire(filename)(id);
    };
    runInThisContext(`(function(require,module,exports,globalThis){${source}\n})`, { filename })(localRequire, mod, mod.exports, options.globals ?? globalThis);
    return mod.exports;
  }
  const dispose = load("index.client.tsx").default({
    rpc: options.presentationHost?.rpc ?? noop,
    addSettingsScreen: cleanup,
    addWorkspacePanel(value) { panels.set(value.id, value); return noop; },
    openPanel(id, input) {
      if (options.panelError) throw new Error("Panel unavailable");
      panelOpens.push({ id, ...input });
      activePanel = { id, ...input };
    },
    addTimelineTransformer(value) {
      if (options.timelineHost) return options.timelineHost.addTimelineTransformer(value);
      transformers.set(value.query.itemType, value); return noop;
    },
    addTimelineRenderer(value) {
      if (options.timelineHost) return options.timelineHost.addTimelineRenderer(value);
      renderers.set(value.kind, value); return noop;
    },
  });
  function draw(element, path = "root") {
    if (Array.isArray(element)) return element.map((child, i) => draw(child, `${path}.${i}`));
    if (!element || typeof element !== "object") return element;
    if (element.type?.context) {
      const context = element.type.context, previous = context.current;
      context.current = element.props.value;
      try { return draw(element.props.children, `${path}.provider`); }
      finally { context.current = previous; }
    }
    if (typeof element.type === "function") {
      const key = `${path}:${element.type.name}`;
      const owner = frames.get(key) ?? { values: [], cursor: 0, effects: new Map() };
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
  function unmount() {
    for (const owner of frames.values()) {
      for (const effect of owner.effects.values()) effect?.();
    }
    frames.clear();
  }
  return {
    load, nodes, text, reveals, links, copies, toasts, imageReads, transformers, renderers, panels, panelOpens, dimensions, get preferences() { return getPreferences(); }, tokens, draw, expansionHost, unmount, dispose,
    mount(item, expand = true, identity = {}) {
      unmount(); reveals.length = links.length = copies.length = imageReads.length = 0;
      if (!timestamps.has(item)) timestamps.set(item, new Date(nextTimestamp++));
      const transformed = transformers.get(item.type).transform({ item, phase: "complete" });
      const pluginItem = transformed.items[0];
      const renderer = renderers.get(pluginItem.kind);
      const data = renderer.schema.parse(pluginItem.data);
      const render = (nextData = data) => {
        const props = { agentId: "demo-agent", host: { id: "demo-host" }, item: { ...pluginItem, data: nextData }, theme: { colors: options.themeColors ?? {} }, timestamp: timestamps.get(item), ...identity };
        const row = draw(jsx(renderer.Component, props));
        const panel = panels.get(activePanel?.id);
        return panel ? [row, draw(jsx(panel.Component, { ...props, ...activePanel, context: "agent" }), "panel")] : row;
      };
      let tree = render();
      if (expand) {
        const button = nodes(tree, node => node.props.testID === "tool-summary-row" && node.props.accessibilityState?.expanded === false)[0];
        button?.props.onPress();
        tree = render();
      }
      return { tree, render, data };
    },
  };
}

module.exports = { createToolHarness };
