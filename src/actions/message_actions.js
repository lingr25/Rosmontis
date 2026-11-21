// @ts-check
"use strict";

const bridgeOneBot = require("../bridge_onebot");
const {
  segmentsToCqCode,
  parseCqCodeToSegments,
  normalizeOneBotMessage,
  ntMsgToOneBotSegments,
  formatNtMsgToOneBotEvent,
  stripTransientNtMedia,
} = bridgeOneBot;

const { resolveCompatVersionInfo } = require("../core/config");
const { createActionRouter, createEventWaiter } = require("../core/primitives");
const { probeRuntimeCapabilities } = require("../core/capability_probe");
const { extractQrCodeBase64 } = require("../core/login_recovery");

const MAX_FORWARD_DEPTH = 3;
const MAX_OVERFLOW_SUMMARY_LINES = 20;
const MAX_OVERFLOW_SUMMARY_CHARS = 1500;

/**
 * @param {any} node
 * @param {import("../types").BridgeHost} bridge
 * @param {string} defaultSource
 * @param {string} selfNick
 */
function extractNodeMeta(node, bridge, defaultSource, selfNick) {
  const nd = node;
  const d = nd.data && typeof nd.data === "object" && !Array.isArray(nd.data) ? nd.data : nd;
  const customName = String(
    d.name ||
      d.nickname ||
      nd.sender?.card ||
      nd.sender?.nickname ||
      d.sender?.card ||
      d.sender?.nickname ||
      ""
  ).trim();
  const customUin = String(
    d.uin || d.user_id || nd.sender?.user_id || d.sender?.user_id || bridge.selfUin || "0"
  );
  const nodeShowName = String(
    customName || defaultSource || selfNick || customUin || bridge.selfNickname || "QQBot"
  );
  return { d, customName, nodeShowName };
}

function summarizeNodeContent(content) {
  let rawText = "";
  if (typeof content === "string") {
    rawText = content;
  } else if (Array.isArray(content) || (content && typeof content === "object")) {
    const items = Array.isArray(content) ? content : [content];
    rawText = items
      .map((seg) => {
        if (typeof seg === "string") return seg;
        if (!seg || typeof seg !== "object") return "";
        const t = String(seg.type || "").trim().toLowerCase();
        if (t === "text") return String(seg.data?.text ?? seg.text ?? "");
        if (t === "node") return "[转发消息]";
        if (t === "image" || t === "mface") return "[图片]";
        if (t === "record") return "[语音]";
        if (t === "video") return "[视频]";
        if (t === "file") {
          const fname = seg.data?.name || seg.name || "";
          return fname ? `[文件: ${fname}]` : "[文件]";
        }
        if (t === "at") return `@${seg.data?.name || seg.data?.qq || ""}`;
        if (t === "face") return "[表情]";
        if (t === "json" || t === "xml") return "[卡片消息]";
        return t ? `[${t}]` : "";
      })
      .join("");
  } else if (content !== undefined && content !== null) {
    rawText = String(content);
  }
  const singleLine = rawText.replace(/\s+/g, " ").trim();
  if (!singleLine) return "[消息]";
  return singleLine.length > 120 ? `${singleLine.slice(0, 117)}...` : singleLine;
}

function buildOverflowSummaryText(overflowEntries) {
  const total = overflowEntries.length;
  if (total === 0) return "";
  const lines = [];
  let charCount = 0;
  let included = 0;
  const maxLines = Math.min(total, MAX_OVERFLOW_SUMMARY_LINES);

  for (let idx = 0; idx < maxLines; idx += 1) {
    const { name, brief } = overflowEntries[idx];
    const line = `${name}: ${brief}`;
    const willHaveOmitted = idx + 1 < total;
    const reserve = willHaveOmitted ? 36 : 0;
    const sep = lines.length > 0 ? 1 : 0;
    if (lines.length === 0 && line.length + reserve > MAX_OVERFLOW_SUMMARY_CHARS) {
      const budget = Math.max(10, MAX_OVERFLOW_SUMMARY_CHARS - reserve - 3);
      lines.push(`${line.slice(0, budget)}...`);
      charCount = lines[0].length;
      included = 1;
      break;
    }
    if (charCount + sep + line.length + reserve > MAX_OVERFLOW_SUMMARY_CHARS) {
      break;
    }
    lines.push(line);
    charCount += sep + line.length;
    included += 1;
  }

  const omitted = total - included;
  if (omitted > 0) {
    lines.push(`... (共省略 ${omitted} 条节点)`);
  }
  const joined = lines.join("\n");
  return joined.length > MAX_OVERFLOW_SUMMARY_CHARS
    ? joined.slice(0, MAX_OVERFLOW_SUMMARY_CHARS)
    : joined;
}

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {any} rawMsgId
 */
function resolveMessageEntry(bridge, rawMsgId) {
  const store = bridge?.messageIdStore;
  if (!store || rawMsgId === undefined || rawMsgId === null || rawMsgId === "") {
    return null;
  }
  if (typeof store.resolve === "function") {
    const resolved = store.resolve(rawMsgId);
    return resolved ? resolved.entry || resolved : store.resolveByOneBotId?.(rawMsgId) || null;
  }
  return (
    store.resolveByOneBotId?.(rawMsgId) ||
    store.getByShortId?.(rawMsgId) ||
    store.getByMsgId?.(rawMsgId) ||
    null
  );
}

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {any[]} rawNodes
 * @param {any} fallbackPeer
 * @param {() => Promise<any>} getSelfPeer
 * @param {string} [defaultSource=""]
 * @param {number} [depth=1]
 * @param {{ customCount: number, overflowSent: boolean }} [state]
 */
