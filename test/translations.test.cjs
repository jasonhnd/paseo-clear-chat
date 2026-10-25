const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { resolve } = require("node:path");
const { createTranslations } = require("./helpers/translations.cjs");
const resources = Object.fromEntries(["en", "zh-CN", "ja"].map(locale => [locale, require(`../client/locales/${locale}.json`)]));
const byId = (h, tree, id) => h.nodes(tree, node => node.props.testID === id)[0];
const hasText = (h, tree, expected) => assert.ok(h.text(tree).includes(expected), JSON.stringify(expected));
const hasLabel = (h, tree, expected) => assert.ok(h.nodes(tree, node => node.props.accessibilityLabel === expected).length, expected);
const interpolate = (text, values) => text.replace(/{{(\w+)}}/g, (_, key) => values[key]);
const call = { type: "tool_call", name: "shell", status: "completed", callId: "sample-call", detail: { type: "shell", command: "printf sample", output: "" } };
const presentationHost = { rpc: async () => ({ status: "ready", revision: "0", values: { preferences: {}, legacyMigrated: true } }) };

for (const locale of ["en", "zh-CN", "ja"]) {
  const r = resources[locale];
  test(`${locale}: settings render approved labels and option text`, async () => {
    const h = createToolHarness("ios", { locale, settingsPage: true, presentationHost });
    await new Promise(setImmediate);
    const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
    const tree = h.draw({ type: Page, props: { theme: { colors: {} } } });
    for (const text of [r.settings.title, r.settings.intro, r.settings.accent.host, r.settings.foldSteps.label, r.settings.codeFont.default, r.settings.textSize.large, r.settings.foldOutput.lines15, r.settings.report]) hasText(h, tree, text);
    hasLabel(h, tree, interpolate(r.settings.accent.optionA11y, { label: r.settings.accent.jade }));
    h.unmount();
  });

  test(`${locale}: a registered tool card translates its empty output and accessibility text`, () => {
    const h = createToolHarness("ios", { locale });
    const tree = h.mount(call).tree;
    hasText(h, tree, r.tool.shell.completed);
    hasLabel(h, tree, r.tool.status.completed);
    hasLabel(h, tree, interpolate(r.tool.row.collapseA11y, { summary: "$ printf sample" }));
    h.unmount();
  });

  test(`${locale}: the detail panel uses translated titles, inline sections, status and controls`, () => {
    const h = createToolHarness("ios", { locale, width: 390, preferences: { collapsedStepAction: "details" } });
    const mounted = h.mount(call, false);
    byId(h, mounted.tree, "tool-summary-row").props.onPress();
    const tree = mounted.render();
    hasLabel(h, tree, r.detail.panelTitle);
    hasText(h, tree, r.detail.section.input);
    hasText(h, tree, r.detail.section.output);
    hasText(h, tree, interpolate(r.detail.status, { status: r.tool.status.completed }));
    hasText(h, tree, interpolate(r.detail.emptySection, { section: r.detail.sectionInline.output }));
    hasLabel(h, tree, interpolate(r.detail.copyA11y, { section: r.detail.sectionInline.input }));
    hasLabel(h, tree, r.detail.closeA11y);
    h.unmount();
  });

  test(`${locale}: the step menu translates actions while copying the original command`, async () => {
    const h = createToolHarness("ios", { locale });
    const mounted = h.mount(call, false);
    byId(h, mounted.tree, "tool-summary-row").props.onLongPress();
    let tree = mounted.render();
    hasLabel(h, tree, r.menu.actionsA11y);
    hasLabel(h, tree, r.menu.closeA11y);
    hasText(h, tree, r.menu.copyCommand);
    hasText(h, tree, r.menu.copyResult);
    await byId(h, tree, "step-copy-command").props.onPress();
    assert.equal(h.copies.at(-1), call.detail.command);
    assert.equal(h.toasts.at(-1), r.toast.copied);
    h.unmount();
  });

  test(`${locale}: inline section sentences retain English casing and use approved translated nouns`, () => {
    const h = createToolHarness("ios", { locale });
    const Content = h.load("client/components/step-detail-content.tsx").StepDetailContent;
    const step = { id: "sample", tool: "shell", title: "sample", status: "failed", input: "raw-input", stdout: "", stderr: "", copyResult: "", error: "raw-error" };
    const tree = h.draw({ type: Content, props: { step, tokens: h.tokens } });
    for (const section of Object.keys(r.detail.section)) {
      hasText(h, tree, r.detail.section[section]);
      hasLabel(h, tree, interpolate(r.detail.copyA11y, { section: r.detail.sectionInline[section] }));
      const t = (key, options) => h.translations.runtime.t(h.load("client/messages.ts").messages, key, options);
      for (const key of ["none", "emptySection"]) {
        const sentence = t(`detail.${key}`, { section: t(`detail.sectionInline.${section}`) });
        assert.equal(sentence, interpolate(r.detail[key], { section: r.detail.sectionInline[section] }));
        if (locale === "en") assert.equal(sentence, key === "none" ? `No ${section} was reported.` : `Empty ${section}.`);
      }
      if (["output", "stdout", "stderr"].includes(section)) hasText(h, tree, interpolate(r.detail.emptySection, { section: r.detail.sectionInline[section] }));
    }
    const missing = h.draw({ type: Content, props: { step: { ...step, input: undefined, copyResult: undefined, stdout: undefined, stderr: undefined, error: undefined }, tokens: h.tokens } });
    for (const section of ["input", "output"]) hasText(h, missing, interpolate(r.detail.none, { section: r.detail.sectionInline[section] }));
    hasText(h, tree, interpolate(r.detail.status, { status: r.tool.status.failed }));
    h.unmount();
  });

  test(`${locale}: empty tool bodies interpolate translated status words`, () => {
    const h = createToolHarness("ios", { locale });
    for (const status of ["running", "completed", "failed", "canceled", "waiting"]) {
      for (const [tool, key] of [["plain_text", "noOutput"], ["todo", "noTasks"], ["fetch", "noContent"]]) {
        const Body = h.load("client/components/tool-detail-body.tsx").ToolDetailBody;
        const tree = h.draw({ type: Body, props: { data: { id: "sample", title: "sample", tool, status }, tokens: h.tokens } });
        hasText(h, tree, interpolate(r.tool.detail[key], { status: r.tool.status[status] }));
        if (locale === "en") hasText(h, tree, `${key === "noOutput" ? "No output." : key === "noTasks" ? "No tasks reported." : "No content reported."} Status: ${status}.`);
      }
    }
    h.unmount();
  });

  test(`${locale}: image plurals use the base key and hub plurals select their separate keys`, () => {
    const h = createToolHarness("ios", { locale, userMessage: true, hubCallout: true });
    const messages = h.load("client/messages.ts").messages;
    const t = (key, options) => h.translations.runtime.t(messages, key, options);
    for (const count of [1, 2]) {
      const tree = h.mount({ type: "user_message", text: "sample", imageCount: count }).tree;
      const key = locale === "en" && count !== 1 ? "imagesAttached_other" : "imagesAttached";
      hasText(h, tree, interpolate(r.prompt[key], { count }));
      assert.equal(t("prompt.imagesAttached", { count }), interpolate(r.prompt[key], { count }));
      const Hub = h.load("client/components/hub-callout.tsx").HubCallout;
      const jobs = Array.from({ length: count }, (_, i) => ({ id: `sample-${i}`, status: "running", type: "task" }));
      const cases = [
        [{ kind: "inbox", data: { messages: Array.from({ length: count }, () => ({ from: "sample", body: "sample" })) } }, "messages"],
        [{ kind: "jobs", data: { op: "wait", jobs } }, "waiting"],
        [{ kind: "process", data: { op: "list", daemons: Array.from({ length: count }, () => ({ name: "sample", state: "running" })) } }, "process"],
      ];
      for (const [data, prefix] of cases) {
        const tree = h.draw({ type: Hub, props: { data, tokens: h.tokens } });
        hasText(h, tree, interpolate(r.hub[`${prefix}${count === 1 ? "One" : "Other"}`], { count }));
      }
    }
    h.unmount();
  });

  test(`${locale}: protocol statuses, provider text and diff sentinels remain verbatim`, () => {
    const h = createToolHarness("ios", { locale, hubCallout: true });
    const Hub = h.load("client/components/hub-callout.tsx").HubCallout;
    const tree = h.draw({ type: Hub, props: { data: { kind: "jobs", data: { op: "wait", jobs: [{ id: "sample", type: "task", status: "failed", errorText: "raw provider error" }] } }, tokens: h.tokens } });
    hasText(h, tree, "failed");
    hasText(h, tree, "raw provider error");
    const diff = h.load("client/edit-diff.ts").buildEditDiff({}, { old_string: "old", new_string: "new" });
    assert.ok(diff.diff.includes("\\ No newline at end of file"));
    h.unmount();
  });
}

