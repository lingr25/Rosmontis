"use strict";

/**
 * Constant-time auth, Origin guard, Protected Mode, HTTP 413 cap, RFC 6455 WS hardening, backpressure & ping/pong timeout
 * Migrated from test/test_bridge.js sections: 15, 21.
 */

const test = require("node:test");
const assert = require("assert");
const crypto = require("crypto");
const EventEmitter = require("events");
const http = require("http");
const net = require("net");
const { onebot, mainMod } = require("./_helpers");
// === Section 15: Testing Transport, Auth, Origin Guard, Protected Mode, Body Cap & RFC 6455 WS Hardening ===

test("Constant-time token auth (Bearer/Token/raw/query & allowQueryAccessToken: false), Origin guard, Protected Mode auto-token, HTTP 413 body cap, and RFC 6455 WS hardening", async () => {
  const transportSec = require("../../src/core/transport_security.js");

  // 1. Unit-level constant-time token verification
  assert.strictEqual(transportSec.verifyAccessTokenConstantTime("", ""), true);
  assert.strictEqual(transportSec.verifyAccessTokenConstantTime("", "secret"), false);
  assert.strictEqual(transportSec.verifyAccessTokenConstantTime(null, "secret"), false);
  assert.strictEqual(transportSec.verifyAccessTokenConstantTime("short", "much_longer_secret_token"), false);
  assert.strictEqual(transportSec.verifyAccessTokenConstantTime("exact_secret_123", "exact_secret_123"), true);

  const httpRequestRaw = ({ port, urlPath = "/get_status", method = "POST", headers = {}, body = "{}" }) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: urlPath,
          method,
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const rawText = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = JSON.parse(rawText);
            } catch (_) {}
            resolve({ statusCode: res.statusCode, json, rawText });
          });
        }
      );
      req.on("error", reject);
      req.end(body);
    });

  // 2. HTTP token formats (Bearer, Token, raw header, query param) + Origin guard + 413 body cap + WS hardening
  {
    const secBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self",
      online: true,
      config: {
        allowedOrigins: ["https://admin.rosmontis.local"],
        maxHttpBodyBytes: 1024,
        maxWsPayloadBytes: 256,
        httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "s3cr3t_t0k3n" }],
        wsServers: [{ host: "127.0.0.1", port: 0, accessToken: "s3cr3t_t0k3n" }],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
      },
    });
    await secBridge.startServers();
    try {
      const httpPort = secBridge._httpServers[0].address().port;
      const wsPort = secBridge._wsServers[0].address().port;

      // Missing / wrong token -> 401
      const rNoAuth = await httpRequestRaw({ port: httpPort });
      assert.strictEqual(rNoAuth.statusCode, 401);
      assert.strictEqual(rNoAuth.json.status, "failed");
      assert.strictEqual(rNoAuth.json.retcode, 1403);

      const rBadAuth = await httpRequestRaw({
        port: httpPort,
        headers: { Authorization: "Bearer wrong_token" },
      });
      assert.strictEqual(rBadAuth.statusCode, 401);

      // Bearer, Token, raw header, and ?access_token= query param -> 200
      const rBearer = await httpRequestRaw({
        port: httpPort,
        headers: { Authorization: "Bearer s3cr3t_t0k3n" },
      });
      assert.strictEqual(rBearer.statusCode, 200);
      assert.strictEqual(rBearer.json.status, "ok");

      const rTokenScheme = await httpRequestRaw({
        port: httpPort,
        headers: { Authorization: "Token s3cr3t_t0k3n" },
      });
      assert.strictEqual(rTokenScheme.statusCode, 200);
      assert.strictEqual(rTokenScheme.json.status, "ok");

      const rRawHdr = await httpRequestRaw({
        port: httpPort,
        headers: { Authorization: "s3cr3t_t0k3n" },
      });
      assert.strictEqual(rRawHdr.statusCode, 200);
      assert.strictEqual(rRawHdr.json.status, "ok");

      const rQuery = await httpRequestRaw({
        port: httpPort,
        urlPath: "/get_status?access_token=s3cr3t_t0k3n",
      });
      assert.strictEqual(rQuery.statusCode, 200);
      assert.strictEqual(rQuery.json.status, "ok");

      // Origin guard on HTTP POST: no Origin -> 200; evil.example or null -> 403; allowedOrigins -> 200
      const rEvilOrigin = await httpRequestRaw({
        port: httpPort,
        headers: {
          Authorization: "Bearer s3cr3t_t0k3n",
          Origin: "http://evil.example",
        },
      });
      assert.strictEqual(rEvilOrigin.statusCode, 403);
      assert.strictEqual(rEvilOrigin.json.status, "failed");
      assert.strictEqual(rEvilOrigin.json.retcode, 1403);

      const rNullOrigin = await httpRequestRaw({
        port: httpPort,
        headers: {
          Authorization: "Bearer s3cr3t_t0k3n",
          Origin: "null",
        },
      });
      assert.strictEqual(rNullOrigin.statusCode, 403);
      assert.strictEqual(rNullOrigin.json.status, "failed");
      assert.strictEqual(rNullOrigin.json.retcode, 1403);

      const rAllowedOrigin = await httpRequestRaw({
        port: httpPort,
        headers: {
          Authorization: "Bearer s3cr3t_t0k3n",
          Origin: "https://ADMIN.rosmontis.local",
        },
      });
      assert.strictEqual(rAllowedOrigin.statusCode, 200);
      assert.strictEqual(rAllowedOrigin.json.status, "ok");

      // HTTP JSON body size cap: maxHttpBodyBytes: 1024 rejects 4096-byte payload with 413 (retcode 1413)
      const bigBody = JSON.stringify({ padding: "x".repeat(4096) });
      const rTooLarge = await httpRequestRaw({
        port: httpPort,
        headers: { Authorization: "Bearer s3cr3t_t0k3n" },
        body: bigBody,
      });
      assert.strictEqual(rTooLarge.statusCode, 413);
      assert.strictEqual(rTooLarge.json.status, "failed");
      assert.strictEqual(rTooLarge.json.retcode, 1413);

      // Also test streaming chunked body without Content-Length exceeding 1024 bytes -> 413
      const rChunkedTooLarge = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: httpPort,
            path: "/get_status",
            method: "POST",
            headers: {
              Authorization: "Bearer s3cr3t_t0k3n",
              "Content-Type": "application/json",
              "Transfer-Encoding": "chunked",
            },
          },
          (res) => {
            const bufs = [];
            res.on("data", (c) => bufs.push(c));
            res.on("end", () => {
              resolve({
                statusCode: res.statusCode,
                json: JSON.parse(Buffer.concat(bufs).toString("utf8")),
              });
            });
          }
        );
        req.on("error", reject);
        req.write('{"pad":"' + "a".repeat(600));
        req.write("b".repeat(600) + '"}');
        req.end();
      });
      assert.strictEqual(rChunkedTooLarge.statusCode, 413);
      assert.strictEqual(rChunkedTooLarge.json.retcode, 1413);

      // WS upgrade with untrusted Origin receives HTTP/1.1 403 Forbidden
      const wsForbiddenResp = await new Promise((resolve, reject) => {
        const sock = net.connect(wsPort, "127.0.0.1");
        let raw = "";
        sock.on("connect", () => {
          const secKey = crypto.randomBytes(16).toString("base64");
          sock.write(
            [
              "GET / HTTP/1.1",
              `Host: 127.0.0.1:${wsPort}`,
              "Upgrade: websocket",
              "Connection: Upgrade",
              "Authorization: Bearer s3cr3t_t0k3n",
              "Origin: http://evil.example",
              `Sec-WebSocket-Key: ${secKey}`,
              "Sec-WebSocket-Version: 13",
              "",
              "",
            ].join("\r\n")
          );
        });
        sock.on("data", (c) => {
          raw += c.toString("utf8");
        });
        sock.on("close", () => resolve(raw));
        sock.on("error", reject);
      });
      assert.ok(
        wsForbiddenResp.startsWith("HTTP/1.1 403 Forbidden"),
        `Expected WS 403 Forbidden on untrusted Origin, got: ${wsForbiddenResp}`
      );

      // Helper to upgrade a raw WS client and observe protocol close code
      const openRawUpgradedWs = () =>
        new Promise((resolve, reject) => {
          const sock = net.connect(wsPort, "127.0.0.1");
          let buf = Buffer.alloc(0);
          let upgraded = false;
          const onData = (chunk) => {
            if (upgraded) return;
            buf = Buffer.concat([buf, chunk]);
            const sep = buf.indexOf("\r\n\r\n");
            if (sep === -1) return;
            const headerText = buf.subarray(0, sep).toString("utf8");
            const rest = buf.subarray(sep + 4);
            upgraded = true;
            sock.removeListener("data", onData);
            assert.ok(headerText.includes("101 Switching Protocols"));
            const clientConn = new mainMod.Rfc6455Connection(sock, { isClient: true });
            if (rest.length > 0) clientConn._onData(rest);
            resolve({ sock, clientConn });
          };
          sock.on("data", onData);
          sock.on("connect", () => {
            const secKey = crypto.randomBytes(16).toString("base64");
            sock.write(
              [
                "GET / HTTP/1.1",
                `Host: 127.0.0.1:${wsPort}`,
                "Upgrade: websocket",
                "Connection: Upgrade",
                "Authorization: Bearer s3cr3t_t0k3n",
                "Origin: https://admin.rosmontis.local",
                `Sec-WebSocket-Key: ${secKey}`,
                "Sec-WebSocket-Version: 13",
                "",
                "",
              ].join("\r\n")
            );
          });
          sock.on("error", reject);
        });

      // RFC 6455 hardening (a): Unmasked client-to-server frame triggers Close 1002
      {
        const { sock, clientConn } = await openRawUpgradedWs();
        const closePromise = new Promise((resolve) => {
          clientConn.once("close", (code, reason) => resolve({ code, reason }));
        });
        // Send UNMASKED frame (mask = false) from client to server
        sock.write(mainMod.encodeWsFrame(0x1, Buffer.from('{"action":"get_status"}'), false));
        const closeInfo = await closePromise;
        assert.strictEqual(closeInfo.code, 1002, `Expected Close 1002 for unmasked frame, got ${closeInfo.code}`);
        sock.destroy();
      }

      // RFC 6455 hardening (b): Oversized WS frame (> maxWsPayloadBytes = 256) triggers Close 1009 immediately
      {
        const { sock, clientConn } = await openRawUpgradedWs();
        const closePromise = new Promise((resolve) => {
          clientConn.once("close", (code, reason) => resolve({ code, reason }));
        });
        // Send masked 1024-byte frame exceeding 256-byte limit
        sock.write(mainMod.encodeWsFrame(0x1, Buffer.alloc(1024, 0x41), true));
        const closeInfo = await closePromise;
        assert.strictEqual(closeInfo.code, 1009, `Expected Close 1009 for oversized frame, got ${closeInfo.code}`);
        sock.destroy();
      }
    } finally {
      await secBridge.stopServers();
    }
  }

  // 3. allowQueryAccessToken: false rejects ?access_token= query tokens while allowing Authorization header
  {
    const noQueryBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self",
      online: true,
      config: {
        allowQueryAccessToken: false,
        httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "hdr_only_tok" }],
        wsServers: [],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
      },
    });
    await noQueryBridge.startServers();
    try {
      const port = noQueryBridge._httpServers[0].address().port;
      const rQueryBlocked = await httpRequestRaw({
        port,
        urlPath: "/get_status?access_token=hdr_only_tok",
      });
      assert.strictEqual(rQueryBlocked.statusCode, 401);
      assert.strictEqual(rQueryBlocked.json.retcode, 1403);

      const rHdrAllowed = await httpRequestRaw({
        port,
        headers: { Authorization: "Bearer hdr_only_tok" },
      });
      assert.strictEqual(rHdrAllowed.statusCode, 200);
      assert.strictEqual(rHdrAllowed.json.status, "ok");
    } finally {
      await noQueryBridge.stopServers();
    }
  }

  // 4. Protected Mode auto-token: 127.0.0.1 stays unauthenticated; 0.0.0.0 auto-generates 64-hex token
  {
    const savedPubEnv = {
      a: process.env.ROSMONTIS_ALLOW_UNAUTHENTICATED_PUBLIC,
      b: process.env.ONEBOT_ALLOW_UNAUTHENTICATED_PUBLIC,
      c: process.env.XIAO_BRIDGE_ALLOW_UNAUTHENTICATED_PUBLIC,
    };
    delete process.env.ROSMONTIS_ALLOW_UNAUTHENTICATED_PUBLIC;
    delete process.env.ONEBOT_ALLOW_UNAUTHENTICATED_PUBLIC;
    delete process.env.XIAO_BRIDGE_ALLOW_UNAUTHENTICATED_PUBLIC;

    const loopbackBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      online: true,
      config: {
        httpServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
        wsServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
      },
    });
    const publicBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      online: true,
      config: {
        httpServers: [{ host: "0.0.0.0", port: 0, accessToken: "" }],
        wsServers: [{ host: "0.0.0.0", port: 0, accessToken: "" }],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
      },
    });
    // Silence stderr warning during intentional Protected Mode test
    const origStderrWrite = process.stderr.write;
    const capturedWarnings = [];
    process.stderr.write = function (chunk, ...rest) {
      const s = String(chunk || "");
      if (s.includes("Protected Mode engaged")) {
        capturedWarnings.push(s);
        return true;
      }
      return origStderrWrite.call(process.stderr, chunk, ...rest);
    };
    try {
      await loopbackBridge.startServers();
      assert.strictEqual(loopbackBridge.config.httpServers[0].accessToken, "");
      assert.strictEqual(Boolean(loopbackBridge.config.httpServers[0].protectedModeAutoToken), false);
      const loopPort = loopbackBridge._httpServers[0].address().port;
      const rLoop = await httpRequestRaw({ port: loopPort });
      assert.strictEqual(rLoop.statusCode, 200);

      await publicBridge.startServers();
      const generatedToken = publicBridge.config.httpServers[0].accessToken;
      assert.match(generatedToken, /^[0-9a-f]{64}$/, "Expected 64-hex-char Protected Mode auto-token");
      assert.strictEqual(publicBridge.config.httpServers[0].protectedModeAutoToken, true);
      assert.strictEqual(publicBridge.config.wsServers[0].accessToken, generatedToken);
      assert.strictEqual(capturedWarnings.length, 1);

      const pubPort = publicBridge._httpServers[0].address().port;
      const rPubUnauth = await httpRequestRaw({ port: pubPort });
      assert.strictEqual(rPubUnauth.statusCode, 401);

      const rPubAuth = await httpRequestRaw({
        port: pubPort,
        headers: { Authorization: `Bearer ${generatedToken}` },
      });
      assert.strictEqual(rPubAuth.statusCode, 200);
      assert.strictEqual(rPubAuth.json.status, "ok");
    } finally {
      process.stderr.write = origStderrWrite;
      if (savedPubEnv.a !== undefined) process.env.ROSMONTIS_ALLOW_UNAUTHENTICATED_PUBLIC = savedPubEnv.a;
      if (savedPubEnv.b !== undefined) process.env.ONEBOT_ALLOW_UNAUTHENTICATED_PUBLIC = savedPubEnv.b;
      if (savedPubEnv.c !== undefined) process.env.XIAO_BRIDGE_ALLOW_UNAUTHENTICATED_PUBLIC = savedPubEnv.c;
      await loopbackBridge.stopServers();
      await publicBridge.stopServers();
    }
  }

  // 5. CRLF header injection attempt in connectReverseWebSocket is sanitized / rejected safely
  {
    // (a) Invalid header name with CRLF is rejected immediately without opening a socket
    let invalidHdrErr = null;
    const badHandle = mainMod.connectReverseWebSocket(
      "ws://127.0.0.1:65530/ws",
      { "X-Bad\r\nHeader": "injected" },
      () => {},
      () => {},
      (err) => {
        invalidHdrErr = err;
      }
    );
    assert.strictEqual(badHandle, null);
    assert.ok(invalidHdrErr && invalidHdrErr.code === "ERR_INVALID_HTTP_HEADER");

    // (b) Header value containing CRLF injection attempt has \r\n stripped before hitting the wire
    let capturedUpgradeRaw = "";
    const inspectSrv = net.createServer((sock) => {
      sock.on("data", (chunk) => {
        capturedUpgradeRaw += chunk.toString("utf8");
        if (capturedUpgradeRaw.includes("\r\n\r\n")) {
          sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        }
      });
    });
    await new Promise((resolve) => inspectSrv.listen(0, "127.0.0.1", resolve));
    const inspectPort = inspectSrv.address().port;
    try {
      await new Promise((resolve) => {
        mainMod.connectReverseWebSocket(
          `ws://127.0.0.1:${inspectPort}/onebot`,
          {
            Authorization: "Bearer safe_tok\r\nX-Injected-Evil: pwned\r\n\r\nGET /smuggled HTTP/1.1",
            "X-Role": "Universal\r\nEvil-Two: 1",
          },
          () => resolve(),
          () => {},
          () => resolve()
        );
      });
      const headerLines = capturedUpgradeRaw.split("\r\n");
      assert.strictEqual(
        headerLines.some((line) => /^x-injected-evil:/i.test(line) || /^evil-two:/i.test(line) || /^GET \/smuggled/i.test(line)),
        false,
        `CRLF injection leaked separate header lines: ${JSON.stringify(headerLines)}`
      );
      assert.ok(
        headerLines.some((line) => line.startsWith("Authorization: Bearer safe_tokX-Injected-Evil: pwned")),
        "Sanitized Authorization header should have CRLF stripped cleanly"
      );
    } finally {
      await new Promise((resolve) => inspectSrv.close(resolve));
    }
  }
});

