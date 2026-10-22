const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

const entries = JSON.parse(readFileSync(join(__dirname, "fixtures/real-hermes-reply-footer.json"), "utf8"));
const wrapUp = JSON.parse(readFileSync(join(__dirname, "fixtures/real-claude-wrapup.json"), "utf8"));
const copyButtons = (h, tree) => h.nodes(tree, node => node.type === "Pressable" && node.props.accessibilityLabel === "Copy reply");

for (const platform of ["web", "ios", "android"]) {
  test(`captured assistant reply keeps Copy away from the global timeline tail on ${platform}`, async () => {
    const h = createToolHarness(platform, { markdown: true, replyFooter: true, timelineTail: false });
    assert.deepEqual(entries.map(entry => entry.item.type), ["user_message", "tool_call", "tool_call", "assistant_message"]);
    for (const entry of entries.filter(entry => entry.item.type === "tool_call")) {
      const { tree } = h.mount(entry.item, false, { timestamp: new Date(entry.timestamp) });
      assert.equal(h.nodes(tree, node => node.props.testID === "tool-error-line").length, 1);
      assert.equal(copyButtons(h, tree).length, 0, "ordinary tools do not acquire reply controls");
    }
    const entry = entries.at(-1);
    const { tree } = h.mount(entry.item, false, { timestamp: new Date(entry.timestamp) });
    const buttons = copyButtons(h, tree);
    assert.equal(buttons.length, 1, "a reply retains its own Copy control after another item or session takes the tail");
    await buttons[0].props.onPress();
    assert.deepEqual(h.copies, [entry.item.text], "copy keeps complete Markdown and whitespace");
    h.unmount();
  });

  test(`captured wrap-up reply has one Copy control with complete Markdown on ${platform}`, async () => {
    const h = createToolHarness(platform, { markdown: true, replyFooter: true, timelineTail: false, preferences: { foldLongOutputAfter: 10 } });
    const { tree } = h.mount(wrapUp, false);
    assert.equal(h.nodes(tree, node => node.props.testID === "wrap-up-reply").length, 1);
    assert.equal(h.nodes(tree, node => node.props.testID === "wrap-up-option").length, 2);
    assert.equal(h.nodes(tree, node => node.props.testID === "wrap-up-blocked").length, 1);
    assert.equal(h.nodes(tree, node => node.props.testID === "tool-summary-row").length, 0);
    const buttons = copyButtons(h, tree);
    assert.equal(buttons.length, 1);
    await buttons[0].props.onPress();
    assert.deepEqual(h.copies, ["## Checks complete\n\n**The sample change is ready.**\n\n## Question\n\nWhich sample step should follow?\n\n## Options\n\nA. Review the sample\n\nRead the sample report before continuing.\n\nB. Prepare a follow-up\n\nCreate a separate sample change.\n\n## Blocked"]);
    h.unmount();
  });
}

for (const platform of ["web", "ios", "android"]) {
  test(`plain wrap-up copies all Markdown beyond output limits on ${platform}`, async () => {
    const reply = "# Sample report\n\n[Reference](https://example.com/report)\n\n![Preview](https://example.com/preview.png)\n\n```js\nconst sample = true;\n```\n\n"
      + Array.from({ length: 40 }, (_, index) => `Report line ${index + 1}`).join("\n") + "\n  ";
    const item = structuredClone(wrapUp);
    item.detail.input = { response: reply };
    const h = createToolHarness(platform, { replyFooter: true, preferences: { foldLongOutputAfter: 10 } });
    const { tree } = h.mount(item, false);
    assert.equal(copyButtons(h, tree).length, 1);
    await copyButtons(h, tree)[0].props.onPress();
    assert.deepEqual(h.copies, [reply]);
    h.unmount();
  });
}

test("structured clipboard Markdown keeps authored option letters and blocked reasons", () => {
  const h = createToolHarness();
  const { finalToolReplyMarkdown } = h.load("client/tool-final-reply.ts");
  const source = JSON.stringify({ recap: "**All checks retained.**", ask: "What next?", actions: [
    { label: "C) Review", message: "[Open the report](https://example.com/report)" },
    { label: "A: Continue", message: "Keep this complete message." },
  ], blocked: ["Missing sample permission.", "Waiting for a sample decision."] });
  assert.equal(finalToolReplyMarkdown(source), "**All checks retained.**\n\n## Question\n\nWhat next?\n\n## Options\n\nC) Review\n\n[Open the report](https://example.com/report)\n\nA: Continue\n\nKeep this complete message.\n\n## Blocked\n\nMissing sample permission.\n\nWaiting for a sample decision.");
});

test("unfamiliar wrap-up JSON stays verbatim on the clipboard", () => {
  const h = createToolHarness();
  const { finalToolReplyMarkdown } = h.load("client/tool-final-reply.ts");
  for (const source of ["{broken JSON", JSON.stringify({ recap: "Sample recap", unfamiliar: "Keep this field" }, null, 2)]) {
    assert.equal(finalToolReplyMarkdown(source), source);
  }
});
