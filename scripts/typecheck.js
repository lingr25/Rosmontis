#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Pragmatic zero-runtime-dependency JSDoc TypeScript checker (`scripts/typecheck.js`).
 *
 * - Reports `// @ts-check` coverage across `src/**\/*.js`.
 * - Resolves `tsc` in order:
 *   1. Local `node_modules/.bin/tsc` (when `@types/node` is also present locally and `--install` is not set)
 *   2. Global `tsc` on PATH (when `@types/node` is resolvable and `--install` is not set)
 *   3. Isolated `os.tmpdir()` workspace installing `typescript` + `@types/node` without touching repo files
 *      - `--install` uses a fresh ephemeral temp dir and removes it on exit (ideal for CI)
 *      - Default fallback reuses a cached dir inside `os.tmpdir()` for fast local reruns (`--clean` resets it)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const JSCONFIG_PATH = path.join(REPO_ROOT, "jsconfig.json");

/**
 * Recursively list `.js` files under `dirPath` in deterministic POSIX-sorted order.
 * @param {string} dirPath
 * @returns {string[]}
 */
function walkJsFiles(dirPath) {
  /** @type {string[]} */
  const files = [];
  if (!fs.existsSync(dirPath)) return files;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Scan `src/**\/*.js` for `// @ts-check` directives in the leading file header.
 * @returns {{ total: number, checked: number, percent: string, uncovered: string[] }}
 */
function collectTsCheckCoverage() {
  const files = walkJsFiles(SRC_DIR);
  /** @type {string[]} */
  const uncovered = [];
  let checked = 0;

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const headerLines = raw.split(/\r?\n/).slice(0, 10);
    const enabled = headerLines.some((line) => /^\s*\/\/\s*@ts-check\b/.test(line));
    if (enabled) {
      checked += 1;
    } else {
      uncovered.push(path.relative(REPO_ROOT, filePath).replace(/\\/g, "/"));
    }
  }

  const total = files.length;
  const percent = total > 0 ? ((checked / total) * 100).toFixed(1) : "0.0";
  return { total, checked, percent, uncovered };
}

/**
 * Run `npm` with the given argument vector across Windows and POSIX without mutating the repo.
 * @param {string[]} args
 * @param {{ capture?: boolean }} [opts]
 * @returns {import("child_process").SpawnSyncReturns<string>}
 */
