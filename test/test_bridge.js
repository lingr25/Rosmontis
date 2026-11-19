"use strict";

/**
 * Backward-compatible entrypoint for the decomposed Rosmontis bridge test suites.
 *
 * Discovers all `test/bridge/*.test.js` files via `fs.readdirSync` (sorted deterministically,
 * avoiding Windows PowerShell and Node 18 shell glob pitfalls) and executes them in parallel
 * using Node's built-in zero-dependency `node --test` runner.
 *
 * Pass `--all` (used by `npm test`) to also execute `test/test_media_security.js` and
 * `test/test_core_modules.js` in the same parallel `node --test` run.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const extraArgs = process.argv.slice(2);
const includeAllSuites = extraArgs.includes("--all");
const passthroughArgs = extraArgs.filter((arg) => arg !== "--all");

const suitesDir = path.join(__dirname, "bridge");
const testFiles = fs
  .readdirSync(suitesDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(suitesDir, name));

if (testFiles.length === 0) {
  console.error(`No bridge test suites found under ${suitesDir}`);
  process.exit(1);
}

if (includeAllSuites) {
  testFiles.push(
    path.join(__dirname, "test_media_security.js"),
    path.join(__dirname, "test_core_modules.js")
  );
}

const result = spawnSync(process.execPath, ["--test", ...passthroughArgs, ...testFiles], {
  stdio: "inherit",
});

if (result.error) {
  console.error("Failed to launch node --test runner:", result.error);
  process.exit(1);
}

process.exit(typeof result.status === "number" ? result.status : 1);
