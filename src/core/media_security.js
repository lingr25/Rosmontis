// @ts-check
"use strict";

/**
 * Media Security Guards & Source Resolver (`src/core/media_security.js`)
 *
 * Enforces IPv4/IPv6 SSRF blocking (literal IP + DNS rebinding lookup wrapper)
 * and strict LFI directory whitelist/blacklist boundaries for `resolveMediaSource`.
 * Re-exports decomposed image probing, NTQQ metadata, and streaming download
 * utilities for full backward compatibility.
 */

const crypto = require("crypto");
const dns = require("dns");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { fileURLToPath } = require("url");
const {
  pickEnv,
  collectPrefixedEnvValues,
  isPrefixedEnvFlagOne,
  getHomeDir,
  getXdgConfigHome,
  resolveTempDirFromEnv,
  resolveConfigDirsFromEnv,
} = require("./env");
const { inspectImageDimensions } = require("./image_probe");
const { getNtqqVersionMetadata, buildNtqqUserAgent } = require("./ntqq_meta");
const {
  DEFAULT_MAX_MEDIA_BYTES,
  HEADER_PEEK_BYTES,
  resolveMaxMediaBytes,
  pruneTempDir,
  pruneTempDirAsync,
  writeTempMediaAtomically,
  downloadBufferFromUrl,
  downloadMediaStreamToTempDir,
} = require("./media_downloader");

/**
 * @typedef {object} ResolveMediaOptions
 * @property {string} [tempDir]
 * @property {number} [maxTempFiles]
 * @property {number | string} [maxMediaBytes]
 * @property {string} [preferredExt]
 * @property {string} [preferredName]
 * @property {number} [timeoutMs]
 * @property {number} [redirectsLeft]
 * @property {boolean} [allowPrivateUrls]
 * @property {boolean} [allowPrivateMediaUrls]
 * @property {boolean} [allowArbitraryLocalFiles]
 * @property {boolean} [allowSensitiveConfigFiles]
 * @property {string | string[]} [allowedFileDirs]
 * @property {any} [agent]
 * @property {Function} [lookup]
 * @property {Function} [dnsLookup]
 * @property {string} [kind]
 * @property {{ debug?: (scope: string, err?: any) => any }} [logger]
 */

/**
 * @typedef {object} ResolvedMediaSource
 * @property {string} localPath
 * @property {string} fileName
 * @property {number} fileSize
 * @property {string} md5HexStr
 * @property {number} width
 * @property {number} height
 * @property {boolean} isGif
 * @property {boolean} isTempFile
 */

/**
 * @param {string} message
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function _createCodedError(message, code) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} [c=-1]
 * @returns {boolean}
 */
function _isPrivateOrReservedIpv4Octets(a, b, c = -1) {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && (b & 0xc0) === 64) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && (b & 0xf0) === 16) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 & 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 (6to4 relay anycast)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved/broadcast
  return false;
}

/**
 * @param {string} ipv6Str
 * @returns {number[] | null}
 */
function _parseIpv6Groups(ipv6Str) {
  let addr = ipv6Str.toLowerCase();
  const lastColon = addr.lastIndexOf(":");
  if (lastColon !== -1 && addr.indexOf(".", lastColon) !== -1) {
    const ipv4Part = addr.slice(lastColon + 1);
    if (net.isIP(ipv4Part) !== 4) return null;
    const octets = ipv4Part.split(".").map((x) => Number(x));
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const dblIdx = addr.indexOf("::");
  /** @type {string[]} */
  let groups;
  if (dblIdx !== -1) {
    if (addr.indexOf("::", dblIdx + 2) !== -1) return null;
    const leftStr = addr.slice(0, dblIdx);
    const rightStr = addr.slice(dblIdx + 2);
    const left = leftStr ? leftStr.split(":") : [];
    const right = rightStr ? rightStr.split(":") : [];
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array(fill).fill("0"), ...right];
  } else {
    groups = addr.split(":");
    if (groups.length !== 8) return null;
  }
  /** @type {number[]} */
  const nums = new Array(8);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i], 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
    nums[i] = v;
  }
  return nums;
}

