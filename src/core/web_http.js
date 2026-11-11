"use strict";

const http = require("http");
const https = require("https");

const { buildNtqqUserAgent } = require("./media_security");
const { sanitizeHeaderValue, isValidHttpHeaderName } = require("./transport_security");

const DEFAULT_MAX_WEB_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MiB

const TRUSTED_TENCENT_ROOT_DOMAINS = Object.freeze([
  "qq.com",
  "tenpay.com",
  "gtimg.cn",
  "gtimg.com",
  "weiyun.com",
  "tencent.com",
  "qlogo.cn",
  "qpic.cn",
  "myqcloud.com",
  "qcloud.com",
]);

const WEB_CREDENTIAL_ACTIONS = new Set([
  "get_clientkey",
  "get_cookies",
  "get_csrf_token",
  "get_credentials",
  "get_qzone_msg_list",
  "get_qzone_feeds",
  "send_qzone_msg",
  "delete_qzone_msg",
  "like_qzone",
  "unlike_qzone",
  "comment_qzone",
]);

function assertWebCredentialApiEnabled(config, actionName = "") {
  const enabled = Boolean(
    config?.enableWebCredentialApi ||
      process.env.ROSMONTIS_ENABLE_WEB_CREDENTIAL_API === "1" ||
      process.env.ONEBOT_ENABLE_WEB_CREDENTIAL_API === "1" ||
      process.env.XIAO_BRIDGE_ENABLE_WEB_CREDENTIAL_API === "1"
  );
  if (!enabled) {
    const label = actionName ? `Action "${actionName}"` : "Web credential API";
    const err = new Error(
      `${label} is disabled by default to protect account credentials (clientkey/skey/p_skey). ` +
        `Set "enableWebCredentialApi": true in rosmontis.json or ROSMONTIS_ENABLE_WEB_CREDENTIAL_API=1 to enable.`
    );
    err.code = "ERR_WEB_CREDENTIAL_API_DISABLED";
    throw err;
  }
  return true;
}

function computeBkn(skey) {
  const str = String(skey || "");
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash += (hash << 5) + str.charCodeAt(i);
  }
  return hash & 2147483647;
}

