"use strict";

const { readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

function manifestVersion(directory, { write = false } = {}) {
  const read = name => JSON.parse(readFileSync(resolve(directory, name), "utf8"));
  const pkg = read("package.json");
  const lock = read("package-lock.json");
  const manifest = read("paseo-plugin.json");
  const version = pkg.version;
  if (typeof version !== "string" || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){3}$/.test(version)) {
    throw new Error("package.json must contain a four-part version");
  }
  if (lock.version !== version || lock.packages?.[""]?.version !== version) {
    throw new Error("package-lock.json version does not match package.json");
  }
  const paths = [manifest, manifest.translations?.["zh-CN"]];
  for (const entry of paths) {
    if (typeof entry?.description !== "string" || !entry.description.trim()) {
      throw new Error("manifest description is missing");
    }
    const description = entry.description.replace(/^v\d+(?:\.\d+){3} · /, "");
    if (!description.trim() || /^v\S+ · /.test(description)) {
      throw new Error("manifest description has an invalid version prefix");
    }
    const expected = `v${version} · ${description}`;
    if (!write && entry.description !== expected) {
      throw new Error("manifest description version does not match package.json");
    }
    entry.description = expected;
  }
  if (write) writeFileSync(resolve(directory, "paseo-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

module.exports = { manifestVersion };
if (require.main === module) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--write") throw new Error("Use --write to update the manifest");
    manifestVersion(resolve(__dirname, ".."), { write: true });
  } catch (error) {
    console.error(`Clear Chat manifest version: ${error.message}`);
    process.exitCode = 1;
  }
}