/**
 * Returns `true` when `ip` falls inside a private, loopback, link-local,
 * carrier-grade NAT, documentation, multicast, or otherwise reserved IPv4/IPv6 range.
 *
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateOrReservedIp(ip) {
  if (typeof ip !== "string") return false;
  const cleaned = ip.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "").replace(/^\[|\]$/g, "");
  if (!cleaned) return false;
  const family = net.isIP(cleaned);
  if (family === 4) {
    const parts = cleaned.split(".").map((x) => Number(x));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    return _isPrivateOrReservedIpv4Octets(parts[0], parts[1], parts[2]);
  }
  if (family === 6) {
    const g = _parseIpv6Groups(cleaned);
    if (!g) return true;
    const first5Zero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
    if (first5Zero && g[5] === 0) {
      // :: (unspecified), ::1 (loopback), and deprecated IPv4-compatible ::x.x.x.x (::/96)
      return true;
    }
    if (first5Zero && g[5] === 0xffff) {
      // IPv4-mapped ::ffff:0:0/96 (dotted-quad & hex forms) — delegate embedded IPv4
      return _isPrivateOrReservedIpv4Octets((g[6] >> 8) & 0xff, g[6] & 0xff, (g[7] >> 8) & 0xff);
    }
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) {
      // SIIT IPv4-translated ::ffff:0:0:0/96
      return true;
    }
    if (
      g[0] === 0x0064 &&
      g[1] === 0xff9b &&
      ((g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) || g[2] === 0x0001)
    ) {
      // NAT64 well-known 64:ff9b::/96 & local-use 64:ff9b:1::/48
      return true;
    }
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) {
      // Discard-only 100::/64 (RFC 6666)
      return true;
    }
    if (g[0] === 0x2001) {
      if (g[1] === 0x0000) return true; // Teredo 2001:0000::/32
      if (g[1] === 0x0002 && g[2] === 0x0000) return true; // Benchmarking 2001:2::/48
      if (g[1] === 0x0db8) return true; // Documentation 2001:db8::/32
      if ((g[1] & 0xfff0) === 0x0010 || (g[1] & 0xfff0) === 0x0020) return true; // ORCHID / ORCHIDv2
    }
    if (g[0] === 0x2002) {
      // 6to4 relay 2002::/16
      return true;
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7 (fc00::..fdff::)
    if ((g[0] & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10 (fe80::..febf::)
    if ((g[0] & 0xffc0) === 0xfec0) return true; // Deprecated site-local fec0::/10
    if ((g[0] & 0xff00) === 0xff00) return true; // Multicast ff00::/8
    return false;
  }
  return false;
}

/**
 * Resolves whether private/reserved remote media URLs are explicitly allowed.
 *
 * @param {Record<string, any>} [options={}]
 * @returns {boolean}
 */
function resolveAllowPrivateUrls(options = {}) {
  if (options && (options.allowPrivateUrls === true || options.allowPrivateMediaUrls === true)) {
    return true;
  }
  if (options && (options.allowPrivateUrls === false || options.allowPrivateMediaUrls === false)) {
    return false;
  }
  const envVal = pickEnv(
    "ROSMONTIS_ALLOW_PRIVATE_MEDIA_URLS",
    "ROSMONTIS_ALLOW_PRIVATE_URLS",
    "ONEBOT_ALLOW_PRIVATE_MEDIA_URLS",
    "XIAO_BRIDGE_ALLOW_PRIVATE_MEDIA_URLS"
  ).toLowerCase();
  return envVal === "1" || envVal === "true";
}

/**
 * Wraps `dns.lookup` (or a custom lookup function) to reject any hostname or
 * resolved A/AAAA record pointing to a private or reserved IP address.
 *
 * @param {Record<string, any>} [options={}]
 * @param {boolean | undefined} [allowPrivateUrls=undefined]
 * @returns {(hostname: string, lookupOpts: any, cb?: any) => void}
 */
