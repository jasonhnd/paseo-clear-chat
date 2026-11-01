#!/usr/bin/env node
"use strict";

// Run from any directory: node scripts/pre-release-check.cjs [old-version ...]
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const failed = new Set();
const versionPattern = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){3}$/;
const ignored = new Set([".git", "node_modules", ".tmp", "dist"]);
const ignoredFiles = new Set([".showcase/showcase.js", ".showcase/tools/collect.cjs"]);
// These exact lines document the older-host release and its known history.
const legacyVersion = [0, 13, 2, 2].join(".");
const compatibilityLines = {
  "README.md": new Set([
    "Still on Paseo 0.13? Clear Chat " + legacyVersion + " is already released and declares support for Paseo 0.13.0 or later. The exact installation command below has not yet been tested on Paseo 0.13:",
    "paseo plugin install git:jasonhnd/paseo-clear-chat --ref v" + legacyVersion,
    "paseo plugin update clear-chat --ref v" + legacyVersion + " --yes",
    "**Previously affected conversations.** Clear Chat " + legacyVersion + " prevents a compatibility issue in which certain failed tool calls with no error message could make a **·CC** conversation's history fail to open. Conversations already affected by this issue may still fail to open after upgrading; there is currently no automatic fix for those affected conversations."
  ]),
  "README.zh-CN.md": new Set([
    "还在用 Paseo 0.13？Clear Chat " + legacyVersion + " 已经发布，并声明支持 Paseo 0.13.0 或更新版本。下面这条安装命令尚未在 Paseo 0.13 上实测：",
    "paseo plugin install git:jasonhnd/paseo-clear-chat --ref v" + legacyVersion,
    "paseo plugin update clear-chat --ref v" + legacyVersion + " --yes",
    "**已经受影响的旧对话。** Clear Chat " + legacyVersion + " 可以防止以后因某些工具调用失败且没有错误信息，导致 **·CC** 对话的历史打不开。已经受这个问题影响的旧对话升级后仍可能打不开，目前还没有自动修复这些对话的办法。"
  ]),
  "README.ja.md": new Set([
    "Paseo 0.13 を使い続ける場合、公開済みの Clear Chat " + legacyVersion + " は Paseo 0.13.0 以降への対応を明記しています。以下のインストールコマンドは Paseo 0.13 でまだ実機確認していません：",
    "paseo plugin install git:jasonhnd/paseo-clear-chat --ref v" + legacyVersion,
    "paseo plugin update clear-chat --ref v" + legacyVersion + " --yes",
    "**すでに影響を受けた会話。** Clear Chat " + legacyVersion + " は、一部のツール呼び出しが失敗してエラーメッセージがないときに、**·CC** の会話履歴を開けなくなる互換性の問題を今後防ぎます。すでにこの問題の影響を受けた会話は、アップグレード後も開けない場合があります。現在、それらの会話を自動で修復する方法はありません。"
  ]),
};
const signoff = ["package.json", "package-lock.json", "paseo-plugin.json", "CHANGELOG.md",
  "README.md", "README.zh-CN.md", "README.ja.md", "OVERVIEW.md", "OVERVIEW.zh-CN.md",
  "scripts/pre-release-check.cjs"];

