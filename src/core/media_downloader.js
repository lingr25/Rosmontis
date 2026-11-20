// @ts-check
"use strict";

/**
 * Streaming Media Downloader & Atomic Temp-File Manager (`src/core/media_downloader.js`)
 *
 * Handles quota-enforced HTTP/HTTPS media downloads (buffered and streamed-to-disk),
 * atomic `.part` file staging/promotion, and bounded temp-directory pruning.
 * Lazily binds SSRF IP/DNS guards from `./media_security` so either module may be
 * required first without CommonJS circular-require issues.
 */

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const path = require("path");
const { pickPrefixedEnv, resolveTempDirFromEnv } = require("./env");
const { inspectImageDimensions } = require("./image_probe");
const { buildNtqqUserAgent } = require("./ntqq_meta");

const DEFAULT_MAX_MEDIA_BYTES = 256 * 1024 * 1024;
const HEADER_PEEK_BYTES = 65536;

/**
 * @typedef {object} MediaDownloadOptions
 * @property {number} [timeoutMs]
 * @property {number} [redirectsLeft]
 * @property {number | string} [maxMediaBytes]
 * @property {boolean} [allowPrivateUrls]
 * @property {boolean} [allowPrivateMediaUrls]
 * @property {any} [agent]
 * @property {Function} [lookup]
 * @property {Function} [dnsLookup]
 * @property {string} [tempDir]
 * @property {string} [preferredExt]
 * @property {string} [preferredName]
 * @property {{ debug?: (scope: string, err?: any) => any }} [logger]
 */

/**
 * @typedef {object} DownloadedMediaResult
 * @property {string} localPath
 * @property {string} fileName
 * @property {number} fileSize
 * @property {string} md5HexStr
 * @property {number} width
 * @property {number} height
 * @property {boolean} isGif
 * @property {import("./image_probe").ImageDimensions} dim
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
 * Lazily retrieves SSRF IP/DNS guards from `./media_security` to avoid a
 * load-order circular require regardless of which module is imported first.
 */
function _getSsrfGuards() {
  return require("./media_security");
}

/**
 * Resolves the effective media byte-size quota from options or environment.
 *
 * @param {Record<string, any>} [options={}]
 * @returns {number}
 */
function resolveMaxMediaBytes(options = {}) {
  const candidate =
    options &&
    options.maxMediaBytes !== undefined &&
    options.maxMediaBytes !== null &&
    options.maxMediaBytes !== ""
      ? options.maxMediaBytes
      : pickPrefixedEnv("MAX_MEDIA_BYTES");
  const num = Number(candidate);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : DEFAULT_MAX_MEDIA_BYTES;
}

/**
 * Synchronously prunes oldest non-`.part` files in `tempDir` above `maxFiles`.
 *
 * @param {string} tempDir
 * @param {number} [maxFiles=128]
 * @returns {number}
 */
function pruneTempDir(tempDir, maxFiles = 128) {
  try {
    if (!tempDir || !fs.existsSync(tempDir)) return 0;
    /** @type {Array<{ fullPath: string, mtimeMs: number }>} */
    const entries = [];
    for (const name of fs.readdirSync(tempDir)) {
      if (name.endsWith(".part")) continue;
      const fullPath = path.join(tempDir, name);
      try {
        const st = fs.statSync(fullPath);
        if (st.isFile()) {
          entries.push({ fullPath, mtimeMs: Number(st.mtimeMs || 0) });
        }
      } catch (_statErr) {
        // Ignore concurrent deletion or transient permission races while scanning tempDir
      }
    }
    if (entries.length <= maxFiles) return 0;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toRemove = entries.slice(0, entries.length - maxFiles);
    let removed = 0;
    for (const item of toRemove) {
      try {
        fs.unlinkSync(item.fullPath);
        removed++;
      } catch (_unlinkErr) {
        // Ignore files already unlinked or temporarily locked by another handle
      }
    }
    return removed;
  } catch (_dirErr) {
    // Temp directory unavailable or inaccessible; pruning is best-effort
    return 0;
  }
}

/**
 * @typedef {{ queuedMaxFiles: number | null, promise: Promise<number> | null }} PruneState
 */

/** @type {Map<string, PruneState>} */
const _pruneTempDirStates = new Map();

/**
 * @param {string} tempDir
 * @param {number} maxFiles
 * @returns {Promise<number>}
 */
