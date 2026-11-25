const assert = require("node:assert/strict");
const test = require("node:test");
const { createToolHarness } = require("./helpers/tool-harness.cjs");

// The "what I said" panel counts a user-side row as the person's own message or as a message
// written by automation. These tests pin the whole prefix table, the mid-turn wrapper, and the
// local-day boundary the panel's "today" uses. They run unchanged in any time zone: every
// expectation is built from local calendar parts, never from a UTC hour.

function load() {
  const h = createToolHarness("web");
  return { h, kind: h.load("client/user-message-kind.ts"), day: h.load("client/local-day.ts") };
}

test("every table prefix is a machine message", () => {
  const { h, kind } = load();
  const prefixes = kind.MACHINE_PREFIXES;
  assert.ok(prefixes.length >= 9, "the table lists every known envelope shape");
  for (const prefix of prefixes) {
    const text = `${prefix} something the automation wrote`;
    assert.deepEqual(kind.classifyUserMessage(text).kind, "machine", JSON.stringify(prefix));
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

test("a mid-turn message counts as the person's, without its markers", () => {
  const { h, kind } = load();
  const text = [
    "[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position]",
    "Actually, use the second option.",
    "And keep the draft.",
    "[/OUT-OF-BAND USER MESSAGE]",
  ].join("\n");
  const classified = kind.classifyUserMessage(text);
  assert.equal(classified.kind, "human", "an inserted message is the person speaking");
  assert.equal(classified.text, "Actually, use the second option.\nAnd keep the draft.");
  assert.equal(kind.outOfBandBody(text), classified.text);

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
  for (const text of ["", "   \n  ", "\n"]) {
    const classified = kind.classifyUserMessage(text);
    assert.equal(classified.kind, "human", JSON.stringify(text));
    assert.equal(classified.text, "");
  }
  assert.deepEqual(kind.classifyUserMessage("[OUT-OF-BAND USER MESSAGE — inserted]\n[/OUT-OF-BAND USER MESSAGE]"), { kind: "human", text: "" });
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
  assert.equal(day.startOfLocalDay(new Date(2026, 2, 16, 0, 0, 0, 0).getTime()), new Date(2026, 2, 16, 0, 0, 0, 0).getTime());
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