function fail(item, location, message) {
  failed.add(item);
  console.error(`FAIL ${item}: ${location}: ${message}`);
}
function read(name, item) {
  try { return fs.readFileSync(path.join(root, name), "utf8"); }
  catch (error) { fail(item, `${name}:1`, error.message); return null; }
}
function parse(name) {
  const text = read(name, "version consistency");
  if (text === null) return null;
  try { return JSON.parse(text); }
  catch (error) {
    const offset = /position (\d+)/.exec(error.message)?.[1];
    const line = offset === undefined ? 1 : text.slice(0, Number(offset)).split("\n").length;
    fail("version consistency", `${name}:${line}`, `invalid JSON: ${error.message}`);
    return null;
  }
}
function keyLines(name, key) {
  const text = read(name, "version consistency");
  if (text === null) return [];
  return text.split("\n").flatMap((line, i) => line.includes(`"${key}"`) && /^\s*"/.test(line) ? [i + 1] : []);
}
function compare(name, line, label, value, expected, valid = true) {
  const location = `${name}:${line || 1}`;
  console.log(`${location} ${label}: ${value === undefined ? "<missing>" : JSON.stringify(value)}`);
  if (!valid || value !== expected) fail("version consistency", location, `${label} must be ${JSON.stringify(expected)}`);
}

console.log("Version consistency");
const pkg = parse("package.json");
const lock = parse("package-lock.json");
const manifest = parse("paseo-plugin.json");
const version = pkg?.version;
const pkgLine = keyLines("package.json", "version")[0];
compare("package.json", pkgLine, "version", version, version, typeof version === "string" && versionPattern.test(version));
const lockLines = keyLines("package-lock.json", "version");
compare("package-lock.json", lockLines[0], "version", lock?.version, version, typeof version === "string");
compare("package-lock.json", lockLines[1], 'packages[""].version', lock?.packages?.[""]?.version, version, typeof version === "string");
const descriptionLines = keyLines("paseo-plugin.json", "description");
const translations = manifest?.translations;
if (!translations || typeof translations !== "object" || Array.isArray(translations) || !Object.keys(translations).length) {
  fail("version consistency", "paseo-plugin.json:1", "translations are missing");
}
const descriptions = [["description", manifest?.description], ...Object.entries(translations || {}).map(([lang, entry]) => [`translations.${lang}.description`, entry?.description])];
descriptions.forEach(([label, description], i) => {
  const match = typeof description === "string" && /^v((?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){3}) · (.+)$/u.exec(description);
  compare("paseo-plugin.json", descriptionLines[i], label + " prefix", match?.[1], version,
    Boolean(match && match[2].trim() && !/^v\S+\s*·/.test(match[2]) && typeof version === "string"));
});

console.log("\nStale version scan");
const changelog = read("CHANGELOG.md", "stale version scan");
let versions = process.argv.slice(2);
if (!versions.length && changelog !== null) {
  const releases = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map(match => match[1]);
  const current = releases.indexOf(version);
  const previous = current < 0 ? [] : releases.slice(current + 1, current + 3);
  if (previous.length < 2) {
    fail("stale version scan", "CHANGELOG.md:1", "cannot find two releases before the package version; supply versions as arguments");
  } else versions = previous;
}
if (versions.some(value => !value || /[\r\n]/.test(value))) fail("stale version scan", "scripts/pre-release-check.cjs:1", "version arguments must be nonempty single-line strings");
console.log(`Searching for: ${versions.map(value => JSON.stringify(value)).join(", ") || "<none>"}`);
console.log("Excludes Git data, installed dependencies, generated build files, historical changelog sections, and documented older-host references.");
function walk(dir = "") {
  let entries;
  try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); }
  catch (error) { fail("stale version scan", `${dir || "."}:1`, error.message); return []; }
  return entries.sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const name = path.posix.join(dir, entry.name);
    if (ignored.has(entry.name) || ignoredFiles.has(name) || name === ".showcase/.capture-temp" || name.endsWith(".tsbuildinfo")) return [];
    if (entry.isDirectory()) return walk(name);
    if (entry.isFile()) return [name];
    fail("stale version scan", `${name}:1`, "cannot scan non-regular file");
    return [];
  });
}
const files = walk();
for (const name of files) {
  let contents;
  try { contents = fs.readFileSync(path.join(root, name)); }
  catch (error) { fail("stale version scan", `${name}:1`, error.message); continue; }
  const lines = contents.toString("utf8").split("\n");
  let releaseSections = 0;
  let latestRelease;
  lines.forEach((line, i) => {
    if (name === "CHANGELOG.md") {
      const heading = /^## \[([^\]]+)\]/.exec(line);
      if (heading) { releaseSections++; latestRelease ||= heading[1]; }
      const reference = /^\[([^\]]+)\]:\s/.exec(line);
      if (reference ? reference[1] !== latestRelease : releaseSections > 1) return;
    }
    for (const old of versions) if (old && !/[\r\n]/.test(old) && line.includes(old) && !(old === legacyVersion && compatibilityLines[name]?.delete(line))) fail("stale version scan", `${name}:${i + 1}`, `found ${JSON.stringify(old)}`);
  });
}
if (!failed.has("stale version scan")) console.log("PASS stale version scan");

console.log("\nVerification");
for (const [command, args] of [["npm", ["test"]], ["npx", ["tsc", "--noEmit"]]]) {
  console.log(`Running ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  const code = result.status === null ? `not available (${result.error?.message || result.signal})` : result.status;
  console.log(`${command} ${args.join(" ")} exit code: ${code}`);
  if (result.status !== 0) fail("verification", "package.json:1", `${command} ${args.join(" ")} failed: ${code}`);
}

console.log("\nSignature sheet (release metadata and documentation)");
console.log("| File | SHA-256 |");
console.log("| --- | --- |");
for (const name of signoff) {
  try { console.log(`| ${name} | ${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex")} |`); }
  catch (error) { fail("signature sheet", `${name}:1`, error.message); }
}
if (failed.size) {
  console.error(`\nFailed items: ${[...failed].join(", ")}`);
  process.exitCode = 1;
} else console.log("\nPASS all pre-release checks");