// === Section 21: Testing WebSocket Send-Buffer Backpressure, Periodic ping/pong Timeout & listenErrors Reporting ===

test("Rfc6455Connection maxSendBufferBytes backpressure, periodic WS ping/pong timeout & EADDRINUSE listenErrors reporting", async () => {
  // 21a. Rfc6455Connection with maxSendBufferBytes: 1024
  const mockSocket = new EventEmitter();
  mockSocket.writableLength = 0;
  mockSocket.destroyed = false;
  mockSocket.written = [];
  mockSocket.write = (buf) => {
    mockSocket.written.push(buf);
    return true;
  };
  mockSocket.destroy = () => {
    if (!mockSocket.destroyed) {
      mockSocket.destroyed = true;
      mockSocket.emit("close");
    }
  };
  mockSocket.end = () => mockSocket.destroy();

  const conn = new mainMod.Rfc6455Connection(mockSocket, { maxSendBufferBytes: 1024 });
  const closeEvents = [];
  conn.on("close", (code, reason) => closeEvents.push({ code, reason }));

  // Healthy empty socket (writableLength: 0) allows a single 2048-byte frame without termination
  const okLarge = conn.sendText("a".repeat(2048));
  assert.strictEqual(okLarge, true);
  assert.strictEqual(conn.closed, false);
  assert.strictEqual(mockSocket.destroyed, false);
  assert.strictEqual(closeEvents.length, 0);
  assert.strictEqual(mockSocket.written.length, 1);

  // Stalled socket (writableLength: 600) + 600-byte frame (> 1024) terminates once with 1006 & destroys socket
  mockSocket.writableLength = 600;
  const okOverflow = conn.sendText("b".repeat(600));
  assert.strictEqual(okOverflow, false);
  assert.strictEqual(conn.closed, true);
  assert.strictEqual(mockSocket.destroyed, true);
  assert.strictEqual(closeEvents.length, 1);
  assert.strictEqual(closeEvents[0].code, 1006);

  // 21b. Periodic WS liveness (wsPingIntervalMs: 40, wsPongTimeoutMs: 90) evicts unresponsive raw TCP WS client
  const pingBridge = new mainMod.NtqqOneBotBridge({
    selfUin: "100010001",
    online: true,
    config: {
      httpServers: [],
      wsServers: [{ host: "127.0.0.1", port: 0, accessToken: "" }],
      wsClients: [],
      heartbeatIntervalMs: 0,
      wsPingIntervalMs: 40,
      wsPongTimeoutMs: 90,
      quietLogs: true,
    },
  });
  let rawTcpClient = null;
  try {
    await pingBridge.startServers();
    const wsPort = pingBridge._wsServers[0].address().port;

    let sawUpgrade = false;
    let sawPingFrame = false;
    let upgradedAt = 0;

    const closedElapsedMs = await new Promise((resolve, reject) => {
      const safetyTimer = setTimeout(() => {
        reject(new Error("Timed out waiting for unresponsive WS client termination"));
      }, 1200);
      rawTcpClient = net.connect({ host: "127.0.0.1", port: wsPort }, () => {
        const secKey = crypto.randomBytes(16).toString("base64");
        rawTcpClient.write(
          [
            "GET / HTTP/1.1",
            `Host: 127.0.0.1:${wsPort}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${secKey}`,
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n")
        );
      });
      let rxBuf = Buffer.alloc(0);
      rawTcpClient.on("data", (chunk) => {
        rxBuf = Buffer.concat([rxBuf, chunk]);
        if (!sawUpgrade) {
          const headerEnd = rxBuf.indexOf("\r\n\r\n");
          if (headerEnd !== -1) {
            const headerStr = rxBuf.subarray(0, headerEnd).toString("utf8");
            if (headerStr.includes("101 Switching Protocols")) {
              sawUpgrade = true;
              upgradedAt = Date.now();
              assert.strictEqual(pingBridge._wsServerClients.size, 1);
              rxBuf = rxBuf.subarray(headerEnd + 4);
            }
          }
        }
        if (sawUpgrade) {
          // Scan server frames; deliberately ignore 0x89 ping frames without replying pong
          while (rxBuf.length >= 2) {
            const opcode = rxBuf[0] & 0x0f;
            let len = rxBuf[1] & 0x7f;
            let offset = 2;
            if (len === 126) {
              if (rxBuf.length < 4) break;
              len = rxBuf.readUInt16BE(2);
              offset = 4;
            } else if (len === 127) {
              if (rxBuf.length < 10) break;
              len = Number(rxBuf.readBigUInt64BE(2));
              offset = 10;
            }
            if (rxBuf.length < offset + len) break;
            if (opcode === 0x9) sawPingFrame = true;
            rxBuf = rxBuf.subarray(offset + len);
          }
        }
      });
      rawTcpClient.on("error", () => {});
      rawTcpClient.on("close", () => {
        clearTimeout(safetyTimer);
        resolve(upgradedAt > 0 ? Date.now() - upgradedAt : 9999);
      });
    });

    assert.strictEqual(sawUpgrade, true);
    assert.strictEqual(sawPingFrame, true);
    assert.ok(
      closedElapsedMs >= 90 && closedElapsedMs < 500,
      `Expected unresponsive WS client closed around ~130-250ms, got ${closedElapsedMs}ms`
    );
    assert.strictEqual(pingBridge._wsServerClients.size, 0);
  } finally {
    if (rawTcpClient && !rawTcpClient.destroyed) rawTcpClient.destroy();
    await pingBridge.stopServers();
  }

  // 21c. Port bind conflict (EADDRINUSE): startServers() resolves cleanly, records listenErrors & exposes in get_status
  const blocker = net.createServer();
  let conflictBridge = null;
  try {
    await new Promise((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const occupiedPort = blocker.address().port;

    conflictBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      online: true,
      config: {
        httpServers: [{ host: "127.0.0.1", port: occupiedPort, accessToken: "" }],
        wsServers: [{ host: "127.0.0.1", port: occupiedPort, accessToken: "" }],
        wsClients: [],
        heartbeatIntervalMs: 0,
        wsPingIntervalMs: 0,
        quietLogs: true,
      },
    });

    await conflictBridge.startServers();
    assert.strictEqual(conflictBridge.listenErrors.length, 2);
    assert.ok(
      conflictBridge.listenErrors.every(
        (e) => e.code === "EADDRINUSE" && e.host === "127.0.0.1" && e.port === occupiedPort
      )
    );

    const stOnline = await conflictBridge.handleOneBotAction("get_status", {});
    assert.strictEqual(stOnline.status, "ok");
    assert.strictEqual(stOnline.data.online, true);
    assert.strictEqual(stOnline.data.good, true);
    assert.deepStrictEqual(stOnline.data.bridge.listenErrors, conflictBridge.listenErrors);

    conflictBridge.online = false;
    const stOffline = await conflictBridge.handleOneBotAction("get_status", {});
    assert.strictEqual(stOffline.data.online, false);
    assert.strictEqual(stOffline.data.good, false);
    assert.strictEqual(stOffline.data.bridge.listenErrors.length, 2);
  } finally {
    if (conflictBridge) await conflictBridge.stopServers();
    await new Promise((resolve) => blocker.close(() => resolve()));
  }
});
