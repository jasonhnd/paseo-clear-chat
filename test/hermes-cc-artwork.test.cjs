const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const artifact = resolve(__dirname, "../server/hermes-cc/hermes.svg");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

test("Hermes artwork is the unmodified, self-contained Paseo v0.13.2 SVG", async () => {
  const { findSvgIconProblem } = await import("@getpaseo/plugin");
  const bytes = readFileSync(artifact);
  assert.equal(bytes.length, 19710);
  assert.equal(sha256(bytes), "668177870402aa29fc1be5e986310b8040c12457a6a6773526c8f17557ebf2d0");
  const svg = bytes.toString("utf8");
  assert.equal(findSvgIconProblem(svg), null);
  assert.doesNotMatch(svg, /<\s*(?:script|foreignObject)\b/i);
  // XML namespace identifiers are not external resource requests.
  const content = svg.replace(/\sxmlns(?::[\w-]+)?\s*=\s*(["']).*?\1/g, "");
  assert.doesNotMatch(content, /(?:https?:|\/\/|url\s*\(|<!DOCTYPE|<!ENTITY)/i);
});

test("artwork attribution retains the entire pinned upstream license", () => {
  const license = readFileSync(`${artifact}.LICENSE`, "utf8");
  const upstreamStart = license.indexOf("Copyright (c) 2025-present Mohamed Boudra");
  assert.ok(upstreamStart > 0);
  assert.equal(sha256(license.slice(upstreamStart)),
    "79d5aedce6aa0adc547336dc1bd34c5cc9308ba110fac7079ed97515ee573ad3");
  const attribution = license.slice(0, upstreamStart);
  assert.match(attribution, /d2941157a8f91512daf54fc688241d416e8f5ebd/);
  assert.match(attribution, /acp-provider-icons\/hermes\.svg/);
  assert.match(attribution, /unmodified and used only to identify Hermes/);
  assert.match(attribution, /does not\s+imply affiliation with or endorsement/);
});