async function _runPruneTempDirOnce(tempDir, maxFiles) {
  try {
    if (!tempDir) return 0;
    /** @type {string[]} */
    let names;
    try {
      names = await fs.promises.readdir(tempDir);
    } catch (_readdirErr) {
      // Directory does not exist or is unreadable; nothing to prune
      return 0;
    }
    const candidateNames = names.filter((name) => !name.endsWith(".part"));
    if (candidateNames.length <= maxFiles) return 0;
    const stats = await Promise.all(
      candidateNames.map(async (name) => {
        const fullPath = path.join(tempDir, name);
        try {
          const st = await fs.promises.stat(fullPath);
          if (st.isFile()) {
            return { fullPath, mtimeMs: Number(st.mtimeMs || 0) };
          }
        } catch (_statErr) {
          // Ignore concurrent removal while stating candidate temp files
        }
        return null;
      })
    );
    const entries = /** @type {Array<{ fullPath: string, mtimeMs: number }>} */ (
      stats.filter(Boolean)
    );
    if (entries.length <= maxFiles) return 0;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toRemove = entries.slice(0, entries.length - maxFiles);
    let removed = 0;
    await Promise.all(
      toRemove.map(async (item) => {
        try {
          await fs.promises.unlink(item.fullPath);
          removed++;
        } catch (_unlinkErr) {
          // Ignore files already deleted or transiently locked
        }
      })
    );
    return removed;
  } catch (_err) {
    // Best-effort async pruning must never fail the caller's media operation
    return 0;
  }
}

/**
 * Coalesced async temp-directory pruner that serializes concurrent pruning passes
 * on the same directory path.
 *
 * @param {string} tempDir
 * @param {number} [maxFiles=128]
 * @returns {Promise<number>}
 */
function pruneTempDirAsync(tempDir, maxFiles = 128) {
  if (!tempDir) return Promise.resolve(0);
  const lockKey =
    process.platform === "win32" ? path.resolve(tempDir).toLowerCase() : path.resolve(tempDir);
  let state = _pruneTempDirStates.get(lockKey);
  if (state && state.promise) {
    state.queuedMaxFiles =
      state.queuedMaxFiles === null ? maxFiles : Math.min(state.queuedMaxFiles, maxFiles);
    return state.promise;
  }
  /** @type {PruneState} */
  const nextState = { queuedMaxFiles: null, promise: null };
  nextState.promise = (async () => {
    let totalRemoved = 0;
    let currentMax = maxFiles;
    try {
      while (true) {
        totalRemoved += await _runPruneTempDirOnce(tempDir, currentMax);
        if (nextState.queuedMaxFiles === null) break;
        currentMax = nextState.queuedMaxFiles;
        nextState.queuedMaxFiles = null;
      }
    } finally {
      _pruneTempDirStates.delete(lockKey);
    }
    return totalRemoved;
  })();
  _pruneTempDirStates.set(lockKey, nextState);
  return nextState.promise;
}

/**
 * @param {number | MediaDownloadOptions} [timeoutOrOptions=20000]
 * @param {number | MediaDownloadOptions} [redirectsLeftArg=4]
 * @param {MediaDownloadOptions} [extraOptions={}]
 */
function _normalizeDownloadArgs(timeoutOrOptions = 20000, redirectsLeftArg = 4, extraOptions = {}) {
  /** @type {MediaDownloadOptions} */
  let options;
  let timeoutMs;
  let redirectsLeft;
  if (timeoutOrOptions && typeof timeoutOrOptions === "object") {
    options = timeoutOrOptions;
    timeoutMs = Number(options.timeoutMs) || 20000;
    redirectsLeft = options.redirectsLeft !== undefined ? Number(options.redirectsLeft) : 4;
  } else {
    options =
      extraOptions && typeof extraOptions === "object"
        ? extraOptions
        : redirectsLeftArg && typeof redirectsLeftArg === "object"
        ? redirectsLeftArg
        : {};
    timeoutMs = Number(timeoutOrOptions) || Number(options.timeoutMs) || 20000;
    redirectsLeft = typeof redirectsLeftArg === "number" ? redirectsLeftArg : 4;
  }
  const maxMediaBytes = resolveMaxMediaBytes(options);
  const { resolveAllowPrivateUrls } = _getSsrfGuards();
  const allowPrivateUrls = resolveAllowPrivateUrls(options);
  return { options, timeoutMs, redirectsLeft, maxMediaBytes, allowPrivateUrls };
}

