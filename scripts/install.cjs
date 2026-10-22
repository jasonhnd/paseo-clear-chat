"use strict";

const { spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

function install({ run = spawnSync, resolveDependency = require.resolve, report = console.error } = {}) {
  const checkout = resolve(__dirname, "..");
  try {
    const result = run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--include=dev"], {
      cwd: checkout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, shell: process.platform === "win32",
    });
    if (result.error || result.status !== 0) throw new Error("Install failed");
  } catch {
    report("Clear Chat dependencies could not be installed. Check that Node.js and npm are available on the daemon host and that its network can reach the npm registry, then retry the installation with the Paseo CLI.");
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
  return 0;
}

module.exports = { install };
if (require.main === module) process.exitCode = install();
