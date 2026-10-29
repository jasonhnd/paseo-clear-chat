const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// Each input is a distinct host row, even when its content matches another row.
// The host owns source identity; the plugin must return one replacement or defer.
const approvalName = "edit-approval-sample";
const items = [
  { type: "user_message", messageId: "prompt-1", text: "Same text" },
  { type: "user_message", messageId: "prompt-2", text: "Same text" },
  { type: "reasoning", text: "Same text" },
  { type: "reasoning", text: "Same text" },
  { type: "tool_call", callId: "tool-1", name: "read", status: "completed", detail: { type: "unknown", input: null, output: "Same text" } },
  { type: "tool_call", callId: "tool-2", name: "read", status: "failed", detail: { type: "unknown", input: null, output: "Same text" }, error: "Sample failure" },
  { type: "tool_call", callId: approvalName, name: approvalName, status: "completed", detail: { type: "unknown", input: null, output: null }, metadata: { title: approvalName } },
  { type: "todo", items: [{ content: "Same text", status: "pending" }] },
  { type: "error", message: "Sample failure" },
  { type: "error", message: "Sample failure" },
  { type: "assistant_message", messageId: "reply-1", text: "Same text" },
  { type: "assistant_message", messageId: "reply-2", text: "Same text" },
];
const kinds = ["omp-user-message", "omp-user-message", "omp-reasoning", "omp-reasoning", "omp-tool-call", "omp-tool-call", "omp-approval", "omp-todo", "omp-notice", "omp-notice", "omp-assistant", "omp-assistant"];

for (const phase of ["streaming", "complete"]) {
  test(`each supported source receives exactly one valid replacement in ${phase} phase`, () => {
    const h = createToolHarness("web");
    try {
      for (const [index, input] of items.entries()) {
        const item = structuredClone(input);
        const before = structuredClone(item);
        const output = h.transformers.get(item.type).transform({ item, phase });
        assert.equal(output.items.length, 1, `source ${index}`);
        const row = output.items[0];
        assert.equal(row.type, "plugin");
        assert.equal(row.kind, kinds[index]);
        assert.ok(h.renderers.get(row.kind).schema.safeParse(row.data).success, `source ${index}`);
        assert.deepEqual(item, before, `source ${index} is unchanged`);
      }
      assert.equal(h.transformers.get("tool_call").transform({ item: items[5], phase }).items[0].data.error, "Sample failure");
      assert.equal(h.transformers.get("tool_call").transform({ item: items[6], phase }).items[0].data.status, "approved");
    } finally { h.dispose(); h.unmount(); }
  });
}

test("repeated updates and identical distinct items are independently transformed", () => {
  const h = createToolHarness("web");
  try {
    const tool = h.transformers.get("tool_call");
    const running = { ...items[4], status: "running" };
    assert.equal(tool.transform({ item: running, phase: "streaming" }).items[0].data.status, "running");
    assert.equal(tool.transform({ item: items[4], phase: "complete" }).items[0].data.status, "completed");
    assert.equal(tool.transform({ item: items[4], phase: "complete" }).items[0].data.callId, "tool-1");
    assert.equal(tool.transform({ item: { ...items[4], callId: "tool-3" }, phase: "complete" }).items[0].data.callId, "tool-3");
    const replies = items.slice(-2).map(item => h.transformers.get(item.type).transform({ item, phase: "complete" }).items[0].data.messageId);
    assert.deepEqual(replies, ["reply-1", "reply-2"]);
  } finally { h.dispose(); h.unmount(); }
});

test("text transformers defer to the host for disabled or unsupported content", () => {
  const h = createToolHarness("web");
  try {
    h.preferences.enhancedUserBubble = false;
    h.preferences.assistantMarkdown = false;
    assert.equal(h.transformers.get("user_message").transform({ item: items[0] }), undefined);
    assert.equal(h.transformers.get("assistant_message").transform({ item: items.at(-1) }), undefined);
    h.preferences.enhancedUserBubble = true;
    h.preferences.assistantMarkdown = true;
    assert.equal(h.transformers.get("assistant_message").transform({ item: { type: "assistant_message", text: "  " } }), undefined);
  } finally { h.dispose(); h.unmount(); }
});
