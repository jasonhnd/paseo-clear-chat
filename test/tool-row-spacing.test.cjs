const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const h = createToolHarness("web");
const { installCompactToolSpacing, toolGapCompensation, COMPACT_TOOL_GAP } = h.load("client/tool-row-spacing.ts");
const { COLLAPSED_TOOL_HEIGHT } = h.load("client/components/tool-callout-styles.ts");

// Supply DOM primitives around the actual spacing installer. The row/frame/root
// nesting follows Paseo v0.8's mounted and virtualized web timeline strategies.
class Element {
  constructor(attributes = {}, height = 26) {
    this.attributes = attributes;
    this.children = [];
    this.parentElement = null;
    this.style = { marginTop: "", marginBottom: "" };
    this.height = height;
  }
  append(child) { child.parentElement = this; this.children.push(child); return child; }
  get previousElementSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  hasAttribute(name) { return name in this.attributes; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  matches(selector) { return this.hasAttribute(selector.slice(1, -1)); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  getBoundingClientRect() { return { height: this.height }; }
}

function timeline(states, gap = 16) {
  const doc = new Element();
  const frames = [], markers = [], rows = [], jobs = new Map(), listeners = new Map();
  let mutation, requested = 0, disconnected = false;
  doc.defaultView = {
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe(_, options) { assert.equal(options.subtree, true); }
      disconnect() { disconnected = true; }
    },
    getComputedStyle: node => node.style,
    requestAnimationFrame(callback) { jobs.set(++requested, callback); return requested; },
    cancelAnimationFrame: id => jobs.delete(id),
    addEventListener: (event, callback) => listeners.set(event, callback),
    removeEventListener: event => listeners.delete(event),
  };
  for (const [index, state] of states.entries()) {
    const row = doc.append(new Element({ "data-history-row-id": `sample-row-${index}` }));
    const frame = row.append(new Element());
    frame.style.marginBottom = `${gap}px`;
    const marker = frame.append(new Element(state === "message" ? {} : { "data-clearchattool": state }));
    rows.push(row); frames.push(frame); markers.push(marker);
  }
  const stop = installCompactToolSpacing(doc);
  function flush() { for (const [id, callback] of jobs) { jobs.delete(id); callback(); } }
  return { doc, rows, frames, markers, stop, flush, jobs, listeners, mutate: () => mutation(), get requested() { return requested; }, get disconnected() { return disconnected; } };
}

test("two real collapsed rows have a 30px center pitch after the measured 16px host gap", () => {
  const { tree } = h.mount({ type: "tool_call", callId: "sample-call", name: "shell", status: "completed", detail: { type: "shell", command: "git status" } }, false);
  const card = h.nodes(tree, node => node.props.testID === "tool-card-git")[0];
  const header = h.nodes(tree, node => node.props.testID === "tool-summary-row")[0];
  const footprint = header.props.style.height + 2 * header.props.style.paddingVertical
    + 2 * card.props.style.borderWidth + 2 * card.props.style.marginVertical;
  assert.equal(footprint, COLLAPSED_TOOL_HEIGHT);
  assert.equal(footprint, 26);
  assert.equal(h.nodes(tree, node => node.props.testID === "tool-timeline-item")[0].props.dataSet.clearchattool, "collapsed");
  const dom = timeline(["collapsed", "collapsed", "collapsed"]);
  dom.flush();
  assert.deepEqual(dom.markers.map(node => node.style.marginTop), ["", "-12px", "-12px"]);
  const pitch = footprint + 16 + Number.parseFloat(dom.markers[1].style.marginTop);
  assert.equal(pitch, 30);
  assert.equal(pitch - footprint, COMPACT_TOOL_GAP);
  assert.ok(pitch >= footprint, "rows never overlap");
  assert.deepEqual(dom.frames.map(node => node.style.marginBottom), ["16px", "16px", "16px"], "only plugin roots change");
  dom.stop();
});

test("ordinary messages, expanded tools and wrap-up cards terminate compact sequences", () => {
  for (const boundary of ["message", "open"]) {
    const dom = timeline(["collapsed", boundary, "collapsed", "collapsed"]);
    dom.flush();
    assert.deepEqual(dom.markers.map(node => node.style.marginTop), ["", "", "", "-12px"]);
    dom.stop();
  }
  const wrap = require("./fixtures/real-claude-wrapup.json");
  const { tree } = h.mount(wrap, false);
  assert.equal(h.nodes(tree, node => node.props.testID === "tool-timeline-item")[0].props.dataSet.clearchattool, "open");
});

test("expansion and history changes restore the plugin margin before compacting new neighbors", () => {
  const dom = timeline(["collapsed", "collapsed", "collapsed"]);
  dom.flush();
  dom.markers[1].attributes["data-clearchattool"] = "open";
  dom.mutate(); dom.flush();
  assert.deepEqual(dom.markers.map(node => node.style.marginTop), ["", "", ""]);
  dom.markers[1].attributes["data-clearchattool"] = "collapsed";
  dom.mutate(); dom.flush();
  assert.equal(dom.markers[2].style.marginTop, "-12px");
  dom.doc.children.splice(1, 1);
  dom.mutate(); dom.flush();
  assert.equal(dom.markers[1].style.marginTop, "", "detached roots are restored and released");
  dom.stop();
});

for (const gap of [0, 2, 4, 8, 16, 24]) {
  test(`a measured ${gap}px gap cannot cause overlap or affect host margins`, () => {
    const dom = timeline(["collapsed", "collapsed"], gap);
    dom.flush();
    const compensation = Math.abs(Number.parseFloat(dom.markers[1].style.marginTop) || 0);
    assert.equal(compensation, toolGapCompensation(gap));
    assert.ok(compensation <= Math.max(0, gap - COMPACT_TOOL_GAP));
    assert.ok(COLLAPSED_TOOL_HEIGHT + gap - compensation >= COLLAPSED_TOOL_HEIGHT);
    if (gap <= 16) assert.ok(COLLAPSED_TOOL_HEIGHT + gap - compensation <= 30);
    assert.equal(dom.frames[0].style.marginBottom, `${gap}px`);
    dom.stop();
  });
}

test("unknown or invalid host spacing leaves plugin and host margins alone", () => {
  for (const gap of [NaN, Infinity, -1]) assert.equal(toolGapCompensation(gap), 0);
  const dom = timeline(["collapsed", "collapsed"]);
  dom.frames[0].style.marginBottom = "auto";
  dom.flush();
  assert.equal(dom.markers[1].style.marginTop, "");
  dom.stop();
});

test("footer siblings, auxiliary content and hidden roots do not compact", () => {
  for (const scenario of ["footer", "auxiliary", "hidden", "unknown frame"]) {
    const dom = timeline(["collapsed", "collapsed"]);
    if (scenario === "footer") dom.rows[0].append(new Element());
    if (scenario === "auxiliary") dom.markers[0].height = 80;
    if (scenario === "hidden") dom.markers[1].height = 0;
    if (scenario === "unknown frame") delete dom.rows[1].attributes["data-history-row-id"];
    dom.flush();
    assert.equal(dom.markers[1].style.marginTop, "", scenario);
    dom.stop();
  }
});

test("virtualized row indices must be consecutive", () => {
  const dom = timeline(["collapsed", "collapsed"]);
  dom.rows[0].attributes["data-index"] = "4";
  dom.rows[1].attributes["data-index"] = "6";
  dom.flush();
  assert.equal(dom.markers[1].style.marginTop, "");
  dom.rows[1].attributes["data-index"] = "5";
  dom.mutate(); dom.flush();
  assert.equal(dom.markers[1].style.marginTop, "-12px");
  dom.stop();
});

test("a mounted row can follow the last row of a virtualized history container", () => {
  const dom = timeline(["collapsed", "collapsed"]);
  const history = new Element();
  history.append(dom.rows[0]); history.parentElement = dom.doc;
  dom.doc.children[0] = history;
  dom.flush();
  assert.equal(dom.markers[1].style.marginTop, "-12px");
  dom.stop();
});

test("updates batch into one frame and cleanup restores only the plugin margin", () => {
  const dom = timeline(["collapsed", "collapsed"]);
  dom.markers[1].style.marginTop = "1px";
  dom.mutate(); dom.mutate();
  assert.equal(dom.requested, 1);
  dom.flush();
  assert.equal(dom.markers[1].style.marginTop, "-12px");
  dom.listeners.get("resize")();
  assert.equal(dom.jobs.size, 1);
  dom.stop();
  assert.equal(dom.markers[1].style.marginTop, "1px");
  assert.equal(dom.frames[0].style.marginBottom, "16px");
  assert.equal(dom.jobs.size, 0);
  assert.equal(dom.listeners.size, 0);
  assert.equal(dom.disconnected, true);
});

test("compact spacing finishes all layout reads before writing any margin", () => {
  const dom = timeline(["collapsed", "collapsed", "collapsed", "collapsed"]);
  const events = [];
  for (const marker of dom.markers) {
    const measure = marker.getBoundingClientRect.bind(marker);
    marker.getBoundingClientRect = () => { events.push("read"); return measure(); };
    let margin = "";
    Object.defineProperty(marker.style, "marginTop", {
      get: () => margin,
      set: value => { events.push("write"); margin = value; },
    });
  }
  dom.doc.defaultView.getComputedStyle = node => { events.push("read"); return node.style; };
  dom.flush();
  assert.ok(events.includes("write"));
  assert.ok(events.lastIndexOf("read") < events.indexOf("write"), "a style write must never precede a layout read");
  assert.deepEqual(dom.markers.map(node => node.style.marginTop), ["", "-12px", "-12px", "-12px"]);
  dom.stop();
});

test("a compact row is measured once per refresh even when it is also a neighbor", () => {
  const dom = timeline(["collapsed", "collapsed", "collapsed", "collapsed"]);
  const readings = dom.markers.map(() => 0);
  dom.markers.forEach((marker, index) => {
    const measure = marker.getBoundingClientRect.bind(marker);
    marker.getBoundingClientRect = () => { readings[index] += 1; return measure(); };
  });
  dom.flush();
  assert.deepEqual(readings, [1, 1, 1, 1]);
  dom.markers[1].height = 80;
  dom.mutate(); dom.flush();
  assert.deepEqual(dom.markers.map(node => node.style.marginTop), ["", "", "", "-12px"]);
  dom.stop();
});

test("native runtimes without a document keep their layout", () => {
  assert.doesNotThrow(() => installCompactToolSpacing()());
});
