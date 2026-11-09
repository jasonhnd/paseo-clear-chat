#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const versionPattern = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){3}$/;
const metadataFiles = ["package.json", "package-lock.json", "paseo-plugin.json"];
const textFiles = ["README.md", "README.zh-CN.md", "OVERVIEW.md", "OVERVIEW.zh-CN.md", "CHANGELOG.md"];

function run(args) {
  const versions = args.filter(arg => arg !== "--dry-run");
  if (versions.length !== 1 || args.length !== versions.length + Number(args.includes("--dry-run")) || !versionPattern.test(versions[0])) {
    throw new Error("Usage: node scripts/bump-version.cjs <MAJOR.MINOR.PATCH.N> [--dry-run]");
  }
  const next = versions[0], dryRun = args.includes("--dry-run");
  const read = name => fs.readFileSync(path.join(root, name), "utf8");
  const [pkg, lock, manifest] = metadataFiles.map(name => JSON.parse(read(name)));
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!isObject(pkg) || typeof pkg.version !== "string" || !versionPattern.test(pkg.version)) throw new Error("package.json has an invalid version");
  const current = pkg.version;
  if (current === next) throw new Error("New version is the same as the current version");
  if (!isObject(lock) || !isObject(lock.packages) || !isObject(lock.packages[""]) || lock.version !== current || lock.packages[""].version !== current) {
    throw new Error("package-lock.json versions do not match package.json");
  }
  if (!isObject(manifest) || (Object.hasOwn(manifest, "version") && manifest.version !== current)) {
    throw new Error("paseo-plugin.json has an invalid version");
  }
  const prefix = `v${current} · `;
  if (typeof manifest.description !== "string" || !manifest.description.startsWith(prefix)) {
    throw new Error("paseo-plugin.json description has an invalid version prefix");
  }
  const wording = manifest.description.slice(prefix.length);
  if (!wording.trim() || /^v\S+\s*·/.test(wording)) throw new Error("paseo-plugin.json description has invalid wording");
  manifest.description = `v${next} · ${wording}`;
  pkg.version = lock.version = lock.packages[""].version = next;
  if (Object.hasOwn(manifest, "version")) manifest.version = next;

  // Read every document before writing metadata, so missing files cannot cause a partial update.
  const oldHost = current.split(".").slice(0, 3).join(".");
  const hostChanged = oldHost !== next.split(".").slice(0, 3).join(".");
  const report = textFiles.flatMap(name => read(name).split(/\r?\n/).flatMap((line, index) =>
    line.includes(current) || (hostChanged && name.startsWith("README") && line.includes(`tested%20${oldHost}`))
      ? [`${name}:${index + 1}: ${line}`] : []));
  console.log(`Version: ${current} -> ${next}${dryRun ? " (dry run)" : ""}`);
  console.log(`Metadata to update: ${metadataFiles.join(", ")}`);
  console.log("Human edits needed:");
  console.log(report.length ? report.join("\n") : "  None found.");
  if (!dryRun) {
    for (const [index, data] of [pkg, lock, manifest].entries()) {
      fs.writeFileSync(path.join(root, metadataFiles[index]), `${JSON.stringify(data, null, 2)}\n`);
    }
  }
}

try { run(process.argv.slice(2)); }
catch (error) {
  console.error(`Version bump failed: ${error.message}`);
  process.exitCode = 1;
}