for (const locale of ["zh-CN", "ja"]) {
  test(`${locale}: the SDK falls back to English for an omitted key`, () => {
    const sdk = createTranslations({}, { locale });
    const partial = structuredClone(resources);
    delete partial[locale].settings.retry;
    const messages = sdk.defineTranslations({ resources: partial });
    assert.equal(sdk.runtime.t(messages, "settings.retry"), resources.en.settings.retry);
    assert.equal(sdk.runtime.t(messages, "settings.title"), resources[locale].settings.title);
    sdk.runtime.dispose();
  });
}

test("changing the app locale updates an open menu, detail panel and generated summary", () => {
  const h = createToolHarness("ios", { width: 390, preferences: { collapsedStepAction: "details" } });
  const mounted = h.mount({ ...call, name: "read", detail: { type: "read", command: "printf sample", content: "raw sample" } }, false);
  byId(h, mounted.tree, "tool-summary-row").props.onPress();
  byId(h, mounted.render(), "tool-summary-row").props.onLongPress();
  for (const locale of ["zh-CN", "ja", "en"]) {
    h.setLocale(locale);
    const tree = mounted.render();
    hasText(h, tree, resources[locale].tool.summary.readFile);
    hasText(h, tree, resources[locale].menu.copyCommand);
    hasLabel(h, tree, resources[locale].detail.panelTitle);
  }
  h.unmount();
});

