"use strict";

const http = require("http");
const crypto = require("crypto");

const { formatMetaEvent } = require("../bridge_onebot");

const {
  WS_GUID,
  Rfc6455Connection,
  connectReverseWebSocket,
} = require("./ws_rfc6455");

const {
  DEFAULT_MAX_HTTP_BODY_BYTES,
  DEFAULT_MAX_WS_PAYLOAD_BYTES,
  sanitizeHeaderValue,
  checkRequestAuth,
  checkOriginHeader,
  enforceProtectedModeOnServers,
  readHttpJsonBody,
} = require("./transport_security");

const serverRuntimeMixin = {
  _checkAuth(req, expectedToken, parsedUrl = null) {
    return checkRequestAuth(req, expectedToken, {
      allowQueryToken: this.config.allowQueryAccessToken !== false,
      parsedUrl,
    });
  },

  async startServers() {
    enforceProtectedModeOnServers(
      [...(this.config.httpServers || []), ...(this.config.wsServers || [])],
      this.config,
      (msg) => {
        try {
          process.stderr.write("[rosmontis] SECURITY WARNING: " + msg + "\n");
        } catch (_) {}
      }
    );

    // 1. Start HTTP Server(s)
    for (const httpCfg of this.config.httpServers || []) {
      const endpointMsgFormat = httpCfg.messageFormat || this.config.messageFormat || "array";
      await new Promise((resolve) => {
        const srv = http.createServer(async (req, res) => {
          req.on("error", () => {});
          res.on("error", () => {});

          const originRes = checkOriginHeader(req, {
            allowedOrigins: httpCfg.allowedOrigins || this.config.allowedOrigins || [],
          });
          if (!originRes.allowed) {
            res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
            res.end(
              JSON.stringify({
                status: "failed",
                retcode: 1403,
                message: "Forbidden: Origin not allowed",
              })
            );
            return;
          }

          let u;
          try {
            u = new URL(req.url || "/", "http://127.0.0.1");
          } catch (_) {
            u = new URL("/", "http://127.0.0.1");
          }

          if (!this._checkAuth(req, httpCfg.accessToken, u)) {
            res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ status: "failed", retcode: 1403, message: "Unauthorized" }));
            return;
          }

          const actionName = u.pathname.replace(/^\/+/, "");
          if (req.method === "GET" && (actionName === "health" || actionName === "")) {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(
              JSON.stringify({
                status: "ok",
                retcode: 0,
                self_id: Number(this.selfUin || 0),
                online: this.online,
              })
            );
            return;
          }

          try {
            const params = await readHttpJsonBody(req, {
              maxBodyBytes: this.config.maxHttpBodyBytes || DEFAULT_MAX_HTTP_BODY_BYTES,
            });
            for (const [k, v] of u.searchParams.entries()) {
              if (!(k in params)) params[k] = v;
            }
            const act = actionName || String(params.action || "");
            const actParams =
              params.params !== undefined
                ? params.params && typeof params.params === "object" && !Array.isArray(params.params)
                  ? params.params
                  : {}
                : params;
            const reply = await this.handleOneBotAction(act, actParams, params.echo, {
              messageFormat: endpointMsgFormat,
              compatProfile: httpCfg.compatProfile || httpCfg.compat_profile,
              compatAppName: httpCfg.compatAppName || httpCfg.compat_app_name,
              compatAppVersion: httpCfg.compatAppVersion || httpCfg.compat_app_version,
            });
            if (!res.writableEnded) {
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify(reply));
            }
          } catch (err) {
            if (!res.writableEnded) {
              if (err && (err.statusCode === 413 || err.code === "ERR_HTTP_BODY_TOO_LARGE")) {
                res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
                res.end(
                  JSON.stringify({
                    status: "failed",
                    retcode: 1413,
                    message: err.message,
                  })
                );
                return;
              }
              const msg = err && err.message ? err.message : String(err);
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
              res.end(
                JSON.stringify({
                  status: "failed",
                  retcode: 1400,
                  data: null,
                  message: msg,
                  wording: msg,
                })
              );
            }
          }
        });
        srv.on("error", () => resolve());
        srv.listen(Number(httpCfg.port ?? 3000), httpCfg.host || "0.0.0.0", () => {
          this._httpServers.push(srv);
          resolve();
        });
      });
    }

    // 2. Start Forward WebSocket Server(s)
    for (const wsCfg of this.config.wsServers || []) {
      const endpointMsgFormat = wsCfg.messageFormat || this.config.messageFormat || "array";
      await new Promise((resolve) => {
        const srv = http.createServer((_req, res) => {
          res.writeHead(426);
          res.end("Upgrade Required");
        });
        srv.on("upgrade", (req, socket, head) => {
          socket.on("error", () => {});

          const originRes = checkOriginHeader(req, {
            allowedOrigins: wsCfg.allowedOrigins || this.config.allowedOrigins || [],
          });
          if (!originRes.allowed) {
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }

          let u = null;
          try {
            u = new URL(req.url || "/", "http://127.0.0.1");
          } catch (_) {}

          if (!this._checkAuth(req, wsCfg.accessToken, u)) {
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          const rawSecKey = req.headers["sec-websocket-key"];
          const secKey = sanitizeHeaderValue(rawSecKey);
          if (!secKey) {
            socket.destroy();
            return;
          }
          const accept = sanitizeHeaderValue(
            crypto
              .createHash("sha1")
              .update(secKey + WS_GUID)
              .digest("base64")
          );
          socket.write(
            [
              "HTTP/1.1 101 Switching Protocols",
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Accept: ${accept}`,
              "",
              "",
            ].join("\r\n")
          );
          const conn = new Rfc6455Connection(socket, {
            isClient: false,
            maxPayloadBytes: this.config.maxWsPayloadBytes || DEFAULT_MAX_WS_PAYLOAD_BYTES,
            allowUnmaskedClientFrames: Boolean(this.config.allowUnmaskedClientFrames),
          });
          conn.reportSelfMessage = Boolean(wsCfg.reportSelfMessage);
          conn._messageFormat = endpointMsgFormat;
          this._wsServerClients.add(conn);

          conn.on("error", () => {
            this._wsServerClients.delete(conn);
            try {
              socket.destroy();
            } catch (_) {}
          });
          conn.on("close", () => {
            this._wsServerClients.delete(conn);
          });

          conn.sendJson(
            formatMetaEvent("lifecycle", { sub_type: "connect" }, { selfId: this.selfUin })
          );

          conn.on("message", async (text) => {
            try {
              const payload = JSON.parse(text);
              if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.action) {
                const actParams =
                  payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
                    ? payload.params
                    : {};
                const reply = await this.handleOneBotAction(
                  payload.action,
                  actParams,
                  payload.echo,
                  {
                    messageFormat: conn._messageFormat || "array",
                    compatProfile: wsCfg.compatProfile || wsCfg.compat_profile,
                    compatAppName: wsCfg.compatAppName || wsCfg.compat_app_name,
                    compatAppVersion: wsCfg.compatAppVersion || wsCfg.compat_app_version,
                  }
                );
                conn.sendJson(reply);
              }
            } catch (_) {}
          });
          if (head && head.length > 0) {
            conn._onData(head);
          }
        });
        srv.on("error", () => resolve());
        srv.listen(Number(wsCfg.port ?? 3001), wsCfg.host || "0.0.0.0", () => {
          this._wsServers.push(srv);
          resolve();
        });
      });
    }

    // 3. Start Reverse WebSocket Client(s)
    for (const clientCfg of this.config.wsClients || []) {
      if (!clientCfg.url) continue;
      this._startReverseWsLoop(clientCfg);
    }

    // 4. Start Heartbeat Timer
    if (!this._heartbeatTimer && this.config.heartbeatIntervalMs > 0) {
      this._heartbeatTimer = setInterval(() => {
        this.broadcastOneBotEvent(
          formatMetaEvent(
            "heartbeat",
            {
              status: {
                online: this.online,
                good: this.online,
                time: Math.max(
                  0,
                  Math.floor((Date.now() - (this.startedAtMs || Date.now())) / 1000)
                ),
              },
              interval: this.config.heartbeatIntervalMs,
            },
            { selfId: this.selfUin }
          )
        );
      }, this.config.heartbeatIntervalMs);
      if (typeof this._heartbeatTimer.unref === "function") {
        this._heartbeatTimer.unref();
      }
    }
  },

  _startReverseWsLoop(clientCfg) {
    const endpointMsgFormat = clientCfg.messageFormat || this.config.messageFormat || "array";
    const entry = {
      cfg: clientCfg,
      conn: null,
      connecting: false,
      stopped: false,
      timer: null,
      handle: null,
      connectedSelfId: "0",
      immediateReconnectOnce: false,
      messageFormat: endpointMsgFormat,
    };
    this._reverseWsClients.push(entry);

    const connectOnce = () => {
      if (entry.stopped || entry.connecting || (entry.conn && !entry.conn.closed)) return;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      entry.connecting = true;
      const currentSelfId = sanitizeHeaderValue(String(this.selfUin || "0"));
      const headers = {
        "X-Self-ID": currentSelfId,
        "X-Client-Role": sanitizeHeaderValue(clientCfg.role || "Universal"),
        "User-Agent": "OneBot/11 Rosmontis/1.0.0",
      };
      if (clientCfg.accessToken) {
        headers["Authorization"] = `Bearer ${sanitizeHeaderValue(clientCfg.accessToken)}`;
      }
      entry.handle = connectReverseWebSocket(
        clientCfg.url,
        headers,
        (conn) => {
          entry.connecting = false;
          entry.conn = conn;
          entry.connectedSelfId = currentSelfId;
          conn._messageFormat = entry.messageFormat;
          conn.sendJson(
            formatMetaEvent("lifecycle", { sub_type: "connect" }, { selfId: this.selfUin })
          );
        },
        async (text, conn) => {
          try {
            const payload = JSON.parse(text);
            if (payload && typeof payload === "object" && !Array.isArray(payload) && payload.action) {
              const actParams =
                payload.params && typeof payload.params === "object" && !Array.isArray(payload.params)
                  ? payload.params
                  : {};
              const reply = await this.handleOneBotAction(
                payload.action,
                actParams,
                payload.echo,
                {
                  messageFormat: entry.messageFormat || "array",
                  compatProfile: clientCfg.compatProfile || clientCfg.compat_profile,
                  compatAppName: clientCfg.compatAppName || clientCfg.compat_app_name,
                  compatAppVersion: clientCfg.compatAppVersion || clientCfg.compat_app_version,
                }
              );
              conn.sendJson(reply);
            }
          } catch (_) {}
        },
        () => {
          entry.connecting = false;
          entry.conn = null;
          if (!entry.stopped) {
            if (entry.timer) {
              clearTimeout(entry.timer);
              entry.timer = null;
            }
            const fastReconnect = Boolean(entry.immediateReconnectOnce);
            entry.immediateReconnectOnce = false;
            const delay = fastReconnect
              ? 50
              : Math.max(500, Number(clientCfg.reconnectIntervalMs || 5000));
            entry.timer = setTimeout(connectOnce, delay);
            if (typeof entry.timer.unref === "function") entry.timer.unref();
          }
        },
        {
          maxPayloadBytes: this.config.maxWsPayloadBytes || DEFAULT_MAX_WS_PAYLOAD_BYTES,
        }
      );
    };

    connectOnce();
  },

  async stopServers() {
    this._aioInteractionSeq += 1;
    this._clearIdleTimers();
    this._sessionScheduler.dispose();
    this._rejectPendingRendererCmds(null, "bridge servers stopped");
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    for (const rev of this._reverseWsClients) {
      rev.stopped = true;
      if (rev.timer) clearTimeout(rev.timer);
      if (rev.conn) rev.conn.close();
      if (rev.handle) rev.handle.close();
    }
    this._reverseWsClients = [];
    this._wsClientHandles = this._reverseWsClients;
    for (const client of this._wsServerClients) {
      client.close();
    }
    this._wsServerClients.clear();
    for (const srv of [...this._httpServers, ...this._wsServers]) {
      await new Promise((resolve) => srv.close(() => resolve()));
    }
    this._httpServers = [];
    this._wsServers = [];
    this.flushTempCleanup();
  },
};

module.exports = {
  serverRuntimeMixin,
};
