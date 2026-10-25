const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInThisContext } = require("node:vm");
const ts = require("typescript");

// Run the installed SDK's resource validation, i18next engine, fallback,
// message tokens and hook. Only React's host context is supplied by the harness.
function createTranslations(react = {}, options = {}) {
  const jsx = (type, props) => ({ type, props });
  const hooks = {
    ...react,
    createContext: value => ({ current: value, Provider: "TranslationProvider" }),
    useContext: context => context.current,
    useCallback: react.useCallback ?? (fn => fn),
    useSyncExternalStore: react.useSyncExternalStore ?? ((subscribe, get) => get()),
  };
  const filename = resolve(__dirname, "../../node_modules/@getpaseo/plugin/dist/client/translations.js");
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  let context;
  const createContext = hooks.createContext;
  hooks.createContext = value => (context = createContext(value));
  runInThisContext(`(function(require,module,exports){${code}\n})`, { filename })(id => {
    if (id === "react") return hooks;
    if (id === "react/jsx-runtime") return { jsx };
    return require(id);
  }, mod, mod.exports);
  const listeners = new Set();
  const runtime = new mod.exports.PluginTranslationRuntime({
    getLocale: () => options.locale ?? "en",
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  });
  context.current = runtime;
  return {
    ...mod.exports, runtime,
    setLocale(locale) { options.locale = locale; for (const listener of listeners) listener(); },
  };
}
module.exports = { createTranslations };
