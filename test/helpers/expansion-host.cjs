// A revision-checked host settings service with no browser storage or real sessions.
function createExpansionHost(initial = {}) {
  let values = structuredClone({ entries: {}, ...initial });
  let revision = 0;
  const calls = [];
  const host = {
    calls,
    conflicts: 0,
    failReads: false,
    failWrites: false,
    beforeRead: undefined,
    beforeWrite: undefined,
    get values() { return structuredClone(values); },
    edit(entries) { values.entries = { ...values.entries, ...entries }; revision++; },
    async read() {
      calls.push({ name: "read" });
      if (host.beforeRead) await host.beforeRead();
      if (host.failReads) throw new Error("Host unavailable");
      return { status: "ready", revision: String(revision), values: structuredClone(values) };
    },
    async write(input) {
      calls.push({ name: "write", input: structuredClone(input) });
      if (host.beforeWrite) await host.beforeWrite();
      if (host.failWrites) throw new Error("Host unavailable");
      if (host.conflicts > 0) { host.conflicts--; revision++; }
      if (input.revision !== String(revision)) return { status: "conflict", error: "Changed elsewhere" };
      values = structuredClone(input.values); revision++;
      return { status: "saved", revision: String(revision), values: structuredClone(values) };
    },
  };
  return host;
}

module.exports = { createExpansionHost };
