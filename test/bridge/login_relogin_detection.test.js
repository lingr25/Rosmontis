"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { NtqqOneBotBridge } = require("../../src/bridge_main");
const {
  extractQqErrorCodeFromText,
  extractLoginErrorInfo,
  extractPromptFromRendererText,
} = require("../../src/core/login_recovery");
const { DEFAULT_REGISTERED_EVENTS } = require("../../src/bridge_renderer");

async function httpRequest({ port, path, method = "GET", headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (_) {
            json = null;
          }
          resolve({ statusCode: res.statusCode, body: raw, json });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("extractQqErrorCodeFromText, extractLoginErrorInfo, and extractPromptFromRendererText parse w21 and structured NTQQ errors", () => {
  assert.equal(extractQqErrorCodeFromText("身份验证失败，请你重新登录。(w21)"), "w21");
  assert.equal(extractQqErrorCodeFromText("安全提示：登录已失效（w21）"), "w21");
  assert.equal(extractQqErrorCodeFromText("登录失败，错误码：140022015"), "140022015");
  assert.equal(extractQqErrorCodeFromText("正常提示文本"), "");

  const nested = extractLoginErrorInfo(
    {
      result: 140022015,
      loginErrorInfo: {
        errMsg: "身份验证失败，请你重新登录。(w21)",
        tipsTitle: "安全提示",
      },
    },
    "onLoginFailed"
  );
  assert.equal(nested.hasError, true);
  assert.equal(nested.code, "w21");
  assert.ok(nested.message.includes("身份验证失败，请你重新登录。(w21)"));

  const numericOnly = extractLoginErrorInfo(
    {
      serverErrorCode: 10008,
      errMsg: "ticket expired",
    },
    "onQRCodeSessionQuickLoginFailed"
  );
  assert.equal(numericOnly.hasError, true);
  assert.equal(numericOnly.code, "10008");
  assert.equal(numericOnly.message, "ticket expired");

  const circular = { errMsg: "re-login needed (w21)" };
  circular.self = circular;
  const circParsed = extractLoginErrorInfo(circular, "onLoginFailed");
  assert.equal(circParsed.code, "w21");

  const promptHit = extractPromptFromRendererText(
    "登录\n安全提示\n身份验证失败，请你重新登录。(w21)\n确定"
  );
  assert.ok(promptHit);
  assert.equal(promptHit.code, "w21");
  assert.equal(promptHit.message, "身份验证失败，请你重新登录。(w21)");

  assert.equal(extractPromptFromRendererText("欢迎使用 QQ\n扫码登录更安全"), null);
});

test("bridge_renderer registers NTQQ login failure listener events by default", () => {
  for (const ev of [
    "nodeIKernelLoginListener/onLoginFailed",
    "nodeIKernelLoginListener/onQuickLoginFailed",
    "nodeIKernelLoginListener/onPasswordLoginFailed",
    "nodeIKernelLoginListener/onQRCodeSessionFailed",
    "nodeIKernelLoginListener/onQRCodeSessionQuickLoginFailed",
    "nodeIKernelLoginListener/onLoginState",
    "nodeIKernelLoginListener/onLoginDisConnected",
    "nodeIKernelLoginListener/onLogoutSucceed",
  ]) {
    assert.ok(
      DEFAULT_REGISTERED_EVENTS.includes(ev),
      `Expected DEFAULT_REGISTERED_EVENTS to include ${ev}`
    );
  }
});

test("onLoginFailed / onQRCodeSessionQuickLoginFailed surface relogin_required + w21 in /ready, /health, /metrics, get_status, and WARN logs, then clear on login", async () => {
  const warnLogs = [];
  const bridge = new NtqqOneBotBridge({
    online: false,
    selfUin: "10001",
    selfUid: "u_self",
    selfNickname: "Bot",
    config: {
      httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "tok" }],
      wsServers: [],
      wsClients: [],
      httpClients: [],
      quietLogs: true,
    },
    ntApi: {
      invoke: async () => ({ result: 0 }),
    },
  });
  bridge.logger = {
    info: () => {},
    warn: (msg) => warnLogs.push(String(msg || "")),
    error: () => {},
    debug: () => {},
  };

  try {
    await bridge.startServers();
    const port = bridge.serverRuntime._httpServers[0].address().port;
    const authHeaders = { Authorization: "Bearer tok" };

    // Normal offline without error does not set relogin_required
    const initialReady = await httpRequest({ port, path: "/ready", headers: authHeaders });
    assert.equal(initialReady.statusCode, 503);
    assert.equal(initialReady.json.online, false);
    assert.equal(initialReady.json.relogin_required, undefined);

    // 1. Simulate NTQQ emitting onLoginFailed with w21
    await bridge.inboundPipeline._handleKernelEvent("nodeIKernelLoginListener", "onLoginFailed", [
      {
        result: 140022015,
        loginErrorInfo: {
          tipsTitle: "安全提示",
          tipsContent: "身份验证失败，请你重新登录。(w21)",
        },
      },
    ]);

    assert.ok(
      warnLogs.some((line) => line.includes("re-login") && line.includes("w21")),
      `Expected WARN log mentioning re-login and w21, got: ${JSON.stringify(warnLogs)}`
    );

    // /ready returns 503 with relogin_required + code + message
    const reloginReady = await httpRequest({ port, path: "/ready", headers: authHeaders });
    assert.equal(reloginReady.statusCode, 503);
    assert.equal(reloginReady.json.ready, false);
    assert.equal(reloginReady.json.online, false);
    assert.equal(reloginReady.json.relogin_required, true);
    assert.equal(reloginReady.json.login_state, "relogin_required");
    assert.equal(reloginReady.json.login_error_code, "w21");
    assert.ok(reloginReady.json.login_error_message.includes("身份验证失败，请你重新登录。(w21)"));

    // /health stays 200 but surfaces relogin_required + code
    const healthRes = await httpRequest({ port, path: "/health", headers: authHeaders });
    assert.equal(healthRes.statusCode, 200);
    assert.equal(healthRes.json.relogin_required, true);
    assert.equal(healthRes.json.login_error_code, "w21");

    // /metrics exposes rosmontis_relogin_required 1
    const metricsFail = await httpRequest({ port, path: "/metrics", headers: authHeaders });
    assert.equal(metricsFail.statusCode, 200);
    assert.match(metricsFail.body, /rosmontis_relogin_required 1/);

    // get_status exposes bridge.login
    const statusRes = await bridge.handleOneBotAction("get_status", {});
    assert.equal(statusRes.status, "ok");
    assert.equal(statusRes.data.bridge.login.state, "relogin_required");
    assert.equal(statusRes.data.bridge.login.relogin_required, true);
    assert.equal(statusRes.data.bridge.login.error_code, "w21");

    // A subsequent generic quick-login failure without code preserves the specific w21 code
    await bridge.inboundPipeline._handleKernelEvent(
      "nodeIKernelLoginListener",
      "onQRCodeSessionQuickLoginFailed",
      [{ pngBase64QrcodeData: "data:image/png;base64,QUJD" }]
    );
    assert.equal(bridge.lastQrCodeBase64, "data:image/png;base64,QUJD");
    assert.equal(bridge.inboundPipeline.getLoginState().error_code, "w21");

    // 2. Simulate successful re-login -> clears relogin_required everywhere
    await bridge.inboundPipeline._handleKernelEvent("nodeIKernelLoginListener", "onUserLoggedIn", [
      { uin: "10001", uid: "u_self", nickName: "Bot" },
    ]);

    const recoveredReady = await httpRequest({ port, path: "/ready", headers: authHeaders });
    assert.equal(recoveredReady.statusCode, 200);
    assert.equal(recoveredReady.json.ready, true);
    assert.equal(recoveredReady.json.online, true);
    assert.equal(recoveredReady.json.relogin_required, undefined);

    const metricsOk = await httpRequest({ port, path: "/metrics", headers: authHeaders });
    assert.match(metricsOk.body, /rosmontis_relogin_required 0/);

    const statusRecovered = await bridge.handleOneBotAction("get_status", {});
    assert.equal(statusRecovered.data.bridge.login.state, "online");
    assert.equal(statusRecovered.data.bridge.login.relogin_required, false);
  } finally {
    await bridge.stopServers();
  }
});