function createSsrfSafeLookup(options = {}, allowPrivateUrls = undefined) {
  const allowPrivate =
    allowPrivateUrls !== undefined ? Boolean(allowPrivateUrls) : resolveAllowPrivateUrls(options);
  /** @type {Function} */
  const rawLookup =
    typeof options.lookup === "function"
      ? options.lookup
      : typeof options.dnsLookup === "function"
      ? options.dnsLookup
      : dns.lookup;

  return (hostname, lookupOpts, cb) => {
    let opts = lookupOpts;
    let callback = cb;
    if (typeof lookupOpts === "function") {
      callback = lookupOpts;
      opts = {};
    }
    const wantAll = Boolean(opts && typeof opts === "object" && opts.all === true);
    const cleanHost = String(hostname || "")
      .trim()
      .replace(/^\[|\]$/g, "")
      .replace(/%.*$/, "")
      .replace(/^\[|\]$/g, "");
    if (!allowPrivate && net.isIP(cleanHost) !== 0 && isPrivateOrReservedIp(cleanHost)) {
      return callback(
        _createCodedError(`Blocked private or reserved IP address: ${cleanHost}`, "ERR_SSRF_BLOCKED")
      );
    }

    rawLookup.call(
      dns,
      hostname,
      opts,
      (/** @type {any} */ err, /** @type {any} */ address, /** @type {number} */ family) => {
        if (err) return callback(err);
        if (!allowPrivate) {
          if (Array.isArray(address)) {
            if (address.length === 0) {
              return callback(
                _createCodedError(`Blocked empty DNS resolution for ${hostname}`, "ERR_SSRF_BLOCKED")
              );
            }
            for (const entry of address) {
              const addrStr =
                entry && typeof entry === "object" ? String(entry.address || "") : String(entry || "");
              const bareAddr = addrStr.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
              if (!bareAddr || net.isIP(bareAddr) === 0 || isPrivateOrReservedIp(addrStr)) {
                return callback(
                  _createCodedError(
                    `Blocked DNS resolution to private or reserved IP (${addrStr}) for ${hostname}`,
                    "ERR_SSRF_BLOCKED"
                  )
                );
              }
            }
            return callback(null, address);
          }
          const addrStr = String(address || "");
          const bareAddr = addrStr.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
          if (!bareAddr || net.isIP(bareAddr) === 0 || isPrivateOrReservedIp(addrStr)) {
            return callback(
              _createCodedError(
                `Blocked DNS resolution to private or reserved IP (${addrStr}) for ${hostname}`,
                "ERR_SSRF_BLOCKED"
              )
            );
          }
        }
        if (wantAll && !Array.isArray(address) && typeof address === "string") {
          return callback(null, [{ address, family: family || net.isIP(address) || 4 }]);
        }
        if (!wantAll && Array.isArray(address)) {
          const first = address[0];
          if (!first) return callback(new Error(`No DNS records resolved for ${hostname}`));
          const addrStr = typeof first === "object" ? first.address : String(first);
          const fam = (typeof first === "object" && first.family) || net.isIP(addrStr) || 4;
          return callback(null, addrStr, fam);
        }
        return Array.isArray(address)
          ? callback(null, address)
          : callback(null, address, family || net.isIP(String(address || "")) || 4);
      }
    );
  };
}

/**
 * Streams a local file to compute size, MD5, and image header dimensions
 * without loading large files completely into memory.
 *
 * @param {string} filePath
 * @param {number} maxMediaBytes
 * @returns {Promise<{ fileSize: number, md5HexStr: string, dim: import("./image_probe").ImageDimensions }>}
 */
