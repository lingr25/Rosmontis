// @ts-check
"use strict";

/**
 * Shared test harness utilities and module imports for `test/bridge/*.test.js`.
 * Underscore-prefixed so `node --test` and `test/test_bridge.js` do not execute it as a test suite.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

// Silence throttled degrade/blocked-replay warnings and keep app_launcher in test mode.
process.env.ROSMONTIS_QUIET = process.env.ROSMONTIS_QUIET || "1";
process.env.ROSMONTIS_TEST_MODE = process.env.ROSMONTIS_TEST_MODE || "1";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const onebot = require(path.join(REPO_ROOT, "src", "bridge_onebot.js"));
const rendererMod = require(path.join(REPO_ROOT, "src", "bridge_renderer.js"));
const mainMod = require(path.join(REPO_ROOT, "src", "bridge_main.js"));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function saveEnvVars(keys) {
  const snapshot = new Map();
  for (const key of keys) {
    snapshot.set(
      key,
      Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined
    );
  }
  return () => {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function makeTempDir(prefix = "rosmontis-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = {
  REPO_ROOT,
  onebot,
  rendererMod,
  mainMod,
  sleep,
  saveEnvVars,
  makeTempDir,
};