/**
 * Opens an SSRF-checked HTTP/HTTPS media stream with redirect following and
 * upfront `Content-Length` quota validation.
 *
 * @param {string} urlStr
 * @param {number} timeoutMs
 * @param {number} redirectsLeft
 * @param {MediaDownloadOptions} options
 * @param {number} maxMediaBytes
 * @param {boolean} allowPrivateUrls
 * @returns {Promise<{ req: http.ClientRequest, res: http.IncomingMessage }>}
 */
function _openMediaHttpStream(urlStr, timeoutMs, redirectsLeft, options, maxMediaBytes, allowPrivateUrls) {
  const { isPrivateOrReservedIp, createSsrfSafeLookup } = _getSsrfGuards();
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @param {{ req: http.ClientRequest, res: http.IncomingMessage }} val */
    const settleResolve = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    /** @param {any} err */
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    /** @type {URL} */
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return settleReject(e);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return settleReject(
        _createCodedError(`Blocked unsupported media URL protocol: ${parsed.protocol}`, "ERR_SSRF_BLOCKED")
      );
    }

    const hostNoBrackets = String(parsed.hostname || "").replace(/^\[|\]$/g, "");
    let hostDecoded = hostNoBrackets;
    try {
      hostDecoded = decodeURIComponent(hostNoBrackets);
    } catch (_decodeErr) {
      // Malformed percent-encoding in hostname; retain raw hostNoBrackets for IP validation
    }
    const hostNoZone = hostDecoded.replace(/%.*$/, "");
    if (!allowPrivateUrls && net.isIP(hostNoZone) !== 0 && isPrivateOrReservedIp(hostDecoded)) {
      return settleReject(
        _createCodedError(`Blocked private or reserved media URL IP: ${hostNoBrackets}`, "ERR_SSRF_BLOCKED")
      );
    }

    /** @type {Record<string, any>} */
    const reqOpts = {
      headers: {
        "User-Agent": buildNtqqUserAgent(),
      },
      timeout: timeoutMs,
      agent: options.agent !== undefined ? options.agent : false,
    };
    if (!allowPrivateUrls || typeof options.lookup === "function" || typeof options.dnsLookup === "function") {
      reqOpts.lookup = createSsrfSafeLookup(options, allowPrivateUrls);
    }

    /** @param {http.IncomingMessage} res */
    const onResponse = (res) => {
      if (
        res.statusCode &&
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        res.resume();
        if (redirectsLeft <= 0) {
          return settleReject(new Error(`Too many redirects fetching ${urlStr}`));
        }
        let nextUrl;
        try {
          nextUrl = new URL(res.headers.location, urlStr).toString();
        } catch (e) {
          return settleReject(e);
        }
        return _openMediaHttpStream(
          nextUrl,
          timeoutMs,
          redirectsLeft - 1,
          options,
          maxMediaBytes,
          allowPrivateUrls
        ).then(settleResolve, settleReject);
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return settleReject(new Error(`HTTP ${res.statusCode} fetching ${urlStr}`));
      }

      const contentLength = Number(res.headers["content-length"]);
      if (Number.isFinite(contentLength) && contentLength > maxMediaBytes) {
        const sizeErr = _createCodedError(
          `Media Content-Length (${contentLength} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`,
          "ERR_MEDIA_TOO_LARGE"
        );
        res.destroy();
        req.destroy();
        return settleReject(sizeErr);
      }

      settleResolve({ req, res });
    };

    const req =
      parsed.protocol === "https:"
        ? https.get(urlStr, reqOpts, onResponse)
        : http.get(urlStr, reqOpts, onResponse);

    req.on("timeout", () => {
      req.destroy(new Error(`Timeout fetching ${urlStr}`));
    });
    req.on("error", settleReject);
  });
}

/**
 * Downloads a remote HTTP/HTTPS resource into an in-memory `Buffer` with SSRF
 * checks and streaming byte-limit enforcement.
 *
 * @param {string} urlStr
 * @param {number | MediaDownloadOptions} [timeoutOrOptions=20000]
 * @param {number | MediaDownloadOptions} [redirectsLeftArg=4]
 * @param {MediaDownloadOptions} [extraOptions={}]
 * @returns {Promise<Buffer>}
 */