async function _inspectLocalFileStream(filePath, maxMediaBytes) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    /** @type {Buffer[]} */
    const headerChunks = [];
    let headerCollected = 0;
    let totalBytes = 0;
    let settled = false;

    const stream = fs.createReadStream(filePath);
    /** @param {any} err */
    const fail = (err) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(err);
    };

    stream.on("error", fail);
    stream.on("data", (chunk) => {
      if (settled) return;
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufChunk.length;
      if (totalBytes > maxMediaBytes) {
        fail(
          _createCodedError(
            `Local media file (${totalBytes} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`,
            "ERR_MEDIA_TOO_LARGE"
          )
        );
        return;
      }
      hash.update(bufChunk);
      if (headerCollected < HEADER_PEEK_BYTES) {
        const slice =
          headerCollected + bufChunk.length <= HEADER_PEEK_BYTES
            ? bufChunk
            : bufChunk.subarray(0, HEADER_PEEK_BYTES - headerCollected);
        headerChunks.push(Buffer.from(slice));
        headerCollected += slice.length;
      }
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      const md5HexStr = hash.digest("hex");
      const headerBuf = Buffer.concat(headerChunks, headerCollected);
      const dim = inspectImageDimensions(headerBuf);
      resolve({ fileSize: totalBytes, md5HexStr, dim });
    });
  });
}

/**
 * @param {string} targetPath
 * @param {string} rootPath
 * @returns {boolean}
 */
function _isSubPathOrEqual(targetPath, rootPath) {
  if (!targetPath || !rootPath) return false;
  const normTarget =
    process.platform === "win32" ? path.resolve(targetPath).toLowerCase() : path.resolve(targetPath);
  const normRoot =
    process.platform === "win32" ? path.resolve(rootPath).toLowerCase() : path.resolve(rootPath);
  const rel = path.relative(normRoot, normTarget);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * @param {string[]} rawDirs
 * @param {boolean} [preferRealOnly=false]
 * @returns {Promise<string[]>}
 */
async function _expandDirCandidates(rawDirs, preferRealOnly = false) {
  const seen = new Set();
  /** @type {string[]} */
  const result = [];
  /** @param {string} p */
  const add = (p) => {
    if (!p) return;
    const key = process.platform === "win32" ? p.toLowerCase() : p;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(p);
    }
  };
  await Promise.all(
    rawDirs.map(async (rawDir) => {
      const trimmed = String(rawDir || "").trim();
      if (!trimmed) return;
      const resolved = path.resolve(trimmed);
      if (!preferRealOnly) {
        add(resolved);
      }
      try {
        const real = await fs.promises.realpath(resolved);
        add(real);
      } catch (_realpathErr) {
        // Directory may not exist on disk yet; keep normalized path when preferRealOnly is requested
        if (preferRealOnly) {
          add(resolved);
        }
      }
    })
  );
  return result;
}

/**
 * @returns {string[]}
 */
function _getConfiguredConfigDirs() {
  return resolveConfigDirsFromEnv();
}

/**
 * @returns {string[]}
 */
function _getBlacklistedLocalDirs() {
  const homeDir = getHomeDir();
  const sysHome = os.homedir();
  const configuredCfgDirs = _getConfiguredConfigDirs();
  return [
    ...configuredCfgDirs,
    "/app/data/config",
    "/etc",
    "/proc",
    "/sys",
    "/tmp/.vnc",
    path.join(os.tmpdir(), ".vnc"),
    homeDir ? path.join(homeDir, ".ssh") : "",
    homeDir ? path.join(homeDir, ".vnc") : "",
    homeDir ? path.join(homeDir, ".gnupg") : "",
    sysHome && sysHome !== homeDir ? path.join(sysHome, ".ssh") : "",
    sysHome && sysHome !== homeDir ? path.join(sysHome, ".vnc") : "",
    sysHome && sysHome !== homeDir ? path.join(sysHome, ".gnupg") : "",
  ].filter(Boolean);
}

const SENSITIVE_DIR_SEGMENTS = new Set([
  "nt_db",
  "login",
  "databases",
  "local storage",
  "session storage",
  "indexeddb",
  ".ssh",
  ".vnc",
  ".gnupg",
  ".aws",
  ".kube",
  ".docker",
]);

