"use strict";

const http = require("http");
const https = require("https");

/**
 * Web Credential, Cookie & QZone Action Gate (`src/core/qzone_actions.js`)
 *
 * Isolates high-privilege web credential (`clientkey`, `p_skey`, `skey`, `bkn`/`csrf_token`)
 * and QZone actions behind an explicit opt-in security gate while leaving internal NT media
 * CDN rkey actions (`get_rkey` / `nc_get_rkey`) unblocked.
 */

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

function isWebCredentialApiEnabled(config) {
  return (
    config?.enableWebCredentialApi === true ||
    process.env.ROSMONTIS_ENABLE_WEB_CREDENTIAL_API === "1" ||
    process.env.ONEBOT_ENABLE_WEB_CREDENTIAL_API === "1" ||
    process.env.XIAO_BRIDGE_ENABLE_WEB_CREDENTIAL_API === "1"
  );
}

function assertWebCredentialApiEnabled(config, action = "") {
  if (!isWebCredentialApiEnabled(config)) {
    const label = action ? ` for action '${action}'` : "";
    const err = new Error(
      `Web credential / QZone API is disabled by default${label}; set enableWebCredentialApi=true or ROSMONTIS_ENABLE_WEB_CREDENTIAL_API=1 to enable`
    );
    err.code = "ERR_WEB_CREDENTIAL_API_DISABLED";
    throw err;
  }
}

function defaultComputeBkn(skey) {
  const s = String(skey || "");
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash += (hash << 5) + s.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

function defaultCookieObjToString(cookies) {
  if (!cookies || typeof cookies !== "object") return "";
  return Object.entries(cookies)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function defaultParseJsonpOrJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {}
  const firstParen = raw.indexOf("(");
  const lastParen = raw.lastIndexOf(")");
  if (firstParen !== -1 && lastParen > firstParen) {
    try {
      return JSON.parse(raw.slice(firstParen + 1, lastParen));
    } catch (_) {}
  }
  return {};
}

function defaultHttpsGetCookies(urlStr, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const collected = {};
    function step(currentUrl, remaining) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (err) {
        reject(err);
        return;
      }
      const mod = parsed.protocol === "http:" ? http : https;
      const req = mod.request(
        parsed,
        {
          method: "GET",
          timeout: 10000,
          headers: {
            Cookie: defaultCookieObjToString(collected),
          },
        },
        (res) => {
          const setCookie = res.headers["set-cookie"] || [];
          for (const line of setCookie) {
            const pair = String(line).split(";")[0];
            const eqIdx = pair.indexOf("=");
            if (eqIdx > 0) {
              const k = pair.slice(0, eqIdx).trim();
              const v = pair.slice(eqIdx + 1).trim();
              if (v) collected[k] = v;
            }
          }
          res.resume();
          const loc = res.headers.location;
          if (loc && remaining > 0 && res.statusCode >= 300 && res.statusCode < 400) {
            const nextUrl = new URL(loc, parsed).toString();
            step(nextUrl, remaining - 1);
            return;
          }
          resolve(collected);
        }
      );
      req.on("timeout", () => req.destroy(new Error("httpsGetCookies timeout")));
      req.on("error", reject);
      req.end();
    }
    step(urlStr, maxRedirects);
  });
}

function defaultHttpRequestText(urlStr, method = "GET", body = "", headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = parsed.protocol === "http:" ? http : https;
    const payloadBuf = body ? Buffer.from(String(body), "utf8") : null;
    const reqHeaders = { ...headers };
    if (payloadBuf && reqHeaders["Content-Length"] === undefined) {
      reqHeaders["Content-Length"] = payloadBuf.length;
    }
    const req = mod.request(
      parsed,
      {
        method,
        timeout: 15000,
        headers: reqHeaders,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );
    req.on("timeout", () => req.destroy(new Error("httpRequestText timeout")));
    req.on("error", reject);
    if (payloadBuf) req.write(payloadBuf);
    req.end();
  });
}

function resolveHelpers(helpers = {}) {
  return {
    computeBkn:
      typeof helpers?.computeBkn === "function" ? helpers.computeBkn : defaultComputeBkn,
    cookieObjToString:
      typeof helpers?.cookieObjToString === "function"
        ? helpers.cookieObjToString
        : defaultCookieObjToString,
    httpsGetCookies:
      typeof helpers?.httpsGetCookies === "function"
        ? helpers.httpsGetCookies
        : defaultHttpsGetCookies,
    httpRequestText:
      typeof helpers?.httpRequestText === "function"
        ? helpers.httpRequestText
        : defaultHttpRequestText,
    parseJsonpOrJson:
      typeof helpers?.parseJsonpOrJson === "function"
        ? helpers.parseJsonpOrJson
        : defaultParseJsonpOrJson,
  };
}