test("tryAutoQuickLogin captures non-zero quickLoginWithUin error and falls back to renderer security prompt detection", async () => {
  const warnLogs = [];
  const bridge = new NtqqOneBotBridge({
    online: false,
    selfUin: "10001",
    config: { quietLogs: true },
    rendererExecute: async (cmd) => {
      if (cmd === "nodeIKernelLoginService/setAutoLogin") {
        throw new Error("Renderer IPC command timeout (15000ms): invokeNt");
      }
      if (cmd === "nodeIKernelLoginService/getLoginList") {
        return {
          LocalLoginInfoList: [
            { uin: "10001", uid: "u_10001", nickName: "Bot", isQuickLogin: true, isAutoLogin: true },
          ],
        };
      }
      if (
        cmd === "nodeIKernelLoginService/quickLoginWithUin" ||
        cmd === "nodeIKernelLoginService/quickLogin"
      ) {
        return { result: 140022015, errMsg: "quick login rejected" };
      }
      return { result: 0 };
    },
  });
  bridge.logger = {
    info: () => {},
    warn: (msg) => warnLogs.push(String(msg || "")),
    error: () => {},
    debug: () => {},
  };

  // Mock a trusted login webContents showing the w21 security prompt dialog
  const mockWebContents = {
    isDestroyed: () => false,
    getURL: () => "app://./renderer/index.html#/login",
    executeJavaScript: async (script) => {
      if (String(script).includes("q-dialog")) {
        return "安全提示\n身份验证失败，请你重新登录。(w21)\n确定";
      }
      return false;
    },
  };

  const res = await bridge.inboundPipeline._tryAutoQuickLogin({
    force: true,
    webContents: mockWebContents,
  });
  assert.equal(res.triggered, false);
  assert.equal(res.login_state.relogin_required, true);
  assert.equal(res.login_state.error_code, "w21");
  assert.ok(res.login_state.error_message.includes("身份验证失败，请你重新登录。(w21)"));
  assert.ok(warnLogs.some((line) => line.includes("w21")));

  // Also verify onLoginState without error fields does not falsely mark relogin_required
  bridge.inboundPipeline._clearLoginError();
  await bridge.inboundPipeline._handleKernelEvent("nodeIKernelLoginListener", "onLoginState", [
    { state: 1 },
  ]);
  assert.equal(bridge.inboundPipeline.getLoginState().relogin_required, false);
});
