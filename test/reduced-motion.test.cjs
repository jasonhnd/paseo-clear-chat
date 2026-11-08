const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

function mediaQuery(t, matches) {
  const previous = global.window;
  const listeners = new Set();
  const media = {
    matches,
    addEventListener(type, listener) { assert.equal(type, "change"); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "change"); listeners.delete(listener); },
    change(value) { this.matches = value; for (const listener of listeners) listener({ matches: value }); },
  };
  global.window = { matchMedia(query) { assert.equal(query, "(prefers-reduced-motion: reduce)"); return media; } };
  t.after(() => { if (previous === undefined) delete global.window; else global.window = previous; });
  return { media, listeners };
}

function hookHarness(t, platform, options) {
  const h = createToolHarness(platform, options);
  t.after(() => { h.unmount(); h.dispose(); });
  const useReducedMotion = h.load("client/components/use-reduced-motion.ts").useReducedMotion;
  const Probe = () => ({ type: "Probe", props: { value: useReducedMotion() } });
  return { h, draw: () => h.draw({ type: Probe, props: {} }).props.value };
}

test("web hook reads and tracks the preference and removes its listener", t => {
  const { media, listeners } = mediaQuery(t, true);
  const { h, draw } = hookHarness(t, "web");
  assert.equal(draw(), true);
  assert.equal(listeners.size, 1);
  media.change(false);
  assert.equal(draw(), false);
  const second = hookHarness(t, "web");
  assert.equal(second.draw(), false);
  second.h.unmount();
  media.change(true);
  assert.equal(draw(), true);
  h.unmount();
  assert.equal(listeners.size, 0);
});

test("web hook defaults to false without matchMedia or window", t => {
  const previous = global.window;
  t.after(() => { if (previous === undefined) delete global.window; else global.window = previous; });
  global.window = {};
  const first = hookHarness(t, "web");
  assert.equal(first.draw(), false);
  delete global.window;
  const second = hookHarness(t, "web");
  assert.equal(second.draw(), false);
});

test("native hook waits for the initial preference, tracks changes and removes its listener", async t => {
  let resolveInitial, listener, removed = false;
  const accessibilityInfo = {
    isReduceMotionEnabled: () => new Promise(resolve => { resolveInitial = resolve; }),
    addEventListener(event, callback) {
      assert.equal(event, "reduceMotionChanged"); listener = callback;
      return { remove: () => { removed = true; } };
    },
  };
  const { h, draw } = hookHarness(t, "ios", { accessibilityInfo });
  assert.equal(draw(), true);
  listener(false);
  assert.equal(draw(), false);
  resolveInitial(true);
  await Promise.resolve();
  assert.equal(draw(), false);
  listener(true);
  assert.equal(draw(), true);
  h.unmount();
  assert.equal(removed, true);
});

test("card skips the fade for reduced motion and resumes it when the preference changes", t => {
  const { media } = mediaQuery(t, true);
  const animations = [];
  const h = createToolHarness("web", {
    agents: { a: { status: "idle" } },
    timing(value, options) {
      const animation = { value, options, started: false, stopped: false,
        start() { this.started = true; }, stop() { this.stopped = true; } };
      animations.push(animation);
      return animation;
    },
  });
  t.after(() => { h.unmount(); h.dispose(); });
  const session = h.load("client/option-session.ts");
  const Card = h.load("client/components/option-card.tsx").OptionCard;
  session.publishAssistantReply("a", { at: 10, text: "1) First?\nA One\nB Two\n\n2) Second?\nA Yes\nB No\n\nReply with a letter for each." });
  const draw = () => h.draw({ type: Card, props: { agentId: "a", at: 10, tokens: h.tokens } });
  const opacity = tree => h.nodes(tree, node => node.type === "Animated.View")[0].props.style.opacity.value;
  assert.equal(opacity(draw()), 1);
  session.setActiveQuestion("a", 1);
  assert.equal(opacity(draw()), 1);
  assert.equal(animations.length, 0);
  media.change(false);
  assert.equal(opacity(draw()), 0.85);
  assert.equal(animations.length, 1);
  assert.equal(animations[0].started, true);
  assert.deepEqual(animations[0].options, { toValue: 1, duration: 160, useNativeDriver: true });
  session.setActiveQuestion("a", 0);
  assert.equal(opacity(draw()), 0.85);
  assert.equal(animations[0].stopped, true);
  assert.equal(animations.length, 2);
  assert.equal(animations[1].started, true);
  media.change(true);
  assert.equal(opacity(draw()), 1);
  assert.equal(animations[1].stopped, true);
  assert.equal(animations.length, 2);
});