function cookieObjToString(cookieObj) {
  if (!cookieObj || typeof cookieObj !== "object") return "";
  return Object.entries(cookieObj)
    .filter(([k, v]) => k && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${sanitizeHeaderValue(k)}=${sanitizeHeaderValue(v)}`)
    .join("; ");
}

function isTrustedTencentHost(hostname, extraDomains = null) {
  if (typeof hostname !== "string") return false;
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  const domains =
    Array.isArray(extraDomains) && extraDomains.length > 0
      ? [...TRUSTED_TENCENT_ROOT_DOMAINS, ...extraDomains.map((d) => String(d || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "")).filter(Boolean)]
      : TRUSTED_TENCENT_ROOT_DOMAINS;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function isAllowedCookieRedirectUrl(nextUrlObj, initialUrlObj, options = {}) {
  if (!nextUrlObj || typeof nextUrlObj.protocol !== "string") return false;
  const proto = nextUrlObj.protocol.toLowerCase();
  if (options && options.allowAnyRedirectHost === true) {
    if (proto !== "https:" && proto !== "http:") return false;
    if (
      initialUrlObj &&
      initialUrlObj.protocol.toLowerCase() === "https:" &&
      proto !== "https:" &&
      options.allowInsecureRedirect !== true
    ) {
      return false;
    }
    return true;
  }
  if (proto !== "https:") return false;
  return isTrustedTencentHost(nextUrlObj.hostname, options?.trustedRedirectDomains);
}

function _sanitizeHeadersObject(rawHeaders = {}, includeDefaultUa = false) {
  const out = {};
  if (includeDefaultUa) {
    out["User-Agent"] = sanitizeHeaderValue(buildNtqqUserAgent());
  }
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (v === undefined || v === null) continue;
      if (!isValidHttpHeaderName(k)) continue;
      if (includeDefaultUa && k.toLowerCase() === "user-agent") {
        delete out["User-Agent"];
      }
      out[k] = sanitizeHeaderValue(v);
    }
  }
  return out;
}

function httpsGetCookies(urlStr, depthOrOptions = 0, maybeOptions = {}) {
  let depth = 0;
  let options = maybeOptions && typeof maybeOptions === "object" ? maybeOptions : {};
  if (depthOrOptions && typeof depthOrOptions === "object") {
    options = depthOrOptions;
    depth = Number(options.depth || 0);
  } else {
    depth = Number(depthOrOptions || 0);
  }
  const maxRedirects =
    Number.isFinite(Number(options.maxRedirects)) && Number(options.maxRedirects) >= 0
      ? Math.floor(Number(options.maxRedirects))
      : 5;
  const timeoutMs =
    Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : 8000;

  return new Promise((resolve) => {
    const cookies = {};
    let settled = false;
    const done = (extra) => {
      if (settled) return;
      settled = true;
      resolve(extra ? { ...cookies, ...extra } : cookies);
    };

    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (_) {
      return done();
    }
    const proto = parsed.protocol.toLowerCase();
    if (proto !== "https:" && proto !== "http:") {
      return done();
    }

    const mod = proto === "https:" ? https : http;
    const reqHeaders = _sanitizeHeadersObject(options.headers, true);
    const req = mod.get(
      {
        hostname: parsed.hostname,
        port: parsed.port || (proto === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        const setCookie = res.headers["set-cookie"];
        if (Array.isArray(setCookie)) {
          for (const item of setCookie) {
            const firstPair = String(item).split(";")[0];
            const eqIdx = firstPair ? firstPair.indexOf("=") : -1;
            if (eqIdx > 0) {
              const cKey = sanitizeHeaderValue(firstPair.slice(0, eqIdx).trim());
              const cVal = sanitizeHeaderValue(firstPair.slice(eqIdx + 1).trim());
              if (cKey && cVal) {
                cookies[cKey] = cVal;
              }
            }
          }
        }

        let drainedBytes = 0;
        res.on("data", (chunk) => {
          drainedBytes += chunk ? chunk.length : 0;
          if (drainedBytes > 1024 * 1024) {
            try {
              res.destroy();
            } catch (_) {}
          }
        });

        const handleRedirectOrFinish = () => {
          const loc = res.headers.location;
          if (
            res.statusCode &&
            [301, 302, 303, 307, 308].includes(res.statusCode) &&
            loc &&
            depth < maxRedirects
          ) {
            let nextParsed;
            try {
              nextParsed = new URL(loc, urlStr);
            } catch (_) {
              return done();
            }
            if (!isAllowedCookieRedirectUrl(nextParsed, parsed, options)) {
              return done();
            }
            httpsGetCookies(nextParsed.toString(), depth + 1, options)
              .then((rc) => done(rc))
              .catch(() => done());
          } else {
            done();
          }
        };

        res.on("end", handleRedirectOrFinish);
        res.on("close", handleRedirectOrFinish);
        res.on("error", () => done());
      }
    );

    req.on("timeout", () => {
      req.destroy();
      done();
    });
    req.on("error", () => done());
  });
}

function _createResponseTooLargeError(limit, urlStr) {
  const err = new Error(
    `HTTP response body exceeded maximum limit (${limit} bytes) for ${urlStr}`
  );
  err.code = "ERR_HTTP_RESPONSE_TOO_LARGE";
  return err;
}

function httpRequestText(
  urlStr,
  method = "GET",
  body = "",
  headers = {},
  redirectsLeft = 4,
  options = {}
) {
  let remainingRedirects = 4;
  let opts = options && typeof options === "object" ? options : {};
  if (redirectsLeft && typeof redirectsLeft === "object") {
    opts = redirectsLeft;
    remainingRedirects =
      Number.isFinite(Number(opts.redirectsLeft)) && Number(opts.redirectsLeft) >= 0
        ? Math.floor(Number(opts.redirectsLeft))
        : 4;
  } else if (Number.isFinite(Number(redirectsLeft)) && Number(redirectsLeft) >= 0) {
    remainingRedirects = Math.floor(Number(redirectsLeft));
  }

  const parsedMaxBytes = Number(opts.maxResponseBytes);
  const maxResponseBytes =
    Number.isFinite(parsedMaxBytes) && parsedMaxBytes > 0
      ? Math.floor(parsedMaxBytes)
      : DEFAULT_MAX_WEB_RESPONSE_BYTES;
  const timeoutMs =
    Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
      ? Math.floor(Number(opts.timeoutMs))
      : 12000;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const proto = parsed.protocol.toLowerCase();
    if (proto !== "https:" && proto !== "http:") {
      return reject(new Error(`Unsupported HTTP protocol: ${parsed.protocol}`));
    }

    const upperMethod = String(method || "GET").toUpperCase();
    const mod = proto === "https:" ? https : http;
    const reqHeaders = _sanitizeHeadersObject(headers, true);
    const bodyBuf =
      body && (upperMethod === "POST" || upperMethod === "PUT" || upperMethod === "PATCH")
        ? Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8")
        : null;

    const hasContentLength = Object.keys(reqHeaders).some(
      (k) => k.toLowerCase() === "content-length"
    );
    if (bodyBuf && !hasContentLength) {
      reqHeaders["Content-Length"] = String(bodyBuf.length);
    }

    let settled = false;
    const settleResolve = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (proto === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: upperMethod,
        headers: reqHeaders,
        timeout: timeoutMs,
      },
      (res) => {
        if (
          res.statusCode &&
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          remainingRedirects > 0
        ) {
          res.resume();
          let nextParsed;
          try {
            nextParsed = new URL(res.headers.location, urlStr);
          } catch (e) {
            return settleReject(e);
          }
          const nextProto = nextParsed.protocol.toLowerCase();
          if (nextProto !== "https:" && nextProto !== "http:") {
            return settleReject(
              new Error(`Blocked redirect to unsupported protocol: ${nextParsed.protocol}`)
            );
          }
          const forwardedHeaders = { ...headers };
          if (
            nextParsed.origin !== parsed.origin &&
            !isTrustedTencentHost(nextParsed.hostname)
          ) {
            for (const key of Object.keys(forwardedHeaders)) {
              const lower = key.toLowerCase();
              if (lower === "cookie" || lower === "authorization") {
                delete forwardedHeaders[key];
              }
            }
          }
          const shouldSwitchToGet =
            res.statusCode === 303 ||
            ((res.statusCode === 301 || res.statusCode === 302) && upperMethod === "POST");
          const nextMethod = shouldSwitchToGet ? "GET" : upperMethod;
          const nextBody = shouldSwitchToGet ? "" : body;

          httpRequestText(
            nextParsed.toString(),
            nextMethod,
            nextBody,
            forwardedHeaders,
            remainingRedirects - 1,
            opts
          ).then(settleResolve, settleReject);
          return;
        }

        const clHeader = res.headers["content-length"];
        if (clHeader !== undefined && String(clHeader).trim() !== "") {
          const declaredLen = Number(clHeader);
          if (Number.isFinite(declaredLen) && declaredLen > maxResponseBytes) {
            const err = _createResponseTooLargeError(maxResponseBytes, urlStr);
            try {
              res.destroy();
              req.destroy();
            } catch (_) {}
            return settleReject(err);
          }
        }

        const chunks = [];
        let totalBytes = 0;
        res.on("data", (chunk) => {
          if (settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > maxResponseBytes) {
            chunks.length = 0;
            const err = _createResponseTooLargeError(maxResponseBytes, urlStr);
            try {
              res.destroy();
              req.destroy();
            } catch (_) {}
            settleReject(err);
            return;
          }
          chunks.push(buf);
        });
        res.on("end", () => {
          if (settled) return;
          settleResolve(Buffer.concat(chunks, totalBytes).toString("utf8"));
        });
        res.on("error", settleReject);
      }
    );

    req.on("timeout", () => req.destroy(new Error(`HTTP timeout: ${urlStr}`)));
    req.on("error", settleReject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function parseJsonpOrJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch (_) {}
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    } catch (_) {}
  }
  return {};
}

module.exports = {
  DEFAULT_MAX_WEB_RESPONSE_BYTES,
  TRUSTED_TENCENT_ROOT_DOMAINS,
  WEB_CREDENTIAL_ACTIONS,
  assertWebCredentialApiEnabled,
  computeBkn,
  cookieObjToString,
  isTrustedTencentHost,
  httpsGetCookies,
  httpRequestText,
  parseJsonpOrJson,
};
