const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// What counts as the person's message, and what a row copies. The expected envelope prefixes
// are written out here on purpose: a test that read them from the production table would pass
// even if that table were replaced with something wrong.
// Dates are built from local calendar parts, so the same file passes in UTC and Asia/Tokyo.

const EXPECTED_PREFIXES = [
  "【",
  "[ASYNC DELEGATION",
  "[IMPORTANT",
  "[System:",
  "[T3 Code",
  "<t3_code_instructions>",
  "CONTEXT:",
  "You've reached the maximum number",
  "发件：",
];

function load() {
  const h = createToolHarness("web");
  return { h, kind: h.load("client/user-message-kind.ts"), day: h.load("client/local-day.ts") };
}

test("the envelope table holds exactly the shapes the panel expects", () => {
  const { h, kind } = load();
  assert.deepEqual([...kind.MACHINE_PREFIXES].sort(), [...EXPECTED_PREFIXES].sort());
  for (const prefix of EXPECTED_PREFIXES) {
    assert.equal(kind.classifyUserMessage(`${prefix} written by automation`).kind, "machine", JSON.stringify(prefix));
  }
  h.dispose();
});

test("host envelopes and process lines are machine messages", () => {
  const { h, kind } = load();
  const machine = [
    "<system-reminder>use the tool</system-reminder>",
    "<paseo-system>queued</paseo-system>",
    "<agent-response>{\"ok\":true}</agent-response>",
    "<system-notice>restarted</system-notice>",
    "<irc>:nick!user@host PRIVMSG #chan :hello</irc>",
    "<system-interrupt>stop</system-interrupt>",
    "Supervised process dev exited with code 0",
    "  \n<system-reminder>trimmed too</system-reminder>  ",
  ];
  for (const text of machine) {
    assert.equal(kind.classifyUserMessage(text).kind, "machine", JSON.stringify(text));
  }
  h.dispose();
});

test("a bracketed line a person typed stays the person's message", () => {
  const { h, kind } = load();
  const human = [
    "[1a] 好",
    "[1a] ok",
    "[note] remember to water the plants",
    "(see below) the numbers are wrong",
    "context: lowercase, prose",
    "You've reached the limit of my patience",
    "发件人不是这个前缀",
    "A normal sentence with [brackets] inside",
  ];
  for (const text of human) {
    assert.equal(kind.classifyUserMessage(text).kind, "human", JSON.stringify(text));
  }
  h.dispose();
});

test("a message copies exactly as it was sent, spaces and line endings included", () => {
  const { h, kind } = load();
  const sent = "  first\r\nsecond  ";
  const classified = kind.classifyUserMessage(sent);
  assert.equal(classified.kind, "human");
  assert.equal(classified.text, sent, "trimming decides the kind, never the copy");
  assert.equal(kind.classifyUserMessage("  plain  ").text, "  plain  ");
  assert.equal(kind.classifyUserMessage("line one\r\n\r\nline three").text, "line one\r\n\r\nline three");
  h.dispose();
});

test("a mid-turn message is the person's, and its body is the exact substring", () => {
  const { h, kind } = load();
  const body = "  first\r\nsecond  ";
  const text = [
    "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position]",
    body,
    "[/OUT-OF-BAND USER MESSAGE]",
  ].join("\r\n");
  const classified = kind.classifyUserMessage(text);
  assert.equal(classified.kind, "human", "an inserted message is the person speaking");
  assert.equal(classified.text, body, "the body keeps its own spaces and line endings");
  assert.equal(kind.outOfBandBody(text), body);

  // An opener without a closing marker keeps everything after the marker line.
  const openOnly = `[OUT-OF-BAND USER MESSAGE — inserted]\r\n${body}`;
  assert.equal(kind.outOfBandBody(openOnly), body);

  // A marker quoted inside the body is not the closing marker.
  const quoted = [
    "[OUT-OF-BAND USER MESSAGE — inserted]",
    "The docs say:",
    "[/OUT-OF-BAND USER MESSAGE]",
    "is what ends one.",
    "[/OUT-OF-BAND USER MESSAGE]",
  ].join("\n");
  assert.equal(kind.outOfBandBody(quoted), "The docs say:\n[/OUT-OF-BAND USER MESSAGE]\nis what ends one.");

  // No wrapper, no unwrapping.
  assert.equal(kind.outOfBandBody("just text"), null);
  h.dispose();
});

test("a message with only an image is still the person's message", () => {
  const { h, kind } = load();
  for (const text of ["", "   \n  ", "\n", "\r\n"]) {
    const classified = kind.classifyUserMessage(text);
    assert.equal(classified.kind, "human", JSON.stringify(text));
    assert.equal(kind.isEmptyMessageText(classified.text), true);
  }
  const wrapped = "[OUT-OF-BAND USER MESSAGE — inserted]\n[/OUT-OF-BAND USER MESSAGE]";
  assert.equal(kind.classifyUserMessage(wrapped).kind, "human");
  assert.equal(kind.classifyUserMessage(wrapped).text, "");
  assert.equal(kind.isEmptyMessageText("  text  "), false);
  h.dispose();
});

test("a row shows at most three lines", () => {
  const { h, kind } = load();
  assert.deepEqual(kind.messagePreview("one\ntwo\nthree"), { preview: "one\ntwo\nthree", truncated: false });
  assert.deepEqual(kind.messagePreview("one\ntwo\nthree\nfour"), { preview: "one\ntwo\nthree", truncated: true });
  assert.deepEqual(kind.messagePreview("one\r\ntwo\r\nthree\r\nfour\r\nfive"), { preview: "one\ntwo\nthree", truncated: true });
  h.dispose();
});

test("the local day starts at midnight on this device, not at a UTC hour", () => {
  const { h, day } = load();
  const midnight = new Date(2026, 2, 15, 0, 0, 0, 0).getTime();
  assert.equal(day.startOfLocalDay(new Date(2026, 2, 15, 0, 0, 0, 1).getTime()), midnight);
  assert.equal(day.startOfLocalDay(new Date(2026, 2, 15, 23, 59, 59, 999).getTime()), midnight);
  assert.equal(day.localDayStartBefore(midnight + 5, 0), midnight);
  assert.equal(day.localDayStartBefore(midnight + 5, 1), new Date(2026, 2, 14, 0, 0, 0, 0).getTime());
  assert.equal(day.localDayStartBefore(midnight + 5, -1), new Date(2026, 2, 16, 0, 0, 0, 0).getTime());
  h.dispose();
});

test("a clock reads back as HH:MM on this device", () => {
  const { h, day } = load();
  assert.equal(day.formatClock(new Date(2026, 2, 15, 7, 5).getTime()), "07:05");
  assert.equal(day.formatClock(new Date(2026, 2, 15, 23, 59).getTime()), "23:59");
  assert.equal(day.formatClock(new Date(2026, 2, 15, 0, 0).getTime()), "00:00");
  h.dispose();
});
