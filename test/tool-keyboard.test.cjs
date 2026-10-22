const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const fixture = require("./fixtures/real-claude-session.json");
const call = fixture.items.find(item => item.type === "tool_call" && item.detail.type === "shell" && item.status === "completed");
const find = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];

function keyboardDocument() {
  const listeners = new Map(), elements = [];
  const doc = {
    activeElement: null,
    querySelectorAll: () => elements,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener: (type, listener) => listeners.get(type)?.delete(listener),
    defaultView: { requestAnimationFrame: fn => fn() },
  };
  function element(scope = '["demo-host","demo-agent"]', visible = true) {
    const node = {
      ownerDocument: doc, isConnected: true, keyboard: true,
      getAttribute: name => name === "data-clear-chat-step" ? scope : null,
      getClientRects: () => visible ? [{}] : [],
      closest: () => null,
      matches: selector => selector === ":focus-visible" && node.keyboard,
      focus: () => { doc.activeElement = node; },
      scrollIntoView: options => { node.scrolled = options; },
    };
    elements.push(node);
    return node;
  }
  function key(key, target = doc.activeElement, extra = {}) {
    return {
      key, target, currentTarget: target, nativeEvent: {}, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }, ...extra,
    };
  }
  return { doc, element, key, emit(event) { for (const listener of [...listeners.get("keydown") ?? []]) listener(event); },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0) };
}

for (const width of [1440, 1024, 820, 390]) {
  test(`web ${width}: focused arrows move between visible steps in the same conversation`, () => {
    const dom = keyboardDocument();
    const h = createToolHarness("web", { width, globals: { document: dom.doc } });
    const mounted = h.mount(call, false);
    const row = find(h, mounted.tree, "tool-summary-row");
    assert.equal(typeof row.props.onKeyDownCapture, "function");
    assert.equal(row.props.accessibilityRole, "button");
    assert.ok(row.props.accessibilityLabel.includes(call.detail.command));
    assert.equal(row.props.dataSet.clearChatStep, '["demo-host","demo-agent"]');
    const first = dom.element(), hidden = dom.element(undefined, false);
    const otherAgent = dom.element("other-agent"), second = dom.element();
    first.focus();
    const down = dom.key("ArrowDown"); row.props.onKeyDownCapture(down);
    assert.equal(dom.doc.activeElement, second);
    assert.equal(down.defaultPrevented, true);
    assert.equal(down.stopped, true);
    assert.equal(second.scrolled.block, "nearest");
    const end = dom.key("ArrowDown"); row.props.onKeyDownCapture(end);
    assert.equal(dom.doc.activeElement, second, "The last step does not wrap");
    row.props.onKeyDownCapture(dom.key("ArrowUp"));
    assert.equal(dom.doc.activeElement, first);
    row.props.onKeyDownCapture(dom.key("ArrowUp"));
    assert.equal(dom.doc.activeElement, first, "The first step does not wrap");
    assert.equal(hidden.scrolled, undefined); assert.equal(otherAgent.scrolled, undefined);
    h.unmount();
  });

  test(`web ${width}: Enter opens the existing details and Escape closes them`, () => {
    const dom = keyboardDocument();
    const h = createToolHarness("web", { width, globals: { document: dom.doc } });
    const mounted = h.mount(call, false), target = dom.element(); target.focus();
    const event = dom.key("Enter");
    find(h, mounted.tree, "tool-summary-row").props.onKeyDownCapture(event);
    assert.equal(event.defaultPrevented, true);
    let tree = mounted.render();
    assert.ok(find(h, tree, "step-detail-panel"));
    assert.equal(find(h, tree, "step-detail-panel").props.role, width >= 1024 ? "region" : "dialog");
    assert.equal(find(h, tree, "step-detail-panel").props.accessibilityLabel, "Step details");
    assert.equal(find(h, tree, "tool-summary-row").props.accessibilityState.expanded, false);
    const escape = dom.key("Escape"); dom.emit(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(find(h, mounted.render(), "step-detail-panel"), undefined);
    assert.equal(dom.doc.activeElement, target);
    h.unmount(); assert.equal(dom.count(), 0);
  });
}

test("inputs, editable descendants, modifier shortcuts and IME keys are left alone", () => {
  const dom = keyboardDocument();
  const h = createToolHarness("web", { globals: { document: dom.doc } });
  const mounted = h.mount(call, false), target = dom.element(), input = dom.element("input");
  const row = find(h, mounted.tree, "tool-summary-row");
  assert.equal(typeof row.props.onKeyDownCapture, "function");
  for (const key of ["ArrowUp", "ArrowDown", "Enter"]) {
    for (const extra of [{ target: input }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true },
      { nativeEvent: { isComposing: true } }, { defaultPrevented: true }]) {
      target.focus();
      const event = dom.key(key, target, { currentTarget: target, ...extra });
      const prevented = event.defaultPrevented;
      row.props.onKeyDownCapture(event);
      assert.equal(event.defaultPrevented, prevented);
      assert.equal(event.stopped, false);
      assert.equal(dom.doc.activeElement, target);
      assert.equal(find(h, mounted.render(), "step-detail-panel"), undefined);
    }
  }
  input.focus();
  const event = dom.key("ArrowDown", target); row.props.onKeyDownCapture(event);
  assert.equal(event.defaultPrevented, false, "A stale row must not capture the active input's key");
  h.unmount();
});