async function downloadBufferFromUrl(urlStr, timeoutOrOptions = 20000, redirectsLeftArg = 4, extraOptions = {}) {
  const { options, timeoutMs, redirectsLeft, maxMediaBytes, allowPrivateUrls } = _normalizeDownloadArgs(
    timeoutOrOptions,
    redirectsLeftArg,
    extraOptions
  );
  const { req, res } = await _openMediaHttpStream(
    urlStr,
    timeoutMs,
    redirectsLeft,
    options,
    maxMediaBytes,
    allowPrivateUrls
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @param {any} err */
    const doneReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;

    req.on("error", doneReject);
    res.on("error", doneReject);
    res.on("data", (chunk) => {
      if (settled) return;
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufChunk.length;
      if (totalBytes > maxMediaBytes) {
        chunks.length = 0;
        const sizeErr = _createCodedError(
          `Media stream (${totalBytes} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`,
          "ERR_MEDIA_TOO_LARGE"
        );
        res.destroy();
        req.destroy();
        doneReject(sizeErr);
        return;
      }
      chunks.push(bufChunk);
    });
    res.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });
  });
}

/**
 * Promotes a staged `.part` file atomically to `localPath`, tolerating Windows
 * contention and concurrent identical-MD5 writes.
 *
 * @param {string} tmpPart
 * @param {string} localPath
 * @param {boolean} [hasExplicitPreferredName=false]
 * @param {number | undefined} [expectedSize=undefined]
 * @returns {Promise<void>}
 */
async function _finalizePartFile(tmpPart, localPath, hasExplicitPreferredName = false, expectedSize = undefined) {
  /** @param {fs.Stats} st */
  const matchesSize = (st) =>
    st.isFile() && (expectedSize !== undefined ? st.size === expectedSize : st.size > 0);
  const unlinkTmpBestEffort = () =>
    fs.promises.unlink(tmpPart).catch((_unlinkErr) => {
      // Best-effort cleanup of temp .part file (may already be renamed or removed)
    });

  if (!hasExplicitPreferredName) {
    try {
      const existing = await fs.promises.stat(localPath);
      if (matchesSize(existing)) {
        await unlinkTmpBestEffort();
        return;
      }
    } catch (_statErr) {
      // Destination does not exist yet; proceed to atomic rename
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.promises.rename(tmpPart, localPath);
      return;
    } catch (/** @type {any} */ err) {
      const code = err && err.code ? String(err.code) : "";
      if (code === "EEXIST" || code === "EPERM" || code === "EACCES" || code === "EBUSY") {
        if (!hasExplicitPreferredName) {
          try {
            const afterStat = await fs.promises.stat(localPath);
            if (matchesSize(afterStat)) {
              await unlinkTmpBestEffort();
              return;
            }
          } catch (_statErr) {
            // Concurrent writer has not finished committing destination yet
          }
        }
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
          continue;
        }
        try {
          const afterStat = await fs.promises.stat(localPath);
          if (matchesSize(afterStat)) {
            await unlinkTmpBestEffort();
            return;
          }
        } catch (_statErr) {
          // Final stat probe found no usable target; propagate original rename error
        }
      }
      await unlinkTmpBestEffort();
      throw err;
    }
  }
}

/**
 * Streams a remote HTTP/HTTPS media URL directly into `tempDir` via a `.part`
 * file while incrementally hashing MD5 and inspecting image dimensions.
 *
 * @param {string} urlStr
 * @param {string} [tempDir]
 * @param {MediaDownloadOptions} [options={}]
 * @returns {Promise<DownloadedMediaResult>}
 */