async function stageForwardNodes(
  bridge,
  rawNodes,
  fallbackPeer,
  getSelfPeer,
  defaultSource = "",
  depth = 1,
  state = { customCount: 0, overflowSent: false }
) {
  const nodes = Array.isArray(rawNodes) ? rawNodes : [];
  const msgInfos = [];
  let stagedCustomCount = 0;
  /** @type {{ chatType: number, peerUid: string, guildId: string } | null} */
  let firstRefPeer = null;
  const selfNick =
    bridge.selfNickname && bridge.selfNickname !== "QQBot" ? bridge.selfNickname : "";

  const rawCap = Number(bridge.config?.maxForwardCustomNodes);
  const maxCustomNodes = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : 40;
  const rawDelay = Number(bridge.config?.forwardStageDelayMs || 0);
  const stageDelayMs = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 0;

  const sendStagedCustom = async (selfPeer, payload) => {
    state.customCount += 1;
    if (stageDelayMs > 0 && state.customCount > 1) {
      await new Promise((resolve) => setTimeout(resolve, stageDelayMs));
    }
    return await bridge.outboundPipeline._sendMessageToPeer(
      selfPeer,
      payload,
      false,
      undefined,
      { skipHumanSimulation: true }
    );
  };

  const stageOverflowFromEntries = async (selfPeer, overflowEntries) => {
    if (state.overflowSent || overflowEntries.length === 0) return;
    state.overflowSent = true;
    const summaryText = buildOverflowSummaryText(overflowEntries);
    if (!summaryText) return;
    stagedCustomCount += 1;
    const summarySenderName =
      overflowEntries.length === 1
        ? overflowEntries[0].name
        : String(
            defaultSource || selfNick || bridge.selfNickname || overflowEntries[0].name || "QQBot"
          );
    const subSent = await sendStagedCustom(selfPeer, summaryText);
    if (subSent?.real_id) {
      msgInfos.push({ msgId: String(subSent.real_id), senderShowName: summarySenderName });
    }
  };

  const collectRemainingCustomEntries = (startIdx) => {
    const entries = [];
    for (let j = startIdx; j < nodes.length; j += 1) {
      const remNode = nodes[j];
      if (!remNode || typeof remNode !== "object") continue;
      const { d: remD, nodeShowName: remName } = extractNodeMeta(
        remNode,
        bridge,
        defaultSource,
        selfNick
      );
      if (remD.id !== undefined && remD.id !== null && String(remD.id) !== "") continue;
      const remContent = remD.content !== undefined ? remD.content : remD.message;
      if (remContent === undefined) continue;
      entries.push({ name: remName, brief: summarizeNodeContent(remContent) });
    }
    return entries;
  };

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!node || typeof node !== "object") continue;
    const { d, customName, nodeShowName } = extractNodeMeta(
      node,
      bridge,
      defaultSource,
      selfNick
    );

    if (d.id !== undefined && d.id !== null && String(d.id) !== "") {
      const ref = resolveMessageEntry(bridge, d.id);
      if (ref) {
        const refMsgId = String(ref.msgId || ref.ntMsgId || "");
        const refPeerUid = String(ref.peer?.peerUid || ref.peerUid || "");
        const refChatType = Number(ref.peer?.chatType || ref.chatType || 1);
        if (!firstRefPeer && refPeerUid) {
          firstRefPeer = {
            chatType: refChatType,
            peerUid: refPeerUid,
            guildId: String(ref.peer?.guildId || ""),
          };
        }
        const refSenderName =
          customName ||
          String(
            ref.oneBotEvent?.sender?.card || ref.oneBotEvent?.sender?.nickname || ""
          ).trim() ||
          nodeShowName;
        if (refMsgId) {
          msgInfos.push({ msgId: refMsgId, senderShowName: refSenderName });
        }
      }
      continue;
    }

    const content = d.content !== undefined ? d.content : d.message;
    if (content === undefined) continue;

    if (state.customCount >= maxCustomNodes) {
      if (!state.overflowSent) {
        const selfPeer = await getSelfPeer();
        const overflowEntries = collectRemainingCustomEntries(i);
        await stageOverflowFromEntries(selfPeer, overflowEntries);
      }
      continue;
    }

    stagedCustomCount += 1;
    const selfPeer = await getSelfPeer();
    const rawItems = Array.isArray(content)
      ? content
      : content &&
        typeof content === "object" &&
        String(content.type || "").trim().toLowerCase() === "node"
      ? [content]
      : null;
    const hasNestedNodes = Boolean(
      rawItems &&
        rawItems.some(
          (it) => it && typeof it === "object" && String(it.type || "").trim().toLowerCase() === "node"
        )
    );

    if (!hasNestedNodes || !rawItems) {
      const subSent = await sendStagedCustom(selfPeer, content);
      if (subSent?.real_id) {
        msgInfos.push({ msgId: String(subSent.real_id), senderShowName: nodeShowName });
      }
    } else if (depth >= MAX_FORWARD_DEPTH) {
      const flattened = rawItems.map((it) =>
        it && typeof it === "object" && String(it.type || "").trim().toLowerCase() === "node"
          ? { type: "text", data: { text: "[转发消息]" } }
          : it
      );
      const subSent = await sendStagedCustom(selfPeer, flattened);
      if (subSent?.real_id) {
        msgInfos.push({ msgId: String(subSent.real_id), senderShowName: nodeShowName });
      }
    } else {
      let idx = 0;
      while (idx < rawItems.length) {
        const cur = rawItems[idx];
        const isNode =
          cur && typeof cur === "object" && String(cur.type || "").trim().toLowerCase() === "node";
        if (isNode) {
          const innerNodes = [];
          while (
            idx < rawItems.length &&
            rawItems[idx] &&
            typeof rawItems[idx] === "object" &&
            String(rawItems[idx].type || "").trim().toLowerCase() === "node"
          ) {
            innerNodes.push(rawItems[idx]);
            idx += 1;
          }
          const inner = await stageForwardNodes(
            bridge,
            innerNodes,
            selfPeer,
            getSelfPeer,
            "",
            depth + 1,
            state
          );
          if (inner.msgInfos.length > 0) {
            const innerFwd = await bridge.outboundPipeline._invokeForwardWithEcho(selfPeer, () =>
              bridge.invokeNt(
                "nodeIKernelMsgService/multiForwardMsgWithComment",
                {
                  msgInfos: inner.msgInfos,
                  srcContact: inner.srcContact,
                  dstContact: selfPeer,
                  commentElements: [],
                  msgAttributeInfos: new Map(),
                },
                [inner.msgInfos, inner.srcContact, selfPeer, [], new Map()]
              )
            );
            if (innerFwd?.real_id) {
              msgInfos.push({ msgId: String(innerFwd.real_id), senderShowName: nodeShowName });
            }
          }
        } else {
          const segRun = [];
          while (
            idx < rawItems.length &&
            !(
              rawItems[idx] &&
              typeof rawItems[idx] === "object" &&
              String(rawItems[idx].type || "").trim().toLowerCase() === "node"
            )
          ) {
            const seg = rawItems[idx];
            if (
              !(
                seg &&
                String(seg.type || "").toLowerCase() === "text" &&
                (seg.data?.text ?? seg.text) === ""
              )
            ) {
              segRun.push(seg);
            }
            idx += 1;
          }
          if (segRun.length > 0) {
            if (state.customCount >= maxCustomNodes) {
              if (!state.overflowSent) {
                const restInNode = rawItems.slice(idx);
                const overflowEntries = [
                  {
                    name: nodeShowName,
                    brief: summarizeNodeContent(
                      restInNode.length > 0 ? [...segRun, ...restInNode] : segRun
                    ),
                  },
                  ...collectRemainingCustomEntries(i + 1),
                ];
                await stageOverflowFromEntries(selfPeer, overflowEntries);
              }
            } else {
              const subSent = await sendStagedCustom(selfPeer, segRun);
              if (subSent?.real_id) {
                msgInfos.push({ msgId: String(subSent.real_id), senderShowName: nodeShowName });
              }
            }
          }
        }
      }
    }
  }

  let srcContact = fallbackPeer;
  if (stagedCustomCount > 0) {
    srcContact = await getSelfPeer();
  } else if (firstRefPeer) {
    srcContact = firstRefPeer;
  }

  return { msgInfos, srcContact, stagedCustomCount, firstRefPeer };
}