test("keyboard focus has a visible ring; touch focus does not", () => {
  const dom = keyboardDocument();
  const h = createToolHarness("web", { width: 390, globals: { document: dom.doc } });
  const mounted = h.mount(call, false), target = dom.element(); target.focus();
  const styles = () => [find(h, mounted.render(), "tool-summary-row").props.style].flat(Infinity).filter(Boolean);
  find(h, mounted.tree, "tool-summary-row").props.onFocus({ currentTarget: target, target });
  assert.ok(styles().some(style => style.outlineStyle === "solid" && style.outlineWidth >= 2));
  find(h, mounted.render(), "tool-summary-row").props.onBlur();
  target.keyboard = false;
  find(h, mounted.render(), "tool-summary-row").props.onFocus({ currentTarget: target, target });
  assert.equal(styles().some(style => style.outlineStyle === "solid"), false);
  target.keyboard = true;
  find(h, mounted.render(), "tool-summary-row").props.onFocus({ currentTarget: target, target });
  find(h, mounted.render(), "tool-summary-row").props.onPressIn({ nativeEvent: { key: " " } });
  assert.ok(styles().some(style => style.outlineStyle === "solid"), "Keyboard activation keeps its focus ring");
  find(h, mounted.render(), "tool-summary-row").props.onPressIn({ nativeEvent: {} });
  assert.equal(styles().some(style => style.outlineStyle === "solid"), false, "Pointer activation clears a previous keyboard ring");
  h.unmount();
});

for (const [platform, isPad] of [["ios", false], ["ios", true], ["android", false]]) {
  test(`${platform}${isPad ? " tablet" : ""}: native rows retain accessible focus and escape dismissal`, () => {
    const h = createToolHarness(platform, { isPad, width: isPad ? 820 : 390 });
    const mounted = h.mount(call, false);
    const row = find(h, mounted.tree, "tool-summary-row");
    assert.equal(row.props.focusable, true);
    assert.equal(row.props.accessibilityRole, "button");
    assert.ok(row.props.accessibilityLabel);
    row.props.onPress();
    find(h, mounted.render(), "step-detail-panel").props.onAccessibilityEscape();
    assert.equal(find(h, mounted.render(), "step-detail-panel"), undefined);
    h.unmount();
  });
}


test("Enter on an expanded step opens details once without changing saved folding", () => {
  const dom = keyboardDocument();
  const h = createToolHarness("web", { globals: { document: dom.doc } });
  const mounted = h.mount(call, false), target = dom.element(); target.focus();
  const data = mounted.data;
  let tree = mounted.render(data);
  // Expand with the inline action first, then restore the default details action.
  h.preferences.collapsedStepAction = "inline";
  find(h, mounted.render(data), "tool-summary-row").props.onPress();
  h.preferences.collapsedStepAction = "details";
  tree = mounted.render(data);
  assert.equal(find(h, tree, "tool-summary-row").props.accessibilityState.expanded, true);
  find(h, tree, "tool-summary-row").props.onKeyDownCapture(dom.key("Enter"));
  tree = mounted.render(data);
  assert.ok(find(h, tree, "step-detail-panel"));
  assert.equal(find(h, tree, "tool-summary-row").props.accessibilityState.expanded, true);
  const opens = h.panelOpens.length;
  const repeat = dom.key("Enter", target, { repeat: true });
  find(h, tree, "tool-summary-row").props.onKeyDownCapture(repeat);
  assert.equal(repeat.defaultPrevented, true);
  assert.equal(h.panelOpens.length, opens);
  h.unmount();
});

test("Escape dismisses only the top detail and releases document listeners", () => {
  const dom = keyboardDocument();
  const h = createToolHarness("web", { globals: { document: dom.doc } });
  const { installStepDetailKeyboard } = h.load("client/step-detail-keyboard.ts");
  const closed = [];
  const first = installStepDetailKeyboard(() => closed.push("first"));
  const second = installStepDetailKeyboard(() => closed.push("second"));
  for (const extra of [{ isComposing: true }, { ctrlKey: true }, { repeat: true }]) dom.emit(dom.key("Escape", undefined, extra));
  assert.deepEqual(closed, []);
  dom.emit(dom.key("Escape"));
  assert.deepEqual(closed, ["second"]);
  second(); dom.emit(dom.key("Escape"));
  assert.deepEqual(closed, ["second", "first"]);
  first(); assert.equal(dom.count(), 0);
  h.unmount();
});
