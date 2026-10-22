// Model the public registration notifications and per-source projection cache in
// Paseo 0.12.0: plugins/evaluate.ts, registry.ts, timeline/index.ts and projection.ts.
// Preferences are deliberately absent from the cache key. A registry notification
// creates a new transform callback, just as useInstalledTimelineTransform does.
function createColdLoadHost() {
  const transformers = new Map(), renderers = new Map(), listeners = new Set();
  const caches = new WeakMap();
  let revision = 0, transform, transformCalls = 0;
  let values = { preferences: {}, legacyMigrated: true };
  let resolveRead, rejectRead;
  let gate = new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });

  function changed() {
    transform = (item, phase) => {
      transformCalls++;
      return transformers.get(item.type)?.transform({ item: structuredClone(item), phase })?.items ?? [item];
    };
    revision++;
    for (const listener of listeners) listener();
  }
  function register(map, key, value) {
    if (map.has(key)) throw new Error(`Duplicate registration: ${key}`);
    map.set(key, value);
    changed();
    return () => { if (map.delete(key)) changed(); };
  }
  changed();
  return {
    transformers, renderers,
    get transformCalls() { return transformCalls; },
    getRevision: () => revision,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    addTimelineTransformer(value) { return register(transformers, value.query.itemType, value); },
    addTimelineRenderer(value) { return register(renderers, value.kind, value); },
    async rpc(contract, input) {
      if (contract.name === "settings.presentation.read") {
        await gate;
        return { status: "ready", revision: "1", values: structuredClone(values) };
      }
      if (contract.name === "settings.presentation.write") {
        values = structuredClone(input.values);
        return { status: "saved", revision: "1", values: structuredClone(values) };
      }
      throw new Error(`Unexpected RPC: ${contract.name}`);
    },
    resolvePreferences(preferences = {}) {
      values = { preferences, legacyMigrated: true };
      resolveRead();
      gate = Promise.resolve();
    },
    rejectPreferences() { rejectRead(new Error("Sample settings failure")); },
    // A responsive host remount creates a new hook callback and misses the cache.
    remountTimeline: changed,
    project(item, phase = "complete") {
      let cache = caches.get(transform);
      if (!cache) caches.set(transform, cache = new WeakMap());
      let phases = cache.get(item);
      if (!phases) cache.set(item, phases = new Map());
      if (!phases.has(phase)) phases.set(phase, transform(item, phase));
      return phases.get(phase);
    },
  };
}

const coldLoadSessions = ["claude", "hermes"].map(provider => ({
  provider,
  items: require(`../fixtures/real-${provider}-session.json`).items,
}));

module.exports = { createColdLoadHost, coldLoadSessions };