function extractExclusiveForwardNodes(message, autoEscape = false) {
  if (autoEscape && typeof message === "string") return null;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    return String(message.type || "").toLowerCase() === "node" ? [message] : null;
  }
  if (!Array.isArray(message) || message.length === 0) return null;
  const nodes = [];
  for (const item of message) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const t = String(item.type || "").trim().toLowerCase();
    if (!t) return null;
    if (t === "text" && (item.data?.text ?? item.text) === "") continue;
    if (t !== "node") return null;
    nodes.push(item);
  }
  return nodes.length > 0 ? nodes : null;
}

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {Record<string, any>} p
 * @param {boolean} isGroup
 */
async function forwardSingleMsg(bridge, p, isGroup) {
  const entry = resolveMessageEntry(bridge, p.message_id);
  if (!entry) throw new Error("message not found");
  const dstContact = isGroup
    ? { chatType: 2, peerUid: String(p.group_id), guildId: "" }
    : await bridge.outboundPipeline._resolvePeerForUser(p.user_id);
  const srcContact =
    entry.peer ||
    (entry.peerUid
      ? {
          chatType: Number(entry.chatType || 1),
          peerUid: String(entry.peerUid),
          guildId: "",
        }
      : dstContact);
  const srcMsgId = String(entry.msgId || entry.ntMsgId || "");
  const sent = await bridge.outboundPipeline._invokeForwardWithEcho(
    dstContact,
    () =>
      bridge.invokeNt(
        "nodeIKernelMsgService/forwardMsgWithComment",
        {
          msgIds: [srcMsgId],
          srcContact,
          dstContacts: [dstContact],
          commentElements: [],
          msgAttributeInfos: new Map(),
        },
        [[srcMsgId], srcContact, [dstContact], [], new Map()]
      ),
    srcMsgId
  );
  return { message_id: sent.message_id, real_id: sent.real_id };
}

/**
 * @param {import("../types").BridgeHost} bridge
 * @param {Record<string, any>} p
 * @param {import("../types").ActionContext} context
 * @param {boolean} isGroup
 */
async function getMessageHistory(bridge, p, context, isGroup) {
  const peer = isGroup
    ? { chatType: 2, peerUid: String(p.group_id), guildId: "" }
    : await bridge.outboundPipeline._resolvePeerForUser(p.user_id);
  const count = Math.max(1, Math.min(Number(p.count || 20), 100));
  let startMsgId = "0";
  if (p.message_id && Number(p.message_id) > 0) {
    const ref = resolveMessageEntry(bridge, p.message_id);
    const refMsgId = ref?.msgId || ref?.ntMsgId;
    if (refMsgId && /^\d+$/.test(String(refMsgId))) {
      startMsgId = String(refMsgId);
    }
  }
  const queryOrder = startMsgId === "0";
  const tryMainDirect = bridge.config?.preferMainProcessForBulkReads === true;
  const fetchHistory = async (order, preferMain) => {
    const r = await bridge.invokeNt(
      "nodeIKernelMsgService/getMsgsIncludeSelf",
      {
        peer,
        msgId: startMsgId,
        cnt: count,
        queryOrder: order,
      },
      [peer, startMsgId, count, order],
      { preferMainProcess: Boolean(preferMain) }
    );
    return Array.isArray(r?.msgList) ? r.msgList : [];
  };
  let rawList = await fetchHistory(queryOrder, tryMainDirect);
  if (rawList.length === 0 && queryOrder) {
    rawList = await fetchHistory(false, tryMainDirect);
  }
  // If opt-in main-process direct read returned empty (e.g. QQ 3.2.35 Tier 2 silent []),
  // transparently fall back to Tier 1 renderer IPC.
  if (rawList.length === 0 && tryMainDirect) {
    rawList = await fetchHistory(queryOrder, false);
    if (rawList.length === 0 && queryOrder) {
      rawList = await fetchHistory(false, false);
    }
  }
  const reqMsgFormat =
    context?.messageFormat || p?.message_format || bridge.config.messageFormat || "array";
  const messages = [];
  for (const m of rawList) {
    try {
      await bridge.inboundPipeline._hydrateNtMsgMedia(m, {
        skipRemoteDownload: true,
        chatType: peer.chatType,
        peerUid: peer.peerUid,
      });
      const ev = formatNtMsgToOneBotEvent(m, {
        selfId: bridge.selfUin,
        uinUidStore: bridge.uinUidStore,
        messageIdStore: bridge.messageIdStore,
        reportSelfMessage: true,
        messageFormat: reqMsgFormat,
      });
      if (ev) messages.push(bridge._formatEventForEndpoint(ev, reqMsgFormat));
    } finally {
      stripTransientNtMedia(m);
    }
  }
  return { messages };
}

