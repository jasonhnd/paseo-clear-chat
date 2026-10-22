const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const fixture = require("./fixtures/real-hermes-session.json");
const capturedHover = require("./fixtures/real-hermes-hover.json");

const calls = fixture.items.filter(item => item.type === "tool_call");
const find = (h, tree) => h.nodes(tree, node => node.props.testID === "tool-summary-row")[0];

function hoverDocument(width = 1440, mouse = true) {
  const timers = new Map(), listeners = new Map();
  let now = 0, serial = 0;
  class Element {
    constructor(tag) { this.tagName = tag; this.style = {}; this.children = []; this.attributes = {}; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    get isConnected() { return this === doc.body || Boolean(this.parentNode?.isConnected); }
    get textContent() { return (this.text ?? "") + this.children.map(child => child.textContent).join("\n"); }
    set textContent(value) { this.text = value; this.children = []; }
    getBoundingClientRect() { return this.rect ?? { left: 0, right: 420, top: 0, bottom: 142, width: 420, height: 142 }; }
  }
  const media = {
    get matches() { return doc.defaultView.innerWidth >= 1024 && mouse; },
    addEventListener: (type, fn) => on(`media:${type}`, fn),
    removeEventListener: (type, fn) => off(`media:${type}`, fn),
  };
  function on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }
  function off(type, fn) { listeners.get(type)?.delete(fn); }
  const doc = {
    body: new Element("body"),
    createElement: tag => new Element(tag),
    addEventListener: on, removeEventListener: off,
    defaultView: {
      innerWidth: width, innerHeight: 900, matchMedia: () => media,
      setTimeout(fn, delay) { timers.set(++serial, { fn, at: now + delay }); return serial; },
      clearTimeout: id => timers.delete(id),
      addEventListener: on, removeEventListener: off,
    },
  };
  const target = doc.body.appendChild(new Element("button"));
  target.rect = { left: 40, right: width - 40, top: 360, bottom: 382, width: width - 80, height: 22 };
  return {
    doc, target, timers,
    preview: () => doc.body.children.find(child => child.getAttribute("data-testid") === "tool-hover-preview"),
    tick(ms) {
      now += ms;
      for (const [id, job] of timers) if (job.at <= now) { timers.delete(id); job.fn(); }
    },
    emit(type) { for (const fn of [...listeners.get(type) ?? []]) fn({}); },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

function mount(width = 1440, platform = "web", mouse = true, item = calls[0], options = {}) {
  const dom = hoverDocument(width, mouse);
  const h = createToolHarness(platform, { ...options, width, globals: { document: dom.doc } });
  const mounted = h.mount(item, false);
  const row = find(h, mounted.tree);
  const enter = (pointerType = "mouse") => row.props.onPointerEnter?.({
    currentTarget: dom.target, nativeEvent: { pointerType, clientX: 200, clientY: 370 },
  });
  return { ...dom, h, mounted, row, enter };
}

const themes = {
  light: { surface0: "#ffffff", foreground: "#17171a", foregroundMuted: "#62656c", accent: "#365fbd", accentForeground: "#ffffff", statusDanger: "#bb2233" },
  dark: { surface0: "#0f0f11", foreground: "#f2f3f5", foregroundMuted: "#a3a6ad", accent: "#7aa2f7", accentForeground: "#0f0f11", statusDanger: "#f2555a" },
};

for (const [theme, colors] of Object.entries(themes)) {
  for (const frostedGlass of [false, true]) {
    test(`${theme} hover uses an opaque theme surface with glass ${frostedGlass}`, () => {
      const m = mount(1440, "web", true, capturedHover.items[2], {
        themeTokens: true, themeColors: colors, preferences: { frostedGlass },
      });
      m.enter(); m.tick(300);
      const preview = m.preview();
      assert.ok(preview);
      const background = preview.style.backgroundColor ?? preview.style.background;
      const alpha = background.startsWith("rgba(") ? Number(background.slice(5, -1).split(",")[3]) : 1;
      assert.equal(alpha, 1);
      assert.equal(background, colors.surface0);
      assert.ok(preview.style.border);
      assert.ok(preview.style.boxShadow);
      m.h.unmount();
    });
  }
}

test("the captured read envelope shows the path and every short result line", () => {
  const m = mount(1440, "web", true, capturedHover.items[2]);
  m.enter(); m.tick(300);
  const preview = m.preview();
  assert.match(preview.textContent, /\/workspace\/sample\/src\/sample\.js/);
  assert.equal(preview.children.at(-1).textContent,
    "1|export function sampleTotal(items) {\n2|  return items.reduce((sum, item) => sum + item.cost, 0);\n3|}");
  m.h.unmount();
});

for (const name of ["read", "read_file"]) {
  test(`${name} keeps six result lines and marks omitted lines`, () => {
    const item = { ...capturedHover.items[2], name, detail: {
      type: "read", filePath: "/workspace/sample/src/sample.js",
      content: Array.from({ length: 8 }, (_, i) => `Result line ${i + 1}`).join("\n"),
    } };
    const m = mount(1440, "web", true, item);
    m.enter(); m.tick(300);
    assert.equal(m.preview().children.at(-1).textContent,
      "Result line 1\nResult line 2\nResult line 3\nResult line 4\nResult line 5\nResult line 6\n…");
    m.h.unmount();
  });
}

for (const width of [1440, 1024]) {
  test(`a collapsed step at ${width}px previews after 300ms and clears on leave`, () => {
    const m = mount(width);
    assert.equal(typeof m.row.props.onPointerEnter, "function");
    m.enter();
    m.tick(299);
    assert.equal(m.preview(), undefined);
    m.tick(1);
    const preview = m.preview();
    assert.ok(preview);
    assert.match(preview.textContent, /\$ git log/);
    assert.match(preview.textContent, /Sample text line 1\./);
    assert.match(preview.textContent, /Sample text line 6\./);
    assert.doesNotMatch(preview.textContent, /Sample text line 7\./);
    assert.equal(preview.style.pointerEvents, "none");
    assert.equal(m.row.props.accessibilityState.expanded, false);
    assert.equal(m.h.expansionHost.calls.filter(call => call.name === "write").length, 0);
    m.row.props.onPointerLeave();
    assert.equal(m.preview(), undefined);
    m.h.unmount();
    assert.equal(m.listenerCount(), 0);
  });
}

for (const width of [820, 390]) {
  test(`${width}px never starts a hover preview`, () => {
    const m = mount(width);
    m.enter(); m.tick(1000);
    assert.equal(m.preview(), undefined);
    assert.equal(m.timers.size, 0);
    m.h.unmount();
  });
}

for (const [label, platform, width] of [["iOS", "ios", 390], ["iPadOS", "ios", 1440], ["Android", "android", 1024], ["touch web", "web", 1440]]) {
  test(`${label} does not preview without a mouse`, () => {
    const m = mount(width, platform, false);
    m.enter(); m.tick(1000);
    assert.equal(m.preview(), undefined);
    assert.equal(m.timers.size, 0);
    m.h.unmount();
  });
}

for (const pointer of ["touch", "pen", ""]) {
  test(`${pointer || "synthetic"} input cannot preview on a desktop with a mouse`, () => {
    const m = mount();
    m.enter(pointer); m.tick(1000);
    assert.equal(m.preview(), undefined);
    assert.equal(m.timers.size, 0);
    m.h.unmount();
  });
}

test("a short visit and unmount cancel pending work", () => {
  const m = mount();
  assert.equal(typeof m.row.props.onPointerLeave, "function");
  m.enter(); m.tick(100); m.row.props.onPointerLeave(); m.tick(1000);
  assert.equal(m.preview(), undefined);
  m.enter(); m.h.unmount(); m.tick(1000);
  assert.equal(m.preview(), undefined);
  assert.equal(m.timers.size, 0);
  assert.equal(m.listenerCount(), 0);
});

for (const event of ["scroll", "resize", "blur", "pointerdown", "keydown", "media:change"]) {
  for (const delay of [100, 300]) {
    test(`${event} clears a ${delay === 100 ? "pending" : "visible"} preview`, () => {
      const m = mount();
      m.enter(); m.tick(delay);
      if (delay === 300) assert.ok(m.preview());
      else assert.equal(m.timers.size, 1);
      m.emit(event); m.tick(1000);
      assert.equal(m.preview(), undefined);
      assert.equal(m.timers.size, 0);
      m.h.unmount();
      assert.equal(m.listenerCount(), 0);
    });
  }
}

test("expanded rows never preview and inline mode still expands a collapsed row", () => {
  const m = mount();
  m.h.preferences.collapsedStepAction = "inline";
  find(m.h, m.mounted.render()).props.onPress();
  const expanded = find(m.h, m.mounted.render());
  expanded.props.onPointerEnter?.({ currentTarget: m.target, nativeEvent: { pointerType: "mouse" } });
  m.tick(1000);
  assert.equal(m.preview(), undefined);
  assert.equal(expanded.props.accessibilityState.expanded, true);
  m.h.unmount();
});

test("a normal click replaces hover with step details without expanding the row", () => {
  const m = mount();
  m.enter(); m.tick(300);
  assert.ok(m.preview());
  m.emit("pointerdown");
  m.row.props.onPress();
  const tree = m.mounted.render();
  assert.equal(m.preview(), undefined);
  assert.equal(find(m.h, tree).props.accessibilityState.expanded, false);
  assert.ok(m.h.nodes(tree, node => node.props.testID === "step-detail-panel")[0]);
  m.h.unmount();
});

test("each captured step previews its own content without mounting its full body", () => {
  for (const item of calls) {
    const m = mount(1440, "web", true, item);
    m.enter(); m.tick(300);
    assert.ok(m.preview(), item.callId);
    const data = m.h.load("client/tool-call-data.ts").buildLiveToolCallData(m.mounted.data);
    assert.ok(m.preview().textContent.includes(m.h.load("client/tool-summary.ts").toolSummary(data)), item.callId);
    assert.ok(m.preview().textContent.includes("Sample") || m.preview().textContent.includes("sample"), item.callId);
    assert.equal(m.h.nodes(m.mounted.tree, node => node.props.testID === "tool-card-body").length, 0);
    m.h.unmount();
    assert.equal(m.preview(), undefined);
  }
});

test("detached or recycled rows cannot leave stale previews", () => {
  const m = mount();
  m.enter(); m.target.remove(); m.tick(300);
  assert.equal(m.preview(), undefined);
  m.doc.body.appendChild(m.target);
  m.enter(); m.tick(300);
  assert.ok(m.preview());
  m.mounted.render({ ...m.mounted.data, callId: "another-sample", title: "Another step" });
  assert.equal(m.preview(), undefined);
  m.h.unmount();
});

for (const [label, output, truncated] of [["short CRLF", "One\r\nTwo", false], ["six lines", "One\nTwo\nThree\nFour\nFive\nSix", false], ["large single line", "Sample ".repeat(10000), true]]) {
  test(`${label} output reports truncation only when content is omitted`, () => {
    const item = { ...calls[0], detail: { ...calls[0].detail, output } };
    const m = mount(1440, "web", true, item);
    m.enter(); m.tick(300);
    assert.ok(m.preview());
    assert.equal(m.preview().textContent.endsWith("…"), truncated);
    assert.ok(m.preview().textContent.length < 1100);
    m.h.unmount();
  });
}

test("a preview preserves and restores the row's existing accessible description", () => {
  const m = mount();
  m.target.setAttribute("aria-describedby", "step-status");
  m.enter(); m.tick(300);
  assert.ok(m.target.getAttribute("aria-describedby").startsWith("step-status clear-chat-tool-preview-"));
  m.row.props.onPointerLeave();
  assert.equal(m.target.getAttribute("aria-describedby"), "step-status");
  m.h.unmount();
});

for (const gesture of ["long press", "right click"]) {
  test(`hover coexists with the existing ${gesture} menu`, () => {
    const m = mount();
    m.enter(); m.tick(300);
    assert.ok(m.preview());
    m.emit("pointerdown");
    m.row.props.onPressIn();
    if (gesture === "long press") m.row.props.onLongPress();
    else m.row.props.onContextMenu({ preventDefault() {}, stopPropagation() {} });
    m.row.props.onPress();
    const tree = m.mounted.render();
    assert.equal(m.preview(), undefined);
    assert.ok(m.h.nodes(tree, node => node.props.testID === "tool-step-menu")[0]);
    assert.equal(find(m.h, tree).props.accessibilityState.expanded, false);
    m.h.unmount();
  });
}
