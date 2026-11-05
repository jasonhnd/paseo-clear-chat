const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

function localeTime(locale, date, options) {
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function visibleTime(h, tree) {
  return h.nodes(tree, node => node.type === "Text" && /\d/.test(h.text(node)))[0];
}

for (const locale of ["en", "zh-CN", "ja"]) {
  test(`${locale}: prompt and reply show the same locale-formatted timestamp`, () => {
    const date = new Date("2026-01-01T13:55:23");
    const h = createToolHarness("web", { locale, userMessage: true, replyFooter: true });
    try {
      const { UserMessage } = h.load("client/components/user-message.tsx");
      const { AssistantFooter } = h.load("client/components/turn-footer.tsx");
      const now = new Date("2026-01-01T13:56:00");
      const prompt = h.draw({ type: UserMessage, props: { text: "Prompt", timestamp: date, now, tokens: h.tokens } });
      const reply = h.draw({ type: AssistantFooter, props: { text: "Reply", at: date, now, tokens: h.tokens } });
      const promptTime = visibleTime(h, prompt);
      const replyTime = h.nodes(reply, node => node.type === "Text" && h.text(node) === h.text(promptTime))[0];
      assert.ok(promptTime, "prompt header contains the expected locale time");
      assert.ok(replyTime, "reply footer contains the identical time");
      assert.doesNotMatch(h.text(prompt), /\b\d{2}:\d{2}:\d{2}\b/);

      const yesterday = new Date(date.getTime() - 86_400_000);
      const oldPrompt = h.draw({ type: UserMessage, props: { text: "Old prompt", timestamp: yesterday, now, tokens: h.tokens } });
      const oldReply = h.draw({ type: AssistantFooter, props: { text: "Old reply", at: yesterday, now, tokens: h.tokens } });
      const oldPromptTime = visibleTime(h, oldPrompt);
      assert.ok(oldPromptTime, "previous-day prompt uses the weekday form");
      assert.ok(h.nodes(oldReply, node => node.type === "Text" && h.text(node) === h.text(oldPromptTime)).length);
    } finally {
      h.unmount();
    }
  });
}

for (const platform of ["web", "ios", "android"]) {
  test(`${platform}: repeated prompt text keeps each host message identity across turns`, () => {
    const agent = { status: "idle", updatedAt: "sample-first-revision" };
    const h = createToolHarness(platform, { userMessage: true, promptAnchor: true, agent });
    try {
      const rows = [];
      for (let index = 0; index < 3; index++) {
        agent.status = index === 1 ? "running" : "idle";
        agent.updatedAt = `sample-revision-${index}`;
        rows.push(h.mount({ type: "user_message", messageId: `sample-prompt-${index}`, text: "Repeat the same request." }));
      }
      for (const [index, row] of rows.entries()) {
        assert.equal(row.data.messageId, `sample-prompt-${index}`);
        const anchors = h.nodes(row.render(), node => node.props.dataSet?.historyRowId);
        assert.deepEqual(anchors.map(node => node.props.dataSet.historyRowId), [`sample-prompt-${index}`]);
      }
      const optimistic = h.mount({ type: "user_message", text: "Repeat the same request." });
      assert.equal(h.nodes(optimistic.tree, node => node.props.dataSet?.historyRowId).length, 0);
    } finally { h.unmount(); }
  });
}