// ============================================================================
// Declarative Action Handlers & Aliases
// ============================================================================

/** @type {Record<string, import("../types").BridgeActionHandler>} */
const ACTION_HANDLERS = {
  // ---- 1. Info & Status ----
  async get_login_info() {
    if (!this.selfUin || !this.selfUid || !this.selfNickname || this.selfNickname === "QQBot") {
      try {
        const loginRes = await this.invokeNt("nodeIKernelLoginService/getLoginList", {}, []);
        const list = Array.isArray(loginRes?.LocalLoginInfoList)
          ? loginRes.LocalLoginInfoList
          : [];
        const activeAcc =
          list.find((item) => item && this.selfUin && String(item.uin) === String(this.selfUin)) ||
          list.find((item) => item && (item.isQuickLogin || item.isAutoLogin) && item.uin) ||
          list.find((item) => item && item.uin) ||
          null;
        if (activeAcc) {
          this.ntCapture._updateSelfIdentity({
            uin: this.selfUin || activeAcc.uin,
            uid: this.selfUid || activeAcc.uid,
            nick:
              this.selfNickname && this.selfNickname !== "QQBot"
                ? this.selfNickname
                : activeAcc.nickName || activeAcc.nick,
            markOnline: false,
          });
        }
      } catch (err) {
        this.logger?.debug?.("message_actions", err);
      }
    }
    return {
      user_id: Number(this.selfUin || 0),
      nickname: String(this.selfNickname || "QQBot"),
    };
  },

  get_status() {
    return {
      online: Boolean(this.online),
      good: Boolean(this.online),
      time: Math.max(
        0,
        Math.floor((Date.now() - (this.startedAtMs || Date.now())) / 1000)
      ),
      bridge: {
        invoke: { ...this.invokeStats },
        send_echo: { ...this.sendEchoStats },
        map_hook_active:
          Boolean(this.ntCapture._mapSetHook) && Map.prototype.set === this.ntCapture._mapSetHook,
        map_hook_release: this.mapHookRelease || null,
        listenErrors: Array.isArray(this.listenErrors) ? this.listenErrors : [],
        capabilities: probeRuntimeCapabilities(this),
        renderer_health: this.rendererHealthStats ? { ...this.rendererHealthStats } : null,
        rate_limit:
          typeof this.rateLimiter?.getStats === "function"
            ? this.rateLimiter.getStats()
            : null,
      },
    };
  },

  async quick_login(p) {
    return await this.inboundPipeline._tryAutoQuickLogin({
      uin: p.user_id || p.uin || "",
      force: p.force !== undefined ? Boolean(p.force) : true,
    });
  },

  async get_login_list() {
    const loginRes = await this.invokeNt("nodeIKernelLoginService/getLoginList", {}, []);
    return Array.isArray(loginRes?.LocalLoginInfoList) ? loginRes.LocalLoginInfoList : [];
  },

  async get_login_qrcode(p) {
    let freshQr = "";
    if (Boolean(p.clear_stale)) {
      this.lastQrCodeBase64 = "";
    }
    if (Boolean(p.refresh) || !this.lastQrCodeBase64) {
      const waitMs =
        p.wait_ms !== undefined && p.wait_ms !== null && Number.isFinite(Number(p.wait_ms))
          ? Math.max(0, Math.min(Number(p.wait_ms), 10000))
          : 2000;
      const rpcTimeoutMs = Math.max(1500, Math.min(waitMs > 0 ? waitMs + 1000 : 3000, 5000));
      const qrWaiter =
        waitMs > 0 && this.inboundPipeline._qrCodeWaiters
          ? createEventWaiter(this.inboundPipeline._qrCodeWaiters, waitMs)
          : null;
      const waitQrPromise = qrWaiter
        ? qrWaiter.promise.then((val) => {
            if (val) {
              freshQr = String(val);
            }
            return val;
          })
        : null;
      try {
        const invokePromise = Promise.resolve()
          .then(() =>
            this.invokeNt("nodeIKernelLoginService/getQRCodePicture", {}, [], {
              timeoutMs: rpcTimeoutMs,
            })
          )
          .then((qrRes) => {
            const extracted = extractQrCodeBase64(qrRes);
            if (extracted) {
              freshQr = extracted;
              this.lastQrCodeBase64 = extracted;
            } else {
              const shape =
                qrRes && typeof qrRes === "object"
                  ? Object.keys(qrRes).slice(0, 16).join(",")
                  : typeof qrRes;
              this.logger?.debug?.(
                "login",
                `getQRCodePicture returned without direct QR (shape=${shape})`
              );
            }
          })
          .catch((err) => {
            this.logger?.debug?.("login", err);
          });
        if (waitQrPromise) {
          await Promise.race([
            invokePromise,
            waitQrPromise.then((val) => {
              if (!val) return invokePromise;
            }),
          ]);
          if (!freshQr) {
            await waitQrPromise;
          }
        } else {
          await invokePromise;
        }
      } finally {
        qrWaiter?.cancel();
      }
    }
    return {
      online: Boolean(this.online),
      qrcode_base64: String(freshQr || this.lastQrCodeBase64 || ""),
      refreshed: Boolean(freshQr),
    };
  },

  get_version_info(_p, context) {
    return resolveCompatVersionInfo(this.config, context);
  },

  can_send_image() {
    const probe = probeRuntimeCapabilities(this);
    if (
      !probe.runtimeDetected ||
      probe.notes?.opaqueNtApiProxy ||
      probe.notes?.sessionInitialized === false
    ) {
      return { yes: true };
    }
    return { yes: Boolean(probe.capabilities.send_image) };
  },

  can_send_record() {
    const probe = probeRuntimeCapabilities(this);
    if (
      !probe.runtimeDetected ||
      probe.notes?.opaqueNtApiProxy ||
      probe.notes?.sessionInitialized === false
    ) {
      return { yes: true };
    }
    return { yes: Boolean(probe.capabilities.send_record) };
  },

  get_capabilities(p) {
    return probeRuntimeCapabilities(this, {
      forceRefresh: Boolean(p?.refresh || p?.force_refresh),
    });
  },

  async reload_config(p) {
    if (typeof this.reloadConfig === "function") {
      return await this.reloadConfig(p);
    }
    /** @type {Error & { retcode?: number }} */
    const err = new Error("reload_config is not supported on this bridge instance");
    err.retcode = 1404;
    throw err;
  },

  clean_cache() {
    this.flushTempCleanup();
    return {};
  },

  // ---- 2. Messaging ----
  async send_private_msg(p, context) {
    const userId = p.user_id;
    if (!userId) throw new Error("user_id is required");
    const fwdNodes = extractExclusiveForwardNodes(p.message, Boolean(p.auto_escape));
    if (fwdNodes) {
      return await this._dispatchAction(
        "send_private_forward_msg",
        { ...p, messages: fwdNodes },
        context
      );
    }
    const peer = await this.outboundPipeline._resolvePeerForUser(userId, p.group_id);
    return await this.outboundPipeline._sendMessageToPeer(peer, p.message, Boolean(p.auto_escape), p.group_id);
  },

  async send_group_msg(p, context) {
    const groupId = p.group_id;
    if (!groupId) throw new Error("group_id is required");
    const fwdNodes = extractExclusiveForwardNodes(p.message, Boolean(p.auto_escape));
    if (fwdNodes) {
      return await this._dispatchAction(
        "send_group_forward_msg",
        { ...p, messages: fwdNodes },
        context
      );
    }
    const peer = { chatType: 2, peerUid: String(groupId), guildId: "" };
    return await this.outboundPipeline._sendMessageToPeer(peer, p.message, Boolean(p.auto_escape), groupId);
  },

  async send_msg(p, context) {
    const isGroup = p.message_type === "group" || (p.group_id && p.message_type !== "private");
    if (isGroup) {
      return await this._dispatchAction("send_group_msg", p, context);
    }
    return await this._dispatchAction("send_private_msg", p, context);
  },

  async delete_msg(p) {
    const entry = resolveMessageEntry(this, p.message_id);
    if (!entry) throw new Error("message not found");
    const msgId = String(entry.msgId || entry.ntMsgId || "");
    await this.invokeNt(
      "nodeIKernelMsgService/recallMsg",
      { peer: entry.peer, msgIds: [msgId] },
      [entry.peer, [msgId]]
    );
    return {};
  },

  async get_msg(p, context) {
    const reqMsgFormat =
      context?.messageFormat || p?.message_format || this.config.messageFormat || "array";
    const formatMsgPayload = (copy) => {
      if (reqMsgFormat === "string") {
        copy.message =
          typeof copy.raw_message === "string" &&
          (copy.raw_message.length > 0 || !Array.isArray(copy.message) || copy.message.length === 0)
            ? copy.raw_message
            : Array.isArray(copy.message)
            ? segmentsToCqCode(copy.message)
            : String(copy.message ?? "");
      } else if (typeof copy.message === "string") {
        copy.message = normalizeOneBotMessage(copy.message);
      }
      return copy;
    };
    const entry = resolveMessageEntry(this, p.message_id);
    let rawMsg = entry?.rawMsg || null;
    const entryMsgId = String(entry?.msgId || entry?.ntMsgId || "");
    const entryPeer =
      entry?.peer ||
      (entry?.peerUid
        ? {
            chatType: Number(entry.chatType || 1),
            peerUid: String(entry.peerUid),
            guildId: "",
          }
        : null);
    if (
      !rawMsg &&
      entry &&
      entryPeer?.peerUid &&
      entryMsgId &&
      !/^(sent_|fwd_|echo_timeout_)/.test(entryMsgId)
    ) {
      try {
        const res = await this.invokeNt(
          "nodeIKernelMsgService/getMsgsByMsgId",
          { peer: entryPeer, msgIds: [entryMsgId] },
          [entryPeer, [entryMsgId]]
        );
        rawMsg = res?.msgList?.[0] || null;
      } catch (_) {
        rawMsg = null;
      }
    }
    if (rawMsg) {
      try {
        await this.inboundPipeline._hydrateNtMsgMedia(rawMsg);
        const refreshed = formatNtMsgToOneBotEvent(rawMsg, {
          selfId: this.selfUin,
          uinUidStore: this.uinUidStore,
          messageIdStore: this.messageIdStore,
          reportSelfMessage: true,
          messageFormat: reqMsgFormat,
        });
        if (refreshed) {
          const copy = formatMsgPayload({ ...refreshed });
          delete copy.post_type;
          delete copy.self_id;
          copy.real_id = rawMsg.msgId || entryMsgId;
          return copy;
        }
      } finally {
        stripTransientNtMedia(rawMsg);
      }
    }
    if (entry && entry.oneBotEvent) {
      const copy = formatMsgPayload({ ...entry.oneBotEvent });
      delete copy.post_type;
      delete copy.self_id;
      copy.real_id = entryMsgId;
      return copy;
    }
    if (entry) {
      const peerChatType = Number(entryPeer?.chatType || entry.chatType || 1);
      const peerUidStr = String(entryPeer?.peerUid || entry.peerUid || "");
      return formatMsgPayload({
        time: Number(entry.msgTime || Math.floor(Date.now() / 1000)),
        message_type: peerChatType === 2 ? "group" : "private",
        message_id: entry.shortId ?? entry.oneBotId,
        real_id: entryMsgId,
        message_seq: Number(entry.msgSeq || 0),
        sender: {
          user_id: Number(entry.senderUin || this.selfUin || 0),
          nickname: this.selfNickname || "",
        },
        message: [],
        raw_message: "",
        font: 14,
        ...(peerChatType === 2 ? { group_id: Number(peerUidStr || entry.groupId || 0) } : {}),
      });
    }
    throw new Error("message not found");
  },

  // ---- 3. Forward Messages & History ----
  async get_forward_msg(p) {
    const resId = String(p.id || p.res_id || p.forward_id || p.message_id || "").trim();
    const explicitMsgId =
      p.message_id !== undefined && p.message_id !== null ? String(p.message_id).trim() : "";
    if (!resId && !explicitMsgId) throw new Error("id is required");

    const fwdHit =
      (resId && typeof this.messageIdStore?.lookupForward === "function"
        ? this.messageIdStore.lookupForward(resId)
        : null) ||
      (explicitMsgId && typeof this.messageIdStore?.lookupForward === "function"
        ? this.messageIdStore.lookupForward(explicitMsgId)
        : null);
    const entry =
      resolveMessageEntry(this, resId) ||
      (explicitMsgId ? resolveMessageEntry(this, explicitMsgId) : null) ||
      (fwdHit?.shortId ? resolveMessageEntry(this, fwdHit.shortId) : null);

    let peer =
      (fwdHit?.peer && fwdHit.peer.peerUid ? fwdHit.peer : null) ||
      (entry?.forwardPeer && entry.forwardPeer.peerUid ? entry.forwardPeer : null) ||
      (entry?.peer && entry.peer.peerUid ? entry.peer : null);
    if (!peer) {
      if (p.group_id) {
        peer = { chatType: 2, peerUid: String(p.group_id), guildId: "" };
      } else if (p.user_id && typeof this.outboundPipeline?._resolvePeerForUser === "function") {
        peer = await this.outboundPipeline._resolvePeerForUser(p.user_id, p.group_id);
      } else {
        peer = { chatType: 2, peerUid: "0", guildId: "" };
      }
    }
    const parentMsgId = String(
      fwdHit?.parentMsgId || entry?.msgId || entry?.ntMsgId || explicitMsgId || resId
    );
    const rootMsgId = String(fwdHit?.rootMsgId || entry?.rootMsgId || parentMsgId);
    const res = await this.invokeNt(
      "nodeIKernelMsgService/getMultiMsg",
      {
        peer,
        rootMsgId,
        parentMsgId,
      },
      [peer, rootMsgId, parentMsgId]
    );
    const msgList = Array.isArray(res?.msgList) ? res.msgList : [];
    const totalHydrationBudgetMs = Math.max(
      200,
      Number(this.config?.forwardMediaHydrationBudgetMs ?? 3500) || 3500
    );
    const hydrationDeadlineMs = Date.now() + totalHydrationBudgetMs;
    const perNodeAttemptMs = Math.min(1200, totalHydrationBudgetMs);
    const messages = [];
    for (const m of msgList) {
      try {
        await this.inboundPipeline._hydrateNtMsgMedia(m, {
          downSourceType: 1,
          timeoutMs: perNodeAttemptMs,
          deadlineMs: hydrationDeadlineMs,
          skipRemoteDownload: Date.now() >= hydrationDeadlineMs,
          chatType: peer.chatType,
          peerUid: peer.peerUid,
        });
        const nodeSenderUid = String(m.senderUid || m.senderUidStr || "").trim();
        let uin = bridgeOneBot.pickPositiveUin(
          m.senderUin,
          nodeSenderUid ? this.uinUidStore?.getUinSync?.(nodeSenderUid) : 0
        );
        if (!uin && nodeSenderUid && typeof this.inboundPipeline?._ensureUinForUid === "function") {
          uin = bridgeOneBot.pickPositiveUin(await this.inboundPipeline._ensureUinForUid(nodeSenderUid));
        }
        const shortId = this.messageIdStore.register(
          m.msgId,
          {
            chatType: Number(m.chatType || peer.chatType || 2),
            peerUid: String(
              m.peerUid && String(m.peerUid) !== "0" ? m.peerUid : peer.peerUid
            ),
            guildId: String(m.guildId || peer.guildId || ""),
          },
          m.msgSeq,
          {
            senderUin: uin,
            senderUid: nodeSenderUid,
            rawMsg: m,
            rootMsgId,
            forwardPeer: peer,
          }
        );
        const { segments, raw_message } = ntMsgToOneBotSegments(m, {
          uinUidStore: this.uinUidStore,
          messageIdStore: this.messageIdStore,
        });
        const nickname = String(m.sendMemberName || m.sendNickName || uin || "群友");
        messages.push({
          type: "node",
          data: {
            user_id: uin,
            nickname,
            sender: { user_id: uin, nickname },
            content: segments,
            message: segments,
            raw_message,
            time: Number(m.msgTime || Math.floor(Date.now() / 1000)),
            message_id: shortId,
          },
        });
      } finally {
        stripTransientNtMedia(m);
      }
    }
    return { messages };
  },

  async send_forward_msg(p, _context, action) {
    const isGroup =
      action === "send_group_forward_msg" ||
      (p.group_id && action !== "send_private_forward_msg");
    const peer = isGroup
      ? { chatType: 2, peerUid: String(p.group_id), guildId: "" }
      : await this.outboundPipeline._resolvePeerForUser(p.user_id, p.group_id);
    const nodes = Array.isArray(p.messages)
      ? p.messages
      : Array.isArray(p.message)
      ? p.message
      : [];

    /** @type {import("../types").NtPeer | null} */
    let cachedSelfPeer = null;
    const getSelfPeer = async () => {
      if (cachedSelfPeer) return cachedSelfPeer;
      let selfUid = this.selfUid || this.uinUidStore.getUidSync(this.selfUin);
      if (!selfUid && this.selfUin) {
        selfUid = await this.uinUidStore.resolveUid(this.selfUin, this.invokeNt.bind(this));
        if (selfUid) this.selfUid = selfUid;
      }
      cachedSelfPeer = selfUid ? { chatType: 1, peerUid: selfUid, guildId: "" } : peer;
      return cachedSelfPeer;
    };

    const { msgInfos, srcContact } = await stageForwardNodes(
      this,
      nodes,
      peer,
      getSelfPeer,
      p.source ? String(p.source) : "",
      1
    );

    if (msgInfos.length > 0) {
      try {
        const sent = await this.outboundPipeline._invokeForwardWithEcho(peer, () =>
          this.invokeNt(
            "nodeIKernelMsgService/multiForwardMsgWithComment",
            {
              msgInfos,
              srcContact,
              dstContact: peer,
              commentElements: [],
              msgAttributeInfos: new Map(),
            },
            [msgInfos, srcContact, peer, [], new Map()]
          )
        );
        return {
          message_id: sent.message_id,
          res_id: sent.real_id,
          forward_id: sent.real_id,
        };
      } catch (_) {
        // Fallback: send combined text ONLY if staging did not already send directly to `peer`
        if (srcContact.peerUid !== peer.peerUid || srcContact.chatType !== peer.chatType) {
          const combined = nodes
            .map((n) => {
              const nd = n?.data || n || {};
              const segs = normalizeOneBotMessage(nd.content || nd.message || "");
              return segs.map((s) => s.data?.text || "").join("");
            })
            .filter(Boolean)
            .join("\n\n");
          if (combined) {
            const fallbackRes = await this.outboundPipeline._sendMessageToPeer(peer, combined);
            const fbRealId = String(fallbackRes.real_id || `fwd_${Date.now()}`);
            return {
              message_id: fallbackRes.message_id,
              res_id: fbRealId,
              forward_id: fbRealId,
            };
          }
        }
      }
    }
    const emptyForwardId = `fwd_${Date.now()}`;
    return {
      message_id: 0,
      res_id: emptyForwardId,
      forward_id: emptyForwardId,
    };
  },

  async forward_friend_single_msg(p) {
    return await forwardSingleMsg(this, p, false);
  },

  async forward_group_single_msg(p) {
    return await forwardSingleMsg(this, p, true);
  },

  async get_group_msg_history(p, context) {
    return await getMessageHistory(this, p, context, true);
  },

  async get_friend_msg_history(p, context) {
    return await getMessageHistory(this, p, context, false);
  },

  // ---- 4. Read, Input Status, Emoji Likes, Profile Likes, Pokes ----
  async mark_msg_as_read(p, _context, action) {
    /** @type {{ chatType: number, peerUid: string, guildId?: string } | null} */
    let peer = null;
    if (p.message_id) {
      const entry = resolveMessageEntry(this, p.message_id);
      if (entry?.peer) peer = entry.peer;
    }
    if (!peer) {
      const isGroupTarget =
        Boolean(p.group_id) ||
        action === "mark_group_msg_as_read" ||
        p.message_type === "group" ||
        String(p.chat_type) === "2";
      if (isGroupTarget && (p.group_id || p.target_id)) {
        peer = { chatType: 2, peerUid: String(p.group_id || p.target_id), guildId: "" };
      } else if (p.user_id || p.target_id) {
        peer = await this.outboundPipeline._resolvePeerForUser(p.user_id || p.target_id);
      }
    }
    if (peer && peer.peerUid) {
      const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId || ""}`;
      this.sessionController.scheduler.cancelPeerReaction(peerKey);
      await this.simulateHumanSession({
        chatType: peer.chatType,
        peerUid: peer.peerUid,
        guildId: peer.guildId || "",
        markRead: true,
        sendTyping: false,
      });
    } else if (action === "mark_all_as_read" || action === "_mark_all_as_read") {
      try {
        await this.invokeNt("nodeIKernelMsgService/setAllC2CAndGroupMsgRead", {}, []);
      } catch (err) {
        this.logger?.debug?.("message_actions", err);
      }
    }
    return {};
  },

  async set_input_status(p) {
    const userId = p.user_id;
    if (!userId) throw new Error("user_id is required");
    const peer = await this.outboundPipeline._resolvePeerForUser(userId);
    const peerKey = `${peer.chatType}:${peer.peerUid}:${peer.guildId || ""}`;
    this.sessionController.scheduler.cancelPeerReaction(peerKey);
    const eventType = Number(p.event_type ?? 1);
    await this.simulateHumanSession({
      chatType: peer.chatType,
      peerUid: peer.peerUid,
      guildId: peer.guildId || "",
      markRead: true,
      sendTyping: true,
      eventType,
    });
    return {};
  },

  async set_msg_emoji_like(p) {
    const entry = resolveMessageEntry(this, p.message_id);
    if (!entry) throw new Error("message not found");
    const emojiId = String(p.emoji_id ?? p.code ?? "");
    if (!emojiId) throw new Error("emoji_id is required");
    const emojiType = Number(emojiId) > 999 ? "2" : "1";
    const setEmoji = Boolean(p.set ?? p.is_set ?? true);
    await this.invokeNt(
      "nodeIKernelMsgService/setMsgEmojiLikes",
      {
        peer: entry.peer,
        msgSeq: String(entry.msgSeq || "0"),
        emojiId,
        emojiType,
        setEmoji,
      },
      [entry.peer, String(entry.msgSeq || "0"), emojiId, emojiType, setEmoji]
    );
    return {};
  },

  async fetch_emoji_like(p) {
    const entry = resolveMessageEntry(this, p.message_id);
    const peer =
      entry?.peer ||
      (p.group_id
        ? { chatType: 2, peerUid: String(p.group_id), guildId: "" }
        : await this.outboundPipeline._resolvePeerForUser(p.user_id));
    const msgSeq = String(entry?.msgSeq || p.msg_seq || "0");
    const emojiId = String(p.emoji_id || "");
    const emojiType = String(p.emoji_type || (Number(emojiId) > 999 ? "2" : "1"));
    const count = Number(p.count || 20);
    const res = await this.invokeNt(
      "nodeIKernelMsgService/getMsgEmojiLikesList",
      {
        peer,
        msgSeq,
        emojiId,
        emojiType,
        cookie: "",
        isForward: false,
        count,
      },
      [peer, msgSeq, emojiId, emojiType, "", false, count]
    );
    return {
      emoji_like_list: res?.emojiLikesList || [],
    };
  },

  async send_like(p) {
    const targetUid = await this.uinUidStore.resolveUid(
      p.user_id,
      this.invokeNt.bind(this)
    );
    const count = Math.max(1, Math.min(Number(p.times || 1), 20));
    const doLikeUserInfo = {
      friendUid: targetUid,
      sourceId: 71,
      doLikeCount: count,
      doLikeTollCount: 0,
    };
    await this.invokeNt(
      "nodeIKernelProfileLikeService/setBuddyProfileLike",
      { doLikeUserInfo },
      [doLikeUserInfo]
    );
    return {};
  },

  async get_profile_like(p) {
    const targetUid = p.user_id
      ? await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this))
      : this.selfUid;
    const req = {
      friendUids: [targetUid || ""],
      basic: 1,
      vote: 1,
      favorite: 0,
      userProfile: 1,
      type: 2,
      start: Number(p.start || 0),
      limit: Number(p.count || 10),
    };
    const res = await this.invokeNt(
      "nodeIKernelProfileLikeService/getBuddyProfileLike",
      { req },
      [req]
    );
    const info = res?.info?.userLikeInfos?.[0] || {};
    return {
      uid: String(targetUid || ""),
      time: Number(info.time || 0),
      favoriteInfo: info.favoriteInfo || {
        total_count: 0,
        last_time: 0,
        today_count: 0,
        userInfos: [],
      },
      voteInfo: info.voteInfo || {
        total_count: 0,
        new_count: 0,
        new_nearby_count: 0,
        last_visit_time: 0,
        userInfos: [],
      },
    };
  },

  async group_poke(p) {
    await this.outboundPipeline._sendPokeInternal(p.group_id, p.user_id);
    return {};
  },

  async friend_poke(p) {
    await this.outboundPipeline._sendPokeInternal(undefined, p.user_id);
    return {};
  },

  async send_poke(p) {
    await this.outboundPipeline._sendPokeInternal(p.group_id, p.user_id || p.target_id);
    return {};
  },

  async [".handle_quick_operation"](p, context) {
    const ev = p.context;
    const op = p.operation;
    if (
      !ev ||
      typeof ev !== "object" ||
      Array.isArray(ev) ||
      !op ||
      typeof op !== "object" ||
      Array.isArray(op)
    ) {
      /** @type {Error & { retcode?: number }} */
      const err = new Error("context and operation are required");
      err.retcode = 1400;
      throw err;
    }

    const postType = String(ev.post_type || "");
    if (postType === "message") {
      if (op.reply !== undefined && op.reply !== null && op.reply !== "") {
        const autoEscape = Boolean(op.auto_escape);
        if (ev.message_type === "group" && ev.group_id) {
          let replyMessage = op.reply;
          let effectiveAutoEscape = autoEscape;
          if (op.at_sender !== false && ev.user_id) {
            const atSeg = { type: "at", data: { qq: String(ev.user_id) } };
            if (typeof op.reply === "string") {
              const parsed = autoEscape
                ? [{ type: "text", data: { text: op.reply } }]
                : parseCqCodeToSegments(op.reply, false);
              replyMessage = [atSeg, ...parsed];
              effectiveAutoEscape = false;
            } else if (Array.isArray(op.reply)) {
              replyMessage = [atSeg, ...op.reply];
            } else if (op.reply && typeof op.reply === "object") {
              replyMessage = [atSeg, op.reply];
            }
          }
          await this._dispatchAction(
            "send_group_msg",
            {
              group_id: ev.group_id,
              message: replyMessage,
              auto_escape: effectiveAutoEscape,
            },
            context
          );
        } else if (ev.user_id) {
          await this._dispatchAction(
            "send_private_msg",
            {
              user_id: ev.user_id,
              ...(ev.group_id ? { group_id: ev.group_id } : {}),
              message: op.reply,
              auto_escape: autoEscape,
            },
            context
          );
        }
      }

      if (op.delete && ev.message_id !== undefined && ev.message_id !== null) {
        await this._dispatchAction("delete_msg", { message_id: ev.message_id }, context);
      }

      if (op.ban && ev.message_type === "group" && ev.group_id && ev.user_id) {
        const duration =
          typeof op.ban_duration === "number" && Number.isFinite(op.ban_duration)
            ? op.ban_duration
            : 1800;
        await this._dispatchAction(
          "set_group_ban",
          {
            group_id: ev.group_id,
            user_id: ev.user_id,
            duration,
          },
          context
        );
      }

      if (op.kick && ev.message_type === "group" && ev.group_id && ev.user_id) {
        await this._dispatchAction(
          "set_group_kick",
          {
            group_id: ev.group_id,
            user_id: ev.user_id,
            reject_add_request: Boolean(op.reject_add_request),
          },
          context
        );
      }
    } else if (postType === "request" && op.approve !== undefined) {
      if (ev.request_type === "friend") {
        await this._dispatchAction(
          "set_friend_add_request",
          {
            flag: String(ev.flag || ""),
            approve: Boolean(op.approve),
            remark: String(op.remark ?? ""),
          },
          context
        );
      } else if (ev.request_type === "group") {
        await this._dispatchAction(
          "set_group_add_request",
          {
            flag: String(ev.flag || ""),
            sub_type: String(ev.sub_type || ev.subType || "add"),
            approve: Boolean(op.approve),
            reason: String(op.reason ?? ""),
          },
          context
        );
      }
    }
    return {};
  },
};

const ACTION_ALIASES = {
  send_group_forward_msg: "send_forward_msg",
  send_private_forward_msg: "send_forward_msg",
  upload_forward_msg: "send_forward_msg",
  upload_foward_msg: "send_forward_msg",
  mark_group_msg_as_read: "mark_msg_as_read",
  mark_private_msg_as_read: "mark_msg_as_read",
  mark_all_as_read: "mark_msg_as_read",
  _mark_all_as_read: "mark_msg_as_read",
  set_group_reaction: "set_msg_emoji_like",
  get_emoji_likes: "fetch_emoji_like",
  get_msg_emoji_likes: "fetch_emoji_like",
  ".handle_quick_operation_async": ".handle_quick_operation",
  handle_quick_operation: ".handle_quick_operation",
  handle_quick_operation_async: ".handle_quick_operation",
};

const { HANDLED_ACTIONS, dispatch } = createActionRouter(ACTION_HANDLERS, ACTION_ALIASES);

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
};