async function fetchClientKey(bridge) {
  const res = await bridge.invokeNt("nodeIKernelTicketService/forceFetchClientKey", {}, []);
  return {
    clientKey: String(res?.clientKey || ""),
    expireTime: String(res?.expireTime || "7200"),
    keyIndex: String(res?.keyIndex || "19"),
    url: String(res?.url || ""),
  };
}

async function getCookiesObject(bridge, domain = "qun.qq.com", helpers = {}) {
  const { httpsGetCookies } = resolveHelpers(helpers);
  const uin = bridge.selfUin || "0";
  const uinCookie = `o${String(uin).padStart(10, "0")}`;
  const cookies = {
    uin: uinCookie,
    p_uin: uinCookie,
  };

  for (const psCmd of [
    "nodeIKernelTipOffService/getPskey",
    "nodeIKernelTicketService/getPskey",
  ]) {
    if (cookies.p_skey) break;
    try {
      const psRes = await bridge.invokeNt(
        psCmd,
        { domainList: [domain], isForNewPCQQ: true },
        [[domain], true]
      );
      const map = psRes?.domainPskeyMap || psRes;
      const pskey =
        map instanceof Map ? map.get(domain) : map && typeof map === "object" ? map[domain] : "";
      if (pskey) cookies.p_skey = String(pskey);
    } catch (_) {}
  }

  if (!cookies.p_skey && bridge.config?.allowPtloginJump !== false) {
    try {
      const ck = await fetchClientKey(bridge);
      if (ck.clientKey) {
        const jumpUrl =
          `https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=${uin}` +
          `&clientkey=${encodeURIComponent(ck.clientKey)}` +
          `&u1=${encodeURIComponent(`https://${domain}/${uin}/infocenter`)}` +
          `&keyindex=${encodeURIComponent(ck.keyIndex || "19")}`;
        const fetched = await httpsGetCookies(jumpUrl);
        Object.assign(cookies, fetched);
      }
    } catch (_) {}
  }

  return cookies;
}