const SENSITIVE_FILENAMES = new Set([
  "cookies",
  "cookies-journal",
  "login data",
  "login data-journal",
  "local state",
  "web data",
  "passwd",
  "shadow",
  "gshadow",
  "master.passwd",
  "sudoers",
  ".rosmontis_auto_token",
  ".xiao_bridge_auto_token",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "authorized_keys",
  "known_hosts",
  ".env",
]);

const SENSITIVE_EXTENSIONS = new Set([
  ".db",
  ".db-wal",
  ".db-shm",
  ".db-journal",
  ".sqlite",
  ".sqlite-wal",
  ".sqlite-shm",
  ".sqlite3",
  ".ldb",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
]);

/**
 * @param {string} targetPath
 * @returns {boolean}
 */
function _isSensitiveCredentialOrDbPath(targetPath) {
  if (!targetPath) return false;
  const normalized = path.resolve(targetPath);
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if (SENSITIVE_DIR_SEGMENTS.has(parts[i].toLowerCase())) {
      return true;
    }
  }
  const base = (parts[parts.length - 1] || "").toLowerCase();
  if (!base) return false;
  if (SENSITIVE_FILENAMES.has(base) || base.startsWith(".env.")) return true;
  if (/^\.?(?:rosmontis|onebot|xiao_bridge).*\.json$/i.test(base)) return true;
  const ext = path.extname(base);
  if (ext && SENSITIVE_EXTENSIONS.has(ext)) return true;
  return false;
}

/**
 * @param {string | string[] | undefined} rawInput
 * @returns {string[]}
 */
