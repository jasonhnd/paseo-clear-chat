const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInThisContext } = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function harness() {
  let frame;
  const animations = [];
  const react = {
    useRef(value) {
      const index = frame.cursor++;
      return frame.refs[index] ??= { current: value };
    },
    useEffect(setup, deps) {
      const index = frame.cursor++;
      const before = frame.effects[index];
      if (before && deps.every((value, i) => value === before.deps[i])) return;
      before?.cleanup?.();
      frame.effects[index] = { setup, deps, cleanup: setup() };
    },
  };
  class Value {
    constructor(value) { this.value = value; }
    interpolate({ outputRange }) { return outputRange[this.value]; }
  }
  const native = {
    Platform: { OS: "web" }, View: "View", Easing: { cubic: x => x ** 3, out: f => f },
    Animated: { View: "Animated.View", Value, timing(value, options) {
      const animation = { value, options, stops: 0,
        start(callback) { this.callback = callback; },
        stop() { this.stops += 1; this.callback?.({ finished: false }); },
        finish() { value.value = options.toValue; this.callback?.({ finished: true }); },
      };
      animations.push(animation);
      return animation;
    } },
  };
  const filename = resolve(__dirname, "../client/components/motion.tsx");
  const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const mod = { exports: {} };
  runInThisContext(`(function(require,module,exports){${source}\n})`, { filename })(id => {
    if (id === "react") return react;
    if (id === "react-native") return native;
    if (id === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
    throw new Error(`Unexpected dependency: ${id}`);
  }, mod, mod.exports);
  function mount(props) {
    const owner = { refs: [], effects: [], cursor: 0 };
    return {
      render(next = props) { frame = owner; frame.cursor = 0; return mod.exports.Rotate(next); },
      replayEffects() { for (const effect of owner.effects) if (effect) { effect.cleanup?.(); effect.cleanup = effect.setup(); } },
      unmount() { for (const effect of owner.effects) effect?.cleanup?.(); },
    };
  }
  return { mount, animations };
}

test("static history disclosure mounts start no animations at either initial angle", () => {
  const h = harness();
  for (let row = 0; row < 200; row += 1) {
    const active = row % 2 === 0;
    const instance = h.mount({ active });
    const tree = instance.render();
    assert.equal(tree.props.style.transform[0].rotate, active ? "180deg" : "0deg");
    instance.replayEffects();
    instance.unmount();
  }
  assert.equal(h.animations.length, 0);
});

test("real disclosure changes still animate and interrupted direction changes stop the old animation", () => {
  const h = harness(), instance = h.mount({ active: false });
  instance.render();
  const before = h.animations.length;
  instance.render({ active: true });
  assert.equal(h.animations.length - before, 1);
  const opening = h.animations.at(-1);
  assert.equal(opening.options.toValue, 1);
  assert.equal(opening.options.useNativeDriver, false);
  instance.render({ active: false });
  assert.equal(opening.stops, 1);
  assert.equal(h.animations.at(-1).options.toValue, 0);
  instance.unmount();
  assert.equal(h.animations.at(-1).stops, 1);
});

test("duration changes resume an interrupted transition but do not animate a settled angle", () => {
  const h = harness(), instance = h.mount({ active: false });
  instance.render();
  instance.render({ active: true });
  const opening = h.animations.at(-1);
  instance.render({ active: true, durationMs: 300 });
  assert.equal(opening.stops, 1);
  const resumed = h.animations.at(-1);
  assert.equal(resumed.options.duration, 300);
  resumed.finish();
  const before = h.animations.length;
  const tree = instance.render({ active: true, durationMs: 500 });
  assert.equal(tree.props.style.transform[0].rotate, "180deg");
  assert.equal(h.animations.length, before);
  instance.unmount();
});
