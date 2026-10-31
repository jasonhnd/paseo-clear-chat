"use strict";

const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");
const { stripVTControlCharacters } = require("node:util");
const { manifestVersion } = require("./manifest-version.cjs");
const { settingsVersion } = require("./settings-version.cjs");

function install({ run = spawnSync, resolveDependency = require.resolve, report = console.error } = {}) {
  const checkout = resolve(__dirname, "..");
  try {
    manifestVersion(checkout, { allowStale: true });
  } catch (error) {
    report(`Clear Chat manifest version check failed: ${error.message}`);
    return 1;
  }
  let result;
  try {
    result = run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--include=dev"], {
      cwd: checkout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, shell: process.platform === "win32",
    });
  } catch (error) {
    result = { error };
  }
  if (result.error || result.status !== 0) {
    let detail = "";
    if (result.error && result.error.code !== "ENOBUFS") {
      const message = stripVTControlCharacters(String(result.error.message || result.error)).split(/\r?\n/)[0];
      detail = `\nnpm could not start: ${message}`;
    } else {
      if (result.error) detail = "\nnpm failed: too much output (maxBuffer exceeded).";
      const stderr = stripVTControlCharacters(result.stderr || "").trimEnd();
      const output = stderr || stripVTControlCharacters(result.stdout || "").trimEnd();
      const tail = output.split(/\r?\n/).slice(-20).join("\n");
      if (tail) detail += `\n${tail.length > 4000 ? "(truncated)\n" : ""}${tail.slice(-4000)}`;
    }
    report("Clear Chat dependencies could not be installed. Check that Node.js and npm are available on the daemon host and that its network can reach the npm registry, then retry the installation with the Paseo CLI." + detail);
    return 1;
  }

  const dependencies = [
    ...Object.keys(require("../package.json").dependencies), "@getpaseo/plugin", "zod",
    "@shikijs/langs/typescript", "@shikijs/themes/github-dark-default", "@shikijs/themes/github-light-default",
  ];
  for (const name of dependencies) {
    try {
      resolveDependency(name);
    } catch {
      report(`Clear Chat could not find ${name}. Run npm ci --include=dev in the plugin checkout on the daemon host, then retry the installation with the Paseo CLI.`);
      return 1;
    }
  }
  try {
    manifestVersion(checkout, { write: true });
    manifestVersion(checkout);
    settingsVersion(checkout, { write: true });
    settingsVersion(checkout);
  } catch (error) {
    report(`Clear Chat manifest version check failed: ${error.message}`);
    return 1;
  }
  return 0;
}

module.exports = { install };
if (require.main === module) process.exitCode = install();