test("changing the app locale updates a live todo checklist title with unchanged data", () => {
  const h = createToolHarness("ios");
  const mounted = h.mount({ type: "todo", items: [{ text: "Run checks", completed: false }] });
  try {
    for (const locale of ["en", "zh-CN", "ja"]) {
      h.setLocale(locale);
      const tree = mounted.render();
      hasText(h, tree, resources[locale].tool.summary.checklist);
      for (const other of ["en", "zh-CN", "ja"].filter(value => value !== locale)) {
        assert.ok(!h.text(tree).includes(resources[other].tool.summary.checklist));
      }
    }
  } finally {
    h.unmount();
  }
});

for (const [count, expected] of [[1, "1 image attached"], [2, "2 images attached"]]) {
  test(`en: prompt renders the original image plural for count ${count}`, () => {
    const h = createToolHarness("ios", { userMessage: true });
    try {
      const tree = h.mount({ type: "user_message", text: "sample", imageCount: count }).tree;
      assert.ok(h.nodes(tree, node => node.type === "Text" && h.text(node) === expected).length, expected);
    } finally {
      h.unmount();
    }
  });
}

test("host-stored labels retain SDK message tokens and resolve in the presenting locale", () => {
  const h = createToolHarness();
  const panel = h.panels.get("step-details");
  assert.equal(h.translations.isPluginMessage(panel.title), true);
  const screen = h.settingsScreens.get("chat-presentation");
  assert.equal(h.translations.isPluginMessage(screen.title), true);
  for (const locale of ["en", "zh-CN", "ja"]) {
    assert.equal(h.translations.runtime.resolve(panel.title, locale), resources[locale].detail.panelTitle);
    assert.equal(h.translations.runtime.resolve(screen.title, locale), resources[locale].settings.title);
  }
  h.unmount();
});

for (const locale of ["zh-CN", "ja"]) {
  test(`${locale}: a missing settings title renders in English while other labels keep the app locale`, () => {
    const partial = structuredClone(resources);
    delete partial[locale].settings.title;
    const h = createToolHarness("ios", { locale, settingsPage: true, localeResources: partial });
    const Page = h.load("client/settings-page.tsx").ClearChatSettingsPage;
    const tree = h.draw({ type: Page, props: { theme: { colors: {} } } });
    hasText(h, tree, resources.en.settings.title);
    hasText(h, tree, resources[locale].settings.report);
    h.unmount();
  });
}

test("numeric interpolation renders the original ungrouped English reasoning footer", () => {
  const h = createToolHarness("ios", { reasoningTrace: true });
  const ReasoningTrace = h.load("client/components/reasoning-trace.tsx").ReasoningTrace;
  try {
    const tree = h.draw({ type: ReasoningTrace, props: {
      data: { id: "sample", agentModel: "", durationMs: 0, totalTokens: 1000, status: "completed", steps: [] },
      tokens: h.tokens,
      defaultExpanded: true,
    } });
    assert.ok(h.nodes(tree, node => node.type === "Text" && h.text(node) === "Total Tokens: 1000").length);
    hasText(h, tree, `${(1000).toLocaleString()} tokens`);
  } finally {
    h.unmount();
  }
});

const approvedResourceHashes = {
  "en": "274ebec6bbd83950e090c4d03dc5456857eb6d6d28e6db69aa5bde5adcf3a981",
  "zh-CN": "7bed82c643ebdad6e8e837c677e6d60016fc7b58ab6b402e137d45c68485c0f6",
  "ja": "3e220c93b4616f64821bad511687e1fcd1edc96d79f6485aaf6e99cbcb6a1db6"
};

for (const locale of ["en", "zh-CN", "ja"]) {
  test(`${locale}: only the five approved inline section keys are added to the original resource bytes`, () => {
    const text = readFileSync(resolve(__dirname, `../client/locales/${locale}.json`), "utf8");
    const original = text.replace(/    "sectionInline": \{\n(?:      ".*\n){5}    \},\n/, "");
    assert.notEqual(original, text);
    assert.equal(createHash("sha256").update(original).digest("hex"), approvedResourceHashes[locale]);
    assert.deepEqual(resources[locale].detail.sectionInline, Object.fromEntries(Object.entries(resources[locale].detail.section).map(([key, title]) => [key, locale === "en" ? key : title])));
  });
}
