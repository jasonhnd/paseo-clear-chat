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
  // Install from the committed lockfile only. Dependency lifecycle scripts stay off:
  // every package in the lock that declares one (esbuild, fsevents, msgpackr-extract,
  // node-pty) is development-only tooling pulled in by @getpaseo/server and the test
  // toolchain. The plugin runtime loads host-provided libraries plus zod, all plain
  // JavaScript, so no lifecycle script may fetch or build one. npm ci still installs
  // the platform packages the lock names, such as @esbuild/darwin-arm64.
  let result;
  try {
    result = run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--include=dev", "--ignore-scripts"], {
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

  const packageJson = require("../package.json");
  const dependencies = [
    ...Object.keys(packageJson.dependencies ?? {}),
    "@getpaseo/plugin",
    "zod",
  ];
  for (const name of dependencies) {
    try {
      resolveDependency(name);
    } catch {
      report(`Clear Chat could not find ${name}. Run npm ci --include=dev --ignore-scripts in the plugin checkout on the daemon host, then retry the installation with the Paseo CLI.`);
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
