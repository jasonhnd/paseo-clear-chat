"use strict";

const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

function settingsVersion(directory, { write = false } = {}) {
  const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
  if (typeof version !== "string" || !version.trim()) throw new Error("package version is missing");
  const file = join(directory, "client", "package-version.svg");
  const expected = `${JSON.stringify({ version }, null, 2)}\n`;
  if (write) {
    mkdirSync(join(directory, "client"), { recursive: true });
    writeFileSync(file, expected);
  } else if (readFileSync(file, "utf8") !== expected) {
    throw new Error("settings version does not match package version");
  }
  return version;
}

module.exports = { settingsVersion };