async function dispatchWebCredentialOrQzoneAction(bridge, action, p = {}, helpers = {}) {
  const act = String(action || "").replace(/^\/+/, "").trim();
  assertWebCredentialApiEnabled(bridge?.config, act);

  const params = p && typeof p === "object" ? p : {};
  const resolvedHelpers = resolveHelpers(helpers);
  const { computeBkn, cookieObjToString, httpRequestText, parseJsonpOrJson } = resolvedHelpers;

  switch (act) {
    case "get_clientkey":
      return await fetchClientKey(bridge);

    case "get_cookies": {
      const cookies = await getCookiesObject(bridge, params.domain || "qun.qq.com", resolvedHelpers);
      return { cookies: cookieObjToString(cookies) };
    }

    case "get_csrf_token": {
      const cookies = await getCookiesObject(bridge, params.domain || "qun.qq.com", resolvedHelpers);
      const token = computeBkn(cookies.p_skey || cookies.skey);
      return { token };
    }

    case "get_credentials": {
      const cookies = await getCookiesObject(bridge, params.domain || "qun.qq.com", resolvedHelpers);
      const token = computeBkn(cookies.p_skey || cookies.skey);
      return {
        cookies: cookieObjToString(cookies),
        token,
        csrf_token: token,
      };
    }

    case "get_qzone_msg_list": {
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = computeBkn(cookies.p_skey || cookies.skey);
      const targetUin = String(params.target_uin || bridge.selfUin || "");
      const pos = Number(params.pos || 0);
      const num = Number(params.num || 10);
      const url =
        `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6?` +
        new URLSearchParams({
          uin: targetUin,
          ftype: "0",
          sort: "0",
          pos: String(pos),
          num: String(num),
          replynum: "100",
          g_tk: String(bkn),
          callback: "_preloadCallback",
          code_version: "1",
          format: "jsonp",
          need_private_comment: "1",
        }).toString();
      const text = await httpRequestText(url, "GET", "", {
        Cookie: cookieObjToString(cookies),
      });
      const data = parseJsonpOrJson(text);
      const list = Array.isArray(data.msglist) ? data.msglist : [];
      return {
        total: Number(data.total ?? list.length),
        msglist: list.map((e) => ({
          tid: String(e.tid || ""),
          content: String(e.content || ""),
          time: Number(e.created_time || 0),
          comment_num: Number(e.cmtnum || 0),
          is_private: Number(e.secret || 0) !== 0,
          images: Array.isArray(e.pic)
            ? e.pic.map((pic) => pic.url2 || pic.url3 || pic.url1 || "").filter(Boolean)
            : [],
        })),
      };
    }

    case "get_qzone_feeds": {
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = computeBkn(cookies.p_skey || cookies.skey);
      const url =
        `https://h5.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?` +
        new URLSearchParams({
          uin: String(bridge.selfUin || ""),
          scope: "0",
          view: "1",
          filter: "all",
          flag: "1",
          applist: "all",
          pagenum: String(params.page_num || 1),
          count: String(params.count || 10),
          g_tk: String(bkn),
          callback: "_preloadCallback",
          format: "jsonp",
          useutf8: "1",
          outputhtmlfeed: "1",
        }).toString();
      const text = await httpRequestText(url, "GET", "", {
        Cookie: cookieObjToString(cookies),
      });
      const data = parseJsonpOrJson(text);
      const rawFeeds = Array.isArray(data.data?.data) ? data.data.data : [];
      return {
        feeds: rawFeeds.filter(Boolean).map((f) => ({
          uin: Number(f.uin || 0),
          nickname: String(f.nickname || ""),
          time: Number(f.abstime || 0),
          appid: Number(f.appid || 0),
          key: String(f.key || f.feedskey || ""),
          html: String(f.html || ""),
        })),
        has_more: Number(data.data?.hasmore || 0) !== 0,
      };
    }

    case "send_qzone_msg": {
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = computeBkn(cookies.p_skey || cookies.skey);
      const hostUin = String(bridge.selfUin || "");
      const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${bkn}`;
      const body = new URLSearchParams({
        syn_tweet_verson: "1",
        paramstr: "1",
        con: String(params.content || ""),
        feedversion: "1",
        ver: "1",
        ugc_right: String(params.ugc_right || 1),
        to_sign: "0",
        who: "1",
        hostuin: hostUin,
        code_version: "1",
        format: "json",
        qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
      }).toString();
      const text = await httpRequestText(url, "POST", body, {
        Cookie: cookieObjToString(cookies),
        "Content-Type": "application/x-www-form-urlencoded",
      });
      const data = parseJsonpOrJson(text);
      return {
        tid: String(data.t1_tid || data.tid || `qz_${Date.now()}`),
        time: Number(data.t1_time || data.now || Math.floor(Date.now() / 1000)),
      };
    }

    case "delete_qzone_msg": {
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = computeBkn(cookies.p_skey || cookies.skey);
      const hostUin = String(bridge.selfUin || "");
      const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${bkn}`;
      const body = new URLSearchParams({
        hostuin: hostUin,
        tid: String(params.tid || ""),
        t1_source: "1",
        code_version: "1",
        format: "fs",
        qzreferrer: `https://user.qzone.qq.com/${hostUin}`,
      }).toString();
      await httpRequestText(url, "POST", body, {
        Cookie: cookieObjToString(cookies),
        "Content-Type": "application/x-www-form-urlencoded",
      });
      return {};
    }

    case "like_qzone":
    case "unlike_qzone": {
      const like = act === "like_qzone";
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = computeBkn(cookies.p_skey || cookies.skey);
      const opUin = String(bridge.selfUin || "");
      const targetUin = String(params.target_uin || opUin);
      const tid = String(params.tid || "");
      const unikey = `http://user.qzone.qq.com/${targetUin}/mood/${tid}`;
      const url = `https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/${
        like ? "internal_dolike_app" : "internal_unlike_app"
      }?g_tk=${bkn}`;
      const body = new URLSearchParams({
        qzreferrer: `https://user.qzone.qq.com/${opUin}`,
        opuin: opUin,
        unikey,
        curkey: unikey,
        appid: "311",
        typeid: "0",
        abstime: String(params.abstime || 0),
        fid: tid,
        from: "1",
        active: "0",
        fupdate: "1",
        format: "json",
      }).toString();
      await httpRequestText(url, "POST", body, {
        Cookie: cookieObjToString(cookies),
        "Content-Type": "application/x-www-form-urlencoded",
      });
      return {};
    }

    case "comment_qzone": {
      const cookies = await getCookiesObject(bridge, "qzone.qq.com", resolvedHelpers);
      const bkn = computeBkn(cookies.p_skey || cookies.skey);
      const selfUin = String(bridge.selfUin || "");
      const hostUin = String(params.target_uin || selfUin);
      const tid = String(params.tid || "");
      const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${bkn}`;
      const body = new URLSearchParams({
        qzreferrer: `https://user.qzone.qq.com/${selfUin}`,
        inCharset: "utf-8",
        outCharset: "utf-8",
        hostUin,
        format: "json",
        ref: "feeds",
        topicId: `${hostUin}_${tid}__1`,
        feedsType: "100",
        private: "0",
        paramstr: "1",
        uin: selfUin,
        content: String(params.content || ""),
        plat: "qzone",
        source: "ic",
        platformid: "52",
      }).toString();
      const text = await httpRequestText(url, "POST", body, {
        Cookie: cookieObjToString(cookies),
        "Content-Type": "application/x-www-form-urlencoded",
      });
      const data = parseJsonpOrJson(text);
      return { comment_id: String(data.commentid || data.commentId || "") };
    }

    default:
      throw new Error(`Unsupported web credential / QZone action: ${act}`);
  }
}

module.exports = {
  WEB_CREDENTIAL_ACTIONS,
  isWebCredentialApiEnabled,
  assertWebCredentialApiEnabled,
  fetchClientKey,
  getCookiesObject,
  dispatchWebCredentialOrQzoneAction,
};