function runNpm(args, opts) {
  const capture = Boolean(opts && opts.capture);
  const stdio = capture ? ["ignore", "pipe", "pipe"] : "inherit";
  const npmCliJs = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

  if (fs.existsSync(npmCliJs)) {
    return spawnSync(process.execPath, [npmCliJs, ...args], {
      cwd: REPO_ROOT,
      stdio,
      encoding: "utf8",
    });
  }

  if (process.platform === "win32") {
    const quoted = args.map((arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
    return spawnSync(`npm ${quoted}`, {
      cwd: REPO_ROOT,
      stdio,
      encoding: "utf8",
      shell: true,
    });
  }

  return spawnSync("npm", args, {
    cwd: REPO_ROOT,
    stdio,
    encoding: "utf8",
  });
}

/**
 * Locate the JS entrypoint `typescript/bin/tsc` under a prefix directory if present.
 * @param {string} baseDir
 * @returns {{ tscJs: string, typeRoots: string } | null}
 */
function resolvePrefixToolchain(baseDir) {
  const tscJs = path.join(baseDir, "node_modules", "typescript", "bin", "tsc");
  const nodeTypes = path.join(baseDir, "node_modules", "@types", "node");
  if (fs.existsSync(tscJs) && fs.existsSync(nodeTypes)) {
    return {
      tscJs,
      typeRoots: path.join(baseDir, "node_modules", "@types"),
    };
  }
  return null;
}

/**
 * Attempt to find a usable local `node_modules/.bin/tsc` (or `node_modules/typescript/bin/tsc`).
 * @returns {{ mode: "node" | "bin", executable: string, typeRoots: string | null } | null}
 */
function resolveLocalTsc() {
  const localTypeRoots = path.join(REPO_ROOT, "node_modules", "@types");
  const hasLocalNodeTypes = fs.existsSync(path.join(localTypeRoots, "node"));
  if (!hasLocalNodeTypes) return null;

  const localTscJs = path.join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  if (fs.existsSync(localTscJs)) {
    return { mode: "node", executable: localTscJs, typeRoots: localTypeRoots };
  }

  const binName = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const localBin = path.join(REPO_ROOT, "node_modules", ".bin", binName);
  if (fs.existsSync(localBin)) {
    return { mode: "bin", executable: localBin, typeRoots: localTypeRoots };
  }
  return null;
}

/**
 * Attempt to find a global `tsc` together with a resolvable `@types/node`.
 * @returns {{ mode: "node" | "bin", executable: string, typeRoots: string } | null}
 */
function resolveGlobalTsc() {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const whichRes = spawnSync(locator, ["tsc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (whichRes.status !== 0 || !whichRes.stdout) return null;

  const firstMatch = whichRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstMatch) return null;

  const candidateRoots = [path.join(REPO_ROOT, "node_modules", "@types")];
  const npmRootRes = runNpm(["root", "-g"], { capture: true });
  if (npmRootRes.status === 0 && npmRootRes.stdout) {
    const globalRoot = npmRootRes.stdout.trim();
    if (globalRoot) {
      candidateRoots.push(path.join(globalRoot, "@types"));
      const globalTscJs = path.join(globalRoot, "typescript", "bin", "tsc");
      const matchedTypes = candidateRoots.find((dir) => fs.existsSync(path.join(dir, "node")));
      if (matchedTypes && fs.existsSync(globalTscJs)) {
        return { mode: "node", executable: globalTscJs, typeRoots: matchedTypes };
      }
    }
  }

  const matchedTypes = candidateRoots.find((dir) => fs.existsSync(path.join(dir, "node")));
  if (!matchedTypes) return null;
  return { mode: "bin", executable: firstMatch, typeRoots: matchedTypes };
}

/**
 * Install `typescript` and `@types/node` into an isolated temp directory outside the repository.
 * @param {string} targetDir
 * @returns {{ tscJs: string, typeRoots: string }}
 */
function installIsolatedToolchain(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  console.log(`[typecheck] Installing typescript + @types/node in isolated temp dir: ${targetDir}`);
  const res = runNpm([
    "--prefix",
    targetDir,
    "install",
    "--no-save",
    "--no-audit",
    "--no-fund",
    "typescript",
    "@types/node",
  ]);
  if (res.error) {
    throw new Error(`Failed to invoke npm: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`npm install exited with status ${res.status}`);
  }
  const toolchain = resolvePrefixToolchain(targetDir);
  if (!toolchain) {
    throw new Error(`Isolated toolchain missing tsc or @types/node under ${targetDir}`);
  }
  return toolchain;
}

/**
 * Execute `tsc --noEmit -p jsconfig.json` with optional `--typeRoots`.
 * @param {{ mode: "node" | "bin", executable: string, typeRoots: string | null }} tool
 * @returns {number}
 */
function runTsc(tool) {
  const tscArgs = ["--noEmit", "-p", JSCONFIG_PATH];
  if (tool.typeRoots) {
    tscArgs.push("--typeRoots", tool.typeRoots);
  }

  let res;
  if (tool.mode === "node") {
    res = spawnSync(process.execPath, [tool.executable, ...tscArgs], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  } else if (process.platform === "win32" && /\.(cmd|bat)$/i.test(tool.executable)) {
    const quotedExe = `"${tool.executable.replace(/"/g, '\\"')}"`;
    const quotedArgs = tscArgs.map((arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(" ");
    res = spawnSync(`${quotedExe} ${quotedArgs}`, {
      cwd: REPO_ROOT,
      stdio: "inherit",
      shell: true,
    });
  } else {
    res = spawnSync(tool.executable, tscArgs, {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }

  if (res.error) {
    throw new Error(`Failed to execute tsc: ${res.error.message}`);
  }
  return typeof res.status === "number" ? res.status : 1;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const forceInstall = args.has("--install");
  const cleanCache = args.has("--clean");
  const verbose = args.has("--verbose");
  const coverageOnly = args.has("--coverage-only");

  const coverage = collectTsCheckCoverage();
  console.log(
    `[typecheck] @ts-check coverage: ${coverage.checked}/${coverage.total} src files (${coverage.percent}%)`
  );
  if (verbose && coverage.uncovered.length > 0) {
    console.log("[typecheck] Uncovered src files:");
    for (const rel of coverage.uncovered) {
      console.log(`  - ${rel}`);
    }
  }
  if (coverageOnly) {
    process.exit(0);
  }

  if (!forceInstall) {
    const localTool = resolveLocalTsc();
    if (localTool) {
      console.log(`[typecheck] Using local tsc: ${localTool.executable}`);
      const code = runTsc(localTool);
      if (code === 0) console.log("[typecheck] Passed with 0 errors.");
      process.exit(code);
    }

    const globalTool = resolveGlobalTsc();
    if (globalTool) {
      console.log(`[typecheck] Using global tsc: ${globalTool.executable}`);
      const code = runTsc(globalTool);
      if (code === 0) console.log("[typecheck] Passed with 0 errors.");
      process.exit(code);
    }
  }

  const ephemeral = forceInstall;
  const tmpDir = ephemeral
    ? fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis-tsc-"))
    : path.join(os.tmpdir(), "rosmontis-tsc-cache");

  if (!ephemeral && cleanCache && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  try {
    let toolchain = !ephemeral ? resolvePrefixToolchain(tmpDir) : null;
    if (toolchain) {
      console.log(`[typecheck] Using cached isolated toolchain: ${tmpDir}`);
    } else {
      toolchain = installIsolatedToolchain(tmpDir);
    }

    const exitCode = runTsc({
      mode: "node",
      executable: toolchain.tscJs,
      typeRoots: toolchain.typeRoots,
    });
    if (exitCode === 0) {
      console.log("[typecheck] Passed with 0 errors.");
    }
    process.exitCode = exitCode;
  } finally {
    if (ephemeral && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (err) {
  const msg = err && err.message ? err.message : String(err);
  console.error(`[typecheck] Error: ${msg}`);
  process.exit(1);
}