async function downloadMediaStreamToTempDir(urlStr, tempDir, options = {}) {
  const targetTempDir = resolveTempDirFromEnv(tempDir || options?.tempDir);
  await fs.promises.mkdir(targetTempDir, { recursive: true, mode: 0o700 });

  const { timeoutMs, redirectsLeft, maxMediaBytes, allowPrivateUrls } = _normalizeDownloadArgs(options);
  const { req, res } = await _openMediaHttpStream(
    urlStr,
    timeoutMs,
    redirectsLeft,
    options,
    maxMediaBytes,
    allowPrivateUrls
  );

  const tmpPart = path.join(
    targetTempDir,
    `.dl.${process.pid}.${crypto.randomBytes(6).toString("hex")}.part`
  );

  /** @type {{ fileSize: number, md5HexStr: string, dim: import("./image_probe").ImageDimensions }} */
  const { fileSize, md5HexStr, dim } = await new Promise((resolve, reject) => {
    let settled = false;
    const hash = crypto.createHash("md5");
    /** @type {Buffer[]} */
    const headerChunks = [];
    let headerCollected = 0;
    let totalBytes = 0;

    const outStream = fs.createWriteStream(tmpPart, { mode: 0o600 });

    /** @param {any} err */
    const abortAndCleanup = (err) => {
      if (settled) return;
      settled = true;
      try {
        res.destroy();
      } catch (_destroyErr) {
        // Response stream already torn down
      }
      try {
        req.destroy();
      } catch (_destroyErr) {
        // Request already torn down
      }
      const finalizeReject = () => {
        fs.promises
          .unlink(tmpPart)
          .catch((unlinkErr) => {
            options.logger?.debug?.("media_downloader:unlinkAbortedPart", unlinkErr);
          })
          .finally(() => {
            reject(err);
          });
      };
      if (outStream.closed) {
        finalizeReject();
      } else {
        let cleaned = false;
        const onClosed = () => {
          if (cleaned) return;
          cleaned = true;
          clearTimeout(fallbackTimer);
          finalizeReject();
        };
        const fallbackTimer = setTimeout(onClosed, 250);
        if (typeof fallbackTimer.unref === "function") fallbackTimer.unref();
        outStream.once("close", onClosed);
        try {
          outStream.destroy();
        } catch (_destroyErr) {
          // Write stream already closed/destroyed; finalize immediately
          onClosed();
        }
      }
    };

    req.on("error", abortAndCleanup);
    res.on("error", abortAndCleanup);
    outStream.on("error", abortAndCleanup);
    res.on("aborted", () => {
      abortAndCleanup(new Error(`Media HTTP stream aborted prematurely for ${urlStr}`));
    });
    res.on("close", () => {
      if (!settled && res.complete === false) {
        abortAndCleanup(new Error(`Media HTTP stream closed before completion for ${urlStr}`));
      }
    });

    res.on("data", (chunk) => {
      if (settled) return;
      const bufChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufChunk.length;
      if (totalBytes > maxMediaBytes) {
        const sizeErr = _createCodedError(
          `Media stream (${totalBytes} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`,
          "ERR_MEDIA_TOO_LARGE"
        );
        abortAndCleanup(sizeErr);
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
      if (!outStream.write(bufChunk)) {
        res.pause();
        outStream.once("drain", () => {
          if (!settled) res.resume();
        });
      }
    });

    res.on("end", () => {
      if (settled) return;
      outStream.end(() => {
        if (settled) return;
        const finishResolve = () => {
          if (settled) return;
          settled = true;
          const digestHex = hash.digest("hex");
          const headerBuf = Buffer.concat(headerChunks, headerCollected);
          const probedDim = inspectImageDimensions(headerBuf);
          resolve({ fileSize: totalBytes, md5HexStr: digestHex, dim: probedDim });
        };
        if (outStream.closed) {
          finishResolve();
        } else {
          outStream.once("close", finishResolve);
        }
      });
    });
  });

  const ext = options.preferredExt || dim.ext || ".bin";
  const fileName = options.preferredName || `${md5HexStr}${ext}`;
  const safeFileName = path.basename(fileName);
  const localPath = path.join(targetTempDir, safeFileName);
  await _finalizePartFile(tmpPart, localPath, Boolean(options.preferredName), fileSize);

  return {
    localPath,
    fileName: safeFileName,
    fileSize,
    md5HexStr,
    width: dim.width,
    height: dim.height,
    isGif: dim.isGif,
    dim,
  };
}

/**
 * Atomically writes a media `Buffer` to `localPath` via a temporary `.part` file.
 *
 * @param {string} localPath
 * @param {Buffer} buf
 * @param {boolean} [hasExplicitPreferredName=false]
 * @returns {Promise<void>}
 */
async function writeTempMediaAtomically(localPath, buf, hasExplicitPreferredName = false) {
  if (!hasExplicitPreferredName) {
    try {
      const existing = await fs.promises.stat(localPath);
      if (existing.isFile() && existing.size === buf.length && existing.size > 0) {
        return;
      }
    } catch (_statErr) {
      // File does not exist yet; proceed to atomic write
    }
  }

  const tmpPart = `${localPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.part`;
  await fs.promises.writeFile(tmpPart, buf, { mode: 0o600 });
  await _finalizePartFile(tmpPart, localPath, hasExplicitPreferredName, buf.length);
}

module.exports = {
  DEFAULT_MAX_MEDIA_BYTES,
  HEADER_PEEK_BYTES,
  resolveMaxMediaBytes,
  pruneTempDir,
  pruneTempDirAsync,
  writeTempMediaAtomically,
  downloadBufferFromUrl,
  downloadMediaStreamToTempDir,
};
