// @ts-check
"use strict";

/**
 * NTQQ Version Metadata & Dynamic User-Agent Builder (`src/core/ntqq_meta.js`)
 *
 * Reads the installed QQ NT application manifest (when present) to synthesize
 * a consistent desktop Chromium/QQ User-Agent string without hardcoding stale versions.
 */

const fs = require("fs");
const path = require("path");

/**
 * @typedef {object} NtqqVersionMetadata
 * @property {string} qqVersion
 * @property {string} buildVersion
 * @property {string} chromeVersion
 * @property {string} userAgent
 */

/**
 * @typedef {object} NtqqVersionOptions
 * @property {boolean} [forceRefresh]
 * @property {string[]} [packagePaths]
 * @property {string} [chromeVersion]
 */

/** @type {NtqqVersionMetadata | null} */
let _cachedVersionMeta = null;

/**
 * Resolves QQ NT version metadata and desktop Chromium User-Agent string.
 *
 * @param {NtqqVersionOptions} [options={}]
 * @returns {NtqqVersionMetadata}
 */
function getNtqqVersionMetadata(options = {}) {
  if (_cachedVersionMeta && !options.forceRefresh && !options.packagePaths && !options.chromeVersion) {
    return _cachedVersionMeta;
  }
  const proc = /** @type {NodeJS.Process & { resourcesPath?: string }} */ (
    typeof process !== "undefined" ? process : undefined
  );
  const electronAppPkg =
    proc &&
    typeof proc.resourcesPath === "string" &&
    proc.resourcesPath.trim()
      ? path.join(proc.resourcesPath.trim(), "app", "package.json")
      : "";
  const candidatePaths =
    options.packagePaths ||
    [
      "/opt/QQ/resources/app/package.orig.json",
      "/opt/QQ/resources/app/package.json",
      electronAppPkg,
      path.resolve(__dirname, "..", "package_patch.json"),
      path.join(__dirname, "package_patch.json"),
    ].filter(Boolean);
  let qqVersion = "3.2.32-52194";
  let buildVersion = "52194";
  for (const pkgPath of candidatePaths) {
    try {
      if (pkgPath && fs.existsSync(pkgPath)) {
        const raw = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (raw && typeof raw.version === "string" && raw.version.trim()) {
          qqVersion = raw.version.trim();
          buildVersion = String(raw.buildVersion || qqVersion.split("-")[1] || buildVersion);
          break;
        }
      }
    } catch (_err) {
      // Unreadable or malformed candidate package manifest; continue probing fallback paths
    }
  }
  const procVersions = /** @type {Record<string, string | undefined> | undefined} */ (
    proc && proc.versions
  );
  const chromeVersion = String(
    options.chromeVersion || (procVersions && procVersions.chrome) || "138.0.0.0"
  );
  const uaPlatform =
    process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : "X11; Linux x86_64";
  /** @type {NtqqVersionMetadata} */
  const meta = {
    qqVersion,
    buildVersion,
    chromeVersion,
    userAgent: `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36 QQ/${qqVersion}`,
  };
  if (!options.packagePaths && !options.chromeVersion) {
    _cachedVersionMeta = meta;
  }
  return meta;
}

/**
 * Returns the synthesized desktop QQ NT User-Agent header value.
 *
 * @param {NtqqVersionOptions} [options={}]
 * @returns {string}
 */
function buildNtqqUserAgent(options = {}) {
  return getNtqqVersionMetadata(options).userAgent;
}

module.exports = {
  getNtqqVersionMetadata,
  buildNtqqUserAgent,
};