function _splitAllowedDirsList(rawInput) {
  if (!rawInput) return [];
  const rawItems = Array.isArray(rawInput) ? rawInput : [rawInput];
  /** @type {string[]} */
  const chunks = [];
  for (const item of rawItems) {
    if (!item) continue;
    for (const piece of String(item).split(/[;,]+/)) {
      if (piece) chunks.push(piece);
    }
  }
  /** @type {string[]} */
  const dirs = [];
  for (const rawChunk of chunks) {
    const part = rawChunk.trim();
    if (!part) continue;
    let current = "";
    for (let i = 0; i < part.length; i++) {
      const ch = part[i];
      if (ch === ":") {
        const trimmedCurrent = current.trim();
        const isWinDrive =
          trimmedCurrent.length === 1 &&
          /[a-zA-Z]/.test(trimmedCurrent) &&
          (i + 1 === part.length ||
            part[i + 1] === "\\" ||
            (process.platform === "win32" && part[i + 1] === "/"));
        if (isWinDrive) {
          current = `${trimmedCurrent}:`;
          continue;
        }
        if (trimmedCurrent) dirs.push(trimmedCurrent);
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) dirs.push(current.trim());
  }
  return dirs;
}

/**
 * @param {string} tempDir
 * @param {ResolveMediaOptions} [options={}]
 * @returns {string[]}
 */
function _getWhitelistedLocalDirs(tempDir, options = {}) {
  const envAllowed = _splitAllowedDirsList(collectPrefixedEnvValues("ALLOWED_FILE_DIRS"));
  const optAllowed = _splitAllowedDirsList(options.allowedFileDirs);
  // Note: raw os.tmpdir() and root ~/.config/QQ are intentionally NOT blanket-whitelisted;
  // ~/.config/QQ only permits RichMedia cache subdirectories via _isAllowedQqMediaCachePath().
  return [tempDir, "/opt/xiao-data", ...envAllowed, ...optAllowed].filter(Boolean);
}

/**
 * @returns {string[]}
 */
function _getQqProfileRoots() {
  const homeDir = getHomeDir();
  const sysHome = os.homedir();
  const xdgConfig = getXdgConfigHome();
  const appData = pickEnv("APPDATA");
  const localAppData = pickEnv("LOCALAPPDATA");
  return [
    xdgConfig ? path.join(xdgConfig, "QQ") : "",
    homeDir ? path.join(homeDir, ".config/QQ") : "",
    sysHome && sysHome !== homeDir ? path.join(sysHome, ".config/QQ") : "",
    "/app/.config/QQ",
    homeDir ? path.join(homeDir, "Documents", "Tencent Files") : "",
    sysHome && sysHome !== homeDir ? path.join(sysHome, "Documents", "Tencent Files") : "",
    homeDir ? path.join(homeDir, "OneDrive", "Documents", "Tencent Files") : "",
    sysHome && sysHome !== homeDir ? path.join(sysHome, "OneDrive", "Documents", "Tencent Files") : "",
    appData ? path.join(appData, "Tencent", "QQ") : "",
    localAppData ? path.join(localAppData, "Tencent", "QQ") : "",
    homeDir
      ? path.join(
          homeDir,
          "Library",
          "Containers",
          "com.tencent.qq",
          "Data",
          "Library",
          "Application Support",
          "QQ"
        )
      : "",
  ].filter(Boolean);
}

const ALLOWED_QQ_MEDIA_SUBDIRS = new Set([
  "pic",
  "video",
  "file",
  "ptt",
  "emoji",
  "marketface",
  "thumb",
]);

/**
 * @param {string} realPath
 * @param {string[]} qqRoots
 * @returns {boolean}
 */
function _isAllowedQqMediaCachePath(realPath, qqRoots) {
  for (const root of qqRoots) {
    if (!_isSubPathOrEqual(realPath, root)) continue;
    const rel = path.relative(root, realPath);
    const segments = rel.split(/[\\/]+/).filter(Boolean);
    // Expected layout: [nt_qq_<hash> | <uin>/nt_qq, "nt_data", "Pic"|"Video"|"File"|"Ptt"|..., ...file]
    const ntDataIdx = segments.findIndex((seg) => seg.toLowerCase() === "nt_data");
    if (ntDataIdx >= 0 && ntDataIdx <= 3 && ntDataIdx + 2 < segments.length) {
      const mediaCategory = segments[ntDataIdx + 1].toLowerCase();
      if (ALLOWED_QQ_MEDIA_SUBDIRS.has(mediaCategory)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolves a OneBot media input (`base64://`, `data:...;base64,...`, `http(s)://`,
 * `file://`, or local filesystem path) into a validated local file descriptor
 * with SSRF, LFI, and byte-quota protections enforced.
 *
 * @param {string} sourceStr
 * @param {ResolveMediaOptions} [options={}]
 * @returns {Promise<ResolvedMediaSource>}
 */
async function resolveMediaSource(sourceStr, options = {}) {
  const raw = String(sourceStr || "").trim();
  if (!raw) {
    throw new Error("Empty media source");
  }
  const maxMediaBytes = resolveMaxMediaBytes(options);
  const tempDir = resolveTempDirFromEnv(options?.tempDir);
  await fs.promises.mkdir(tempDir, { recursive: true, mode: 0o700 });
  const maxTempFiles = Math.max(8, Number(options.maxTempFiles || 128));

  // 1. base64:// or data:...;base64,...
  if (raw.startsWith("base64://") || /^data:[^;]+;base64,/i.test(raw)) {
    const b64 = (
      raw.startsWith("base64://")
        ? raw.slice("base64://".length)
        : raw.replace(/^data:[^;]+;base64,/i, "")
    ).replace(/\s+/g, "");
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    const estimatedBytes = Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
    if (estimatedBytes > maxMediaBytes) {
      throw _createCodedError(
        `Base64 media payload (~${estimatedBytes} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`,
        "ERR_MEDIA_TOO_LARGE"
      );
    }
    const buf = Buffer.from(b64, "base64");
    if (buf.length > maxMediaBytes) {
      throw _createCodedError(
        `Decoded base64 media (${buf.length} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`,
        "ERR_MEDIA_TOO_LARGE"
      );
    }
    const md5HexStr = crypto.createHash("md5").update(buf).digest("hex");
    const dim = inspectImageDimensions(buf);
    const ext = options.preferredExt || dim.ext || ".bin";
    const fileName = options.preferredName || `${md5HexStr}${ext}`;
    const safeFileName = path.basename(fileName);
    const localPath = path.join(tempDir, safeFileName);
    await writeTempMediaAtomically(localPath, buf, Boolean(options.preferredName));
    await pruneTempDirAsync(tempDir, maxTempFiles);
    return {
      localPath,
      fileName: safeFileName,
      fileSize: buf.length,
      md5HexStr,
      width: dim.width,
      height: dim.height,
      isGif: dim.isGif,
      isTempFile: true,
    };
  }

  // 2. http:// or https:// (streamed directly to disk without buffering up to 256 MiB in RAM)
  if (/^https?:\/\//i.test(raw)) {
    const dl = await downloadMediaStreamToTempDir(raw, tempDir, {
      ...options,
      timeoutMs: options.timeoutMs || 25000,
      maxMediaBytes,
    });
    await pruneTempDirAsync(tempDir, maxTempFiles);
    return {
      localPath: dl.localPath,
      fileName: dl.fileName,
      fileSize: dl.fileSize,
      md5HexStr: dl.md5HexStr,
      width: dl.width,
      height: dl.height,
      isGif: dl.isGif,
      isTempFile: true,
    };
  }

  // Reject non-file URL schemes explicitly (e.g. ftp://, gopher://)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) && !/^file:\/\//i.test(raw)) {
    throw new Error(`Media source not found or unsupported: ${raw.slice(0, 120)}`);
  }

  // 3. file:// or local path
  let localPath = raw;
  if (/^file:\/\//i.test(raw)) {
    try {
      localPath = fileURLToPath(raw);
    } catch (_urlErr) {
      // Non-standard file:// URI (e.g. missing host or unescaped chars); fall back to URL pathname decoding
      try {
        const u = new URL(raw);
        localPath = decodeURIComponent(u.pathname);
        if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(localPath)) {
          localPath = localPath.slice(1);
        }
      } catch (_fallbackErr) {
        // Unparseable file:// URI; strip scheme prefix and let LFI/existence checks validate the path
        localPath = raw.replace(/^file:\/+/i, "/");
      }
    }
  }

  const allowArbitraryLocalFiles =
    options.allowArbitraryLocalFiles === true ||
    isPrefixedEnvFlagOne("ALLOW_ARBITRARY_LOCAL_FILES");

  const resolvedInput = path.resolve(localPath);
  const configuredCfgDirs =
    options.allowSensitiveConfigFiles === true
      ? []
      : await _expandDirCandidates(_getConfiguredConfigDirs());
  if (configuredCfgDirs.some((dir) => _isSubPathOrEqual(resolvedInput, dir))) {
    throw _createCodedError(
      `Blocked access to restricted local config path: ${localPath}`,
      "ERR_LFI_BLOCKED"
    );
  }

  /** @type {string[]} */
  let blacklistedDirs = [];
  if (!allowArbitraryLocalFiles) {
    blacklistedDirs = await _expandDirCandidates(_getBlacklistedLocalDirs());
    if (
      blacklistedDirs.some((dir) => _isSubPathOrEqual(resolvedInput, dir)) ||
      _isSensitiveCredentialOrDbPath(resolvedInput)
    ) {
      throw _createCodedError(
        `Blocked access to restricted local path: ${localPath}`,
        "ERR_LFI_BLOCKED"
      );
    }
  }

  let realPath;
  try {
    realPath = await fs.promises.realpath(localPath);
  } catch (_realpathErr) {
    // Broken symlink or missing file: still inspect symlink target so LFI blocks fire before not-found errors
    if (!allowArbitraryLocalFiles) {
      let symlinkTarget = "";
      try {
        const lst = await fs.promises.lstat(localPath);
        if (lst.isSymbolicLink()) {
          const linkRaw = await fs.promises.readlink(localPath);
          symlinkTarget = path.resolve(path.dirname(resolvedInput), linkRaw);
        }
      } catch (_lstatErr) {
        // Path does not exist as a symlink either; fall through to standard not-found error
      }
      if (symlinkTarget) {
        if (
          blacklistedDirs.some((dir) => _isSubPathOrEqual(symlinkTarget, dir)) ||
          _isSensitiveCredentialOrDbPath(symlinkTarget)
        ) {
          throw _createCodedError(
            `Blocked access to restricted local path: ${symlinkTarget}`,
            "ERR_LFI_BLOCKED"
          );
        }
        const [whitelistedDirs, qqRoots] = await Promise.all([
          _expandDirCandidates(_getWhitelistedLocalDirs(tempDir, options), true),
          _expandDirCandidates(_getQqProfileRoots(), true),
        ]);
        const inWhitelist = whitelistedDirs.some((dir) => _isSubPathOrEqual(symlinkTarget, dir));
        const inQqCache = _isAllowedQqMediaCachePath(symlinkTarget, qqRoots);
        if (!inWhitelist && !inQqCache) {
          throw _createCodedError(
            `Blocked local media symlink outside allowed directories: ${symlinkTarget}`,
            "ERR_LFI_BLOCKED"
          );
        }
      }
    }
    throw new Error(`Media source not found or unsupported: ${raw.slice(0, 120)}`);
  }

  if (configuredCfgDirs.some((dir) => _isSubPathOrEqual(realPath, dir))) {
    throw _createCodedError(
      `Blocked access to restricted local config path: ${realPath}`,
      "ERR_LFI_BLOCKED"
    );
  }

  if (!allowArbitraryLocalFiles) {
    if (
      blacklistedDirs.some((dir) => _isSubPathOrEqual(realPath, dir)) ||
      _isSensitiveCredentialOrDbPath(realPath)
    ) {
      throw _createCodedError(
        `Blocked access to restricted local path: ${realPath}`,
        "ERR_LFI_BLOCKED"
      );
    }
    const [whitelistedDirs, qqRoots] = await Promise.all([
      _expandDirCandidates(_getWhitelistedLocalDirs(tempDir, options), true),
      _expandDirCandidates(_getQqProfileRoots(), true),
    ]);
    const inExplicitWhitelist = whitelistedDirs.some((dir) => _isSubPathOrEqual(realPath, dir));
    const inQqMediaCache = _isAllowedQqMediaCachePath(realPath, qqRoots);
    if (!inExplicitWhitelist && !inQqMediaCache) {
      throw _createCodedError(
        `Blocked local media file outside allowed directories: ${realPath}`,
        "ERR_LFI_BLOCKED"
      );
    }
  }

  /** @type {fs.Stats} */
  let st;
  try {
    st = await fs.promises.stat(realPath);
  } catch (_statErr) {
    // Unreadable or concurrently removed local file; report standard media-not-found error
    throw new Error(`Media source not found or unsupported: ${raw.slice(0, 120)}`);
  }
  if (!st.isFile()) {
    throw new Error(`Media source not found or unsupported: ${raw.slice(0, 120)}`);
  }
  if (st.size > maxMediaBytes) {
    throw _createCodedError(
      `Local media file (${st.size} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`,
      "ERR_MEDIA_TOO_LARGE"
    );
  }

  const { fileSize, md5HexStr, dim } = await _inspectLocalFileStream(realPath, maxMediaBytes);
  const fileName = options.preferredName || path.basename(realPath) || `${md5HexStr}${dim.ext}`;
  return {
    localPath: realPath,
    fileName: path.basename(fileName),
    fileSize,
    md5HexStr,
    width: dim.width,
    height: dim.height,
    isGif: dim.isGif,
    isTempFile: false,
  };
}

module.exports = {
  DEFAULT_MAX_MEDIA_BYTES,
  inspectImageDimensions,
  getNtqqVersionMetadata,
  buildNtqqUserAgent,
  resolveMaxMediaBytes,
  resolveAllowPrivateUrls,
  isPrivateOrReservedIp,
  createSsrfSafeLookup,
  pruneTempDir,
  pruneTempDirAsync,
  writeTempMediaAtomically,
  downloadBufferFromUrl,
  downloadMediaStreamToTempDir,
  resolveMediaSource,
};
