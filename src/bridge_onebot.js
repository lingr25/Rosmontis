"use strict";

/**
 * Pure Node.js OneBot v11 Protocol & NTQQ Kernel Data Converter (`bridge_onebot.js`)
 *
 * Zero Electron dependencies at import time so all classes and converters can be
 * unit-tested directly in standard Node.js.
 *
 * Responsibilities:
 * 1. `MessageIdStore`: Bi-directional LRU mapping between NTQQ 64-bit `msgId` /
 *    `(chatType, peerUid, msgSeq)` and 32-bit positive integer OneBot `message_id`.
 * 2. `UinUidStore`: Bi-directional cache for QQ `uin` <-> NTQQ `uid` (`u_...`),
 *    learned passively from messages/contacts/groups and actively via
 *    `nodeIKernelUixConvertService/getUid` & `getUin`.
 * 3. `ntMsgToOneBotSegments` & `oneBotSegmentsToNtElements`: Full conversion between
 *    NTQQ `msgElements` (types 1,2,3,4,5,6,7,8,10,11,16) and OneBot v11 segments / CQ codes.
 * 4. `formatNtMsgToOneBotEvent`, `formatNoticeEvent`, `formatRequestEvent`, `formatMetaEvent`:
 *    Full OneBot v11 event formatting (message, notice, request, meta_event).
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");

// ============================================================================
// 1. MessageIdStore (Bounded LRU, 32-bit positive integer OneBot message_id)
// ============================================================================

class MessageIdStore {
  constructor(maxEntries = 10000) {
    this.maxEntries = Math.max(2, Number(maxEntries) || 10000);
    this.byShortId = new Map();
    this.byMsgId = new Map();
    this.byPeerSeq = new Map();
    this._seqCounter = 100000;
  }

  static _peerSeqKey(chatType, peerUid, msgSeq) {
    if (!peerUid || msgSeq === undefined || msgSeq === null || String(msgSeq) === "0" || String(msgSeq) === "") {
      return "";
    }
    return `${Number(chatType) || 0}:${String(peerUid)}:${String(msgSeq)}`;
  }

  _computeShortId(msgIdStr, peer, msgSeq) {
    const seed = `${msgIdStr || ""}|${peer?.chatType || 0}|${peer?.peerUid || ""}|${msgSeq || ""}`;
    const digest = crypto.createHash("md5").update(seed).digest();
    // Positive 31-bit integer in [1, 0x7fffffff]
    let candidate = (digest.readUInt32BE(0) & 0x7fffffff) || 1;
    let attempts = 0;
    while (this.byShortId.has(candidate) && attempts < 16) {
      const existing = this.byShortId.get(candidate);
      if (existing && msgIdStr && existing.msgId === msgIdStr) {
        return candidate;
      }
      candidate = ((candidate + 1) & 0x7fffffff) || 1;
      attempts++;
    }
    if (this.byShortId.has(candidate)) {
      this._seqCounter = ((this._seqCounter + 1) & 0x7fffffff) || 1;
      candidate = this._seqCounter;
    }
    return candidate;
  }

  _evictIfNeeded() {
    while (this.byShortId.size > this.maxEntries) {
      const oldestKey = this.byShortId.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = this.byShortId.get(oldestKey);
      this.byShortId.delete(oldestKey);
      if (entry) {
        if (entry.msgId && this.byMsgId.get(entry.msgId) === entry) {
          this.byMsgId.delete(entry.msgId);
        }
        const psKey = MessageIdStore._peerSeqKey(
          entry.peer?.chatType,
          entry.peer?.peerUid,
          entry.msgSeq
        );
        if (psKey && this.byPeerSeq.get(psKey) === entry) {
          this.byPeerSeq.delete(psKey);
        }
      }
    }
  }

  _touch(entry) {
    if (!entry) return null;
    this.byShortId.delete(entry.shortId);
    this.byShortId.set(entry.shortId, entry);
    return entry;
  }

  get size() {
    return this.byShortId.size;
  }

  register(msgId, peer, msgSeq, extra = {}) {
    if (msgId && typeof msgId === "object" && !Array.isArray(msgId)) {
      const obj = msgId;
      return this.register(
        obj.msgId,
        obj.peer || {
          chatType: obj.chatType,
          peerUid: obj.peerUid,
          guildId: obj.guildId,
        },
        obj.msgSeq,
        obj
      );
    }
    const msgIdStr = msgId !== undefined && msgId !== null && String(msgId) !== "0" ? String(msgId) : "";
    const normPeer = {
      chatType: Number(peer?.chatType || extra.chatType || 1),
      peerUid: String(peer?.peerUid || extra.peerUid || ""),
      guildId: String(peer?.guildId || extra.guildId || ""),
    };
    const msgSeqStr = msgSeq !== undefined && msgSeq !== null ? String(msgSeq) : "";
    const psKey = MessageIdStore._peerSeqKey(normPeer.chatType, normPeer.peerUid, msgSeqStr);

    let existing = null;
    if (msgIdStr && this.byMsgId.has(msgIdStr)) {
      existing = this.byMsgId.get(msgIdStr);
    } else if (psKey && this.byPeerSeq.has(psKey)) {
      const candidate = this.byPeerSeq.get(psKey);
      const candMsgId = candidate && candidate.msgId ? String(candidate.msgId) : "";
      if (
        !msgIdStr ||
        !candMsgId ||
        candMsgId === "0" ||
        candMsgId.startsWith("sent_") ||
        candMsgId === String(candidate.shortId)
      ) {
        existing = candidate;
      }
    }

    if (existing) {
      if (
        msgIdStr &&
        (!existing.msgId ||
          existing.msgId === "0" ||
          String(existing.msgId).startsWith("sent_") ||
          String(existing.msgId) === String(existing.shortId))
      ) {
        existing.msgId = msgIdStr;
        this.byMsgId.set(msgIdStr, existing);
      }
      if (normPeer.peerUid) {
        existing.peer = normPeer;
        existing.chatType = normPeer.chatType;
        existing.peerUid = normPeer.peerUid;
      }
      if (msgSeqStr && msgSeqStr !== "0") {
        existing.msgSeq = msgSeqStr;
        if (psKey) this.byPeerSeq.set(psKey, existing);
      }
      if (extra.senderUin !== undefined) existing.senderUin = String(extra.senderUin);
      if (extra.senderUid !== undefined) existing.senderUid = String(extra.senderUid);
      if (extra.groupId !== undefined) existing.groupId = String(extra.groupId);
      if (extra.msgTime !== undefined) existing.msgTime = Number(extra.msgTime);
      if (extra.rawMsg !== undefined) existing.rawMsg = extra.rawMsg;
      if (extra.oneBotEvent !== undefined) existing.oneBotEvent = extra.oneBotEvent;
      this._touch(existing);
      return existing.shortId;
    }

    const shortId = this._computeShortId(msgIdStr, normPeer, msgSeqStr);
    const entry = {
      shortId,
      msgId: msgIdStr || String(shortId),
      peer: normPeer,
      chatType: normPeer.chatType,
      peerUid: normPeer.peerUid,
      msgSeq: msgSeqStr || "0",
      senderUin: extra.senderUin !== undefined ? String(extra.senderUin) : "",
      senderUid: extra.senderUid !== undefined ? String(extra.senderUid) : "",
      groupId: extra.groupId !== undefined ? String(extra.groupId) : "",
      msgTime: Number(extra.msgTime || Math.floor(Date.now() / 1000)),
      rawMsg: extra.rawMsg || null,
      oneBotEvent: extra.oneBotEvent || null,
      createdAt: Date.now(),
    };

    this.byShortId.set(shortId, entry);
    if (msgIdStr) {
      this.byMsgId.set(msgIdStr, entry);
    }
    if (psKey) {
      this.byPeerSeq.set(psKey, entry);
    }
    this._evictIfNeeded();
    return shortId;
  }

  getByShortId(shortId) {
    if (shortId === undefined || shortId === null) return null;
    const num = Number(shortId);
    if (Number.isInteger(num) && this.byShortId.has(num)) {
      return this._touch(this.byShortId.get(num));
    }
    const str = String(shortId).trim();
    if (this.byMsgId.has(str)) {
      return this._touch(this.byMsgId.get(str));
    }
    return null;
  }

  getByMsgId(msgId) {
    if (msgId === undefined || msgId === null) return null;
    const str = String(msgId).trim();
    if (this.byMsgId.has(str)) {
      return this._touch(this.byMsgId.get(str));
    }
    const num = Number(str);
    if (Number.isInteger(num) && this.byShortId.has(num)) {
      return this._touch(this.byShortId.get(num));
    }
    return null;
  }

  getByPeerAndSeq(chatType, peerUid, msgSeq) {
    const psKey = MessageIdStore._peerSeqKey(chatType, peerUid, msgSeq);
    if (!psKey) return null;
    const entry = this.byPeerSeq.get(psKey);
    return entry ? this._touch(entry) : null;
  }

  getByPeerSeq(chatType, peerUid, msgSeq) {
    return this.getByPeerAndSeq(chatType, peerUid, msgSeq);
  }
}

// ============================================================================
// 2. UinUidStore (Bi-Directional QQ UIN <-> NTQQ UID Cache)
// ============================================================================

class UinUidStore {
  constructor(maxEntries = 20000) {
    this.maxEntries = Math.max(500, Number(maxEntries) || 20000);
    this.uinToUid = new Map();
    this.uidToUin = new Map();
    this.userMeta = new Map(); // uin -> { uin, uid, nickname, remark, sex, age }
    this.groupMemberMeta = new Map(); // `${groupId}:${uin}` -> { uin, uid, nickname, card, role, title }
  }

  _evictIfNeeded() {
    while (this.uinToUid.size > this.maxEntries) {
      const oldestUin = this.uinToUid.keys().next().value;
      if (oldestUin === undefined) break;
      const uid = this.uinToUid.get(oldestUin);
      this.uinToUid.delete(oldestUin);
      if (uid && this.uidToUin.get(uid) === oldestUin) {
        this.uidToUin.delete(uid);
      }
    }
  }

  record(uin, uid, meta = null) {
    return this.remember(uin, uid, meta);
  }

  remember(uin, uid, meta = null) {
    const uinStr = uin !== undefined && uin !== null ? String(uin).trim() : "";
    const uidStr = uid !== undefined && uid !== null ? String(uid).trim() : "";
    const validUin = /^\d+$/.test(uinStr) && Number(uinStr) > 0;
    const validUid = uidStr.length > 0 && uidStr !== "0";

    if (validUin && validUid) {
      this.uinToUid.delete(uinStr);
      this.uinToUid.set(uinStr, uidStr);
      this.uidToUin.delete(uidStr);
      this.uidToUin.set(uidStr, uinStr);
      this._evictIfNeeded();
    }

    if (validUin && meta && typeof meta === "object") {
      const prev = this.userMeta.get(uinStr) || { uin: Number(uinStr), uid: uidStr };
      this.userMeta.set(uinStr, {
        ...prev,
        ...(validUid ? { uid: uidStr } : {}),
        ...(meta.nickname ? { nickname: String(meta.nickname) } : {}),
        ...(meta.remark !== undefined ? { remark: String(meta.remark) } : {}),
        ...(meta.sex ? { sex: String(meta.sex) } : {}),
        ...(meta.age !== undefined ? { age: Number(meta.age) } : {}),
      });
      if (meta.groupId && /^\d+$/.test(String(meta.groupId))) {
        const gKey = `${meta.groupId}:${uinStr}`;
        const prevG = this.groupMemberMeta.get(gKey) || {};
        this.groupMemberMeta.set(gKey, {
          ...prevG,
          group_id: Number(meta.groupId),
          user_id: Number(uinStr),
          uid: validUid ? uidStr : prevG.uid || "",
          nickname: String(meta.nickname ?? prevG.nickname ?? ""),
          card: String(meta.card ?? prevG.card ?? ""),
          role: String(meta.role ?? prevG.role ?? ""),
          title: String(meta.title ?? prevG.title ?? ""),
        });
      }
    }
  }

  rememberFromNtMsg(ntMsg) {
    if (!ntMsg || typeof ntMsg !== "object") return;
    if (ntMsg.senderUin && ntMsg.senderUid) {
      this.remember(ntMsg.senderUin, ntMsg.senderUid, {
        nickname: ntMsg.sendNickName || "",
        card: ntMsg.sendMemberName || "",
        groupId: ntMsg.chatType === 2 ? ntMsg.peerUid || ntMsg.peerUin : undefined,
      });
    }
    if ((ntMsg.chatType === 1 || ntMsg.chatType === 100) && ntMsg.peerUin && ntMsg.peerUid) {
      this.remember(ntMsg.peerUin, ntMsg.peerUid, {
        nickname: ntMsg.peerName || "",
      });
    }
    if (Array.isArray(ntMsg.elements)) {
      for (const el of ntMsg.elements) {
        if (el?.textElement && el.textElement.atType === 2) {
          const atUin = el.textElement.atUid;
          const atUid = el.textElement.atNtUid;
          if (atUin && atUid) {
            this.remember(atUin, atUid);
          }
        }
        if (el?.replyElement) {
          const rUin = el.replyElement.senderUid;
          const rUid = el.replyElement.senderUidStr;
          if (rUin && rUid) {
            this.remember(rUin, rUid);
          }
        }
      }
    }
  }

  rememberFromBuddyList(buddyData) {
    if (!buddyData) return;
    const simpleInfos = buddyData.userSimpleInfos;
    if (simpleInfos instanceof Map) {
      for (const [uidKey, info] of simpleInfos.entries()) {
        const core = info?.coreInfo || info?.baseInfo || info || {};
        this.remember(core.uin || info?.uin, core.uid || info?.uid || uidKey, {
          nickname: core.nick || info?.nick || "",
          remark: core.remark || info?.remark || "",
        });
      }
    } else if (simpleInfos && typeof simpleInfos === "object") {
      for (const [uidKey, info] of Object.entries(simpleInfos)) {
        const core = info?.coreInfo || info?.baseInfo || info || {};
        this.remember(core.uin || info?.uin, core.uid || info?.uid || uidKey, {
          nickname: core.nick || info?.nick || "",
          remark: core.remark || info?.remark || "",
        });
      }
    }
    const list = Array.isArray(buddyData) ? buddyData : buddyData.buddyCategory || buddyData.data || [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item.buddyList)) {
        for (const buddy of item.buddyList) {
          this._rememberBuddyObject(buddy);
        }
      } else if (!Array.isArray(item.buddyUids)) {
        this._rememberBuddyObject(item);
      }
    }
  }

  _rememberBuddyObject(buddy) {
    if (!buddy || typeof buddy !== "object") return;
    const core = buddy.coreInfo || buddy.baseInfo || buddy;
    const uin = buddy.uin || core.uin;
    const uid = buddy.uid || core.uid;
    const nickname = buddy.nick || core.nick || buddy.nickname || "";
    const remark = buddy.remark || core.remark || "";
    this.remember(uin, uid, { nickname, remark });
  }

  rememberFromGroupMemberList(groupId, membersContainer) {
    if (!membersContainer) return;
    let infos = membersContainer;
    if (membersContainer.result && membersContainer.result.infos) {
      infos = membersContainer.result.infos;
    } else if (membersContainer.infos) {
      infos = membersContainer.infos;
    }
    const iter =
      infos instanceof Map
        ? infos.values()
        : Array.isArray(infos)
        ? infos
        : typeof infos === "object"
        ? Object.values(infos)
        : [];
    for (const m of iter) {
      if (!m || typeof m !== "object") continue;
      const uin = m.uin ?? m.user_id;
      const uid = m.uid ?? "";
      const roleNum = m.role ?? m.permission;
      const role =
        typeof roleNum === "string"
          ? roleNum
          : roleNum === 4 || roleNum === 1
          ? "owner"
          : roleNum === 3 || roleNum === 2
          ? "admin"
          : "member";
      this.remember(uin, uid, {
        groupId,
        nickname: m.nick ?? m.nickname ?? m.memberName ?? "",
        card: m.cardName ?? m.card ?? m.memberCard?.memberCard ?? "",
        role,
        title: m.memberSpecialTitle ?? m.specialTitle ?? m.title ?? "",
      });
    }
  }

  getUid(uin) {
    return this.getUidSync(uin);
  }

  getUin(uid) {
    return this.getUinSync(uid);
  }

  getUidSync(uin) {
    if (uin === undefined || uin === null) return "";
    const str = String(uin).trim();
    if (str.startsWith("u_")) return str;
    return this.uinToUid.get(str) || "";
  }

  getUinSync(uid) {
    if (uid === undefined || uid === null) return "";
    const str = String(uid).trim();
    if (/^\d+$/.test(str) && Number(str) > 0) return str;
    return this.uidToUin.get(str) || "";
  }

  async resolveUid(uin, invokeNt) {
    const str = String(uin ?? "").trim();
    if (!str) return "";
    if (str.startsWith("u_")) return str;
    const cached = this.getUidSync(str);
    if (cached) return cached;
    if (typeof invokeNt === "function" && /^\d+$/.test(str)) {
      const extractUid = (mapOrObj) => {
        if (mapOrObj instanceof Map) {
          return mapOrObj.get(str) || mapOrObj.get(Number(str)) || "";
        }
        if (mapOrObj && typeof mapOrObj === "object") {
          return mapOrObj[str] || "";
        }
        return "";
      };
      try {
        const res = await invokeNt(
          "nodeIKernelUixConvertService/getUid",
          { uins: [str] },
          [[str]]
        );
        const resolved = extractUid(res?.uidInfo || res);
        if (resolved) {
          this.remember(str, resolved);
          return String(resolved);
        }
      } catch (_) {}
      try {
        const res2 = await invokeNt(
          "nodeIKernelGroupService/getUidByUins",
          { uinList: [str] },
          [[str]]
        );
        const resolved2 = extractUid(res2?.uids || res2?.uidInfo || res2);
        if (resolved2) {
          this.remember(str, resolved2);
          return String(resolved2);
        }
      } catch (_) {}
    }
    return "";
  }

  async resolveUin(uid, invokeNt) {
    const str = String(uid ?? "").trim();
    if (!str) return "";
    if (/^\d+$/.test(str) && Number(str) > 0) return str;
    const cached = this.getUinSync(str);
    if (cached) return cached;
    if (typeof invokeNt === "function") {
      const extractUin = (mapOrObj) => {
        if (mapOrObj instanceof Map) {
          return mapOrObj.get(str) || "";
        }
        if (mapOrObj && typeof mapOrObj === "object") {
          return mapOrObj[str] || "";
        }
        return "";
      };
      try {
        const res = await invokeNt(
          "nodeIKernelUixConvertService/getUin",
          { uids: [str] },
          [[str]]
        );
        const resolved = extractUin(res?.uinInfo || res);
        if (resolved && /^\d+$/.test(String(resolved)) && Number(resolved) > 0) {
          this.remember(String(resolved), str);
          return String(resolved);
        }
      } catch (_) {}
      try {
        const res2 = await invokeNt(
          "nodeIKernelGroupService/getUinByUids",
          { uidList: [str], uids: [str] },
          [[str]]
        );
        const resolved2 = extractUin(res2?.uins || res2?.uinInfo || res2);
        if (resolved2 && /^\d+$/.test(String(resolved2)) && Number(resolved2) > 0) {
          this.remember(String(resolved2), str);
          return String(resolved2);
        }
      } catch (_) {}
    }
    return "";
  }
}

// ============================================================================
// 3. CQ-Code Escaping, Parsing, and Serialization
// ============================================================================

function escapeCqText(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;");
}

function unescapeCqText(str) {
  return String(str ?? "")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

function escapeCqParam(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/,/g, "&#44;");
}

function segmentsToCqCode(segments) {
  if (!Array.isArray(segments)) return String(segments ?? "");
  const parts = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") continue;
    const type = String(seg.type || "");
    const data = seg.data && typeof seg.data === "object" ? seg.data : {};
    if (type === "text") {
      parts.push(escapeCqText(data.text ?? ""));
    } else if (type) {
      const kv = [];
      for (const [k, v] of Object.entries(data)) {
        if (v === undefined || v === null || v === "") continue;
        kv.push(`${k}=${escapeCqParam(typeof v === "object" ? JSON.stringify(v) : String(v))}`);
      }
      parts.push(kv.length > 0 ? `[CQ:${type},${kv.join(",")}]` : `[CQ:${type}]`);
    }
  }
  return parts.join("");
}

function parseCqCodeToSegments(raw, autoEscape = false) {
  const str = String(raw ?? "");
  if (!str) return [];
  if (autoEscape) {
    return [{ type: "text", data: { text: str } }];
  }
  const segments = [];
  const regex = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^,\]]+=[^,\]]*)*)\]/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(str)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "text",
        data: { text: unescapeCqText(str.slice(lastIndex, match.index)) },
      });
    }
    const type = match[1];
    const paramsRaw = match[2] || "";
    const data = {};
    if (paramsRaw.startsWith(",")) {
      const pairs = paramsRaw.slice(1).split(",");
      for (const pair of pairs) {
        const eqIdx = pair.indexOf("=");
        if (eqIdx > 0) {
          const k = pair.slice(0, eqIdx).trim();
          const v = unescapeCqText(pair.slice(eqIdx + 1));
          data[k] = v;
        }
      }
    }
    segments.push({ type, data });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < str.length) {
    segments.push({
      type: "text",
      data: { text: unescapeCqText(str.slice(lastIndex)) },
    });
  }
  return segments;
}

function normalizeOneBotMessage(message, autoEscape = false) {
  if (Array.isArray(message)) {
    const out = [];
    for (const item of message) {
      if (typeof item === "string") {
        out.push(...parseCqCodeToSegments(item, autoEscape));
      } else if (item && typeof item === "object" && item.type) {
        out.push({
          type: String(item.type),
          data: item.data && typeof item.data === "object" ? { ...item.data } : {},
        });
      }
    }
    return out;
  }
  if (message && typeof message === "object" && message.type) {
    return [
      {
        type: String(message.type),
        data: message.data && typeof message.data === "object" ? { ...message.data } : {},
      },
    ];
  }
  if (typeof message === "string") {
    return parseCqCodeToSegments(message, autoEscape);
  }
  return [];
}

// ============================================================================
// 4. Image Header Dimension & Media Materialization Helpers
// ============================================================================

function inspectImageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) {
    return { width: 512, height: 512, isGif: false, ext: ".jpg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16) || 512;
    const height = buf.readUInt32BE(20) || 512;
    return { width, height, isGif: false, ext: ".png" };
  }
  // GIF: "GIF87a" or "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const width = buf.readUInt16LE(6) || 256;
    const height = buf.readUInt16LE(8) || 256;
    return { width, height, isGif: true, ext: ".gif" };
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    let width = 512;
    let height = 512;
    const chunkHeader = buf.slice(12, 16).toString("ascii");
    if (chunkHeader === "VP8 " && buf.length >= 30) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunkHeader === "VP8L" && buf.length >= 25) {
      const b0 = buf[21];
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    } else if (chunkHeader === "VP8X" && buf.length >= 30) {
      width = 1 + buf.readUIntLE(24, 3);
      height = 1 + buf.readUIntLE(27, 3);
    }
    return { width: width || 512, height: height || 512, isGif: false, ext: ".webp" };
  }
  // JPEG: FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buf.readUInt16BE(offset + 5) || 512;
        const width = buf.readUInt16BE(offset + 7) || 512;
        return { width, height, isGif: false, ext: ".jpg" };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
    return { width: 512, height: 512, isGif: false, ext: ".jpg" };
  }
  return { width: 512, height: 512, isGif: false, ext: ".jpg" };
}

let _cachedVersionMeta = null;

function getNtqqVersionMetadata(options = {}) {
  if (_cachedVersionMeta && !options.forceRefresh && !options.packagePaths && !options.chromeVersion) {
    return _cachedVersionMeta;
  }
  const candidatePaths = options.packagePaths || [
    "/opt/QQ/resources/app/package.orig.json",
    "/opt/QQ/resources/app/package.json",
    path.join(__dirname, "package_patch.json"),
  ];
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
    } catch (_) {}
  }
  const chromeVersion = String(
    options.chromeVersion || (process && process.versions && process.versions.chrome) || "138.0.0.0"
  );
  const meta = {
    qqVersion,
    buildVersion,
    chromeVersion,
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36 QQ/${qqVersion}`,
  };
  if (!options.packagePaths && !options.chromeVersion) {
    _cachedVersionMeta = meta;
  }
  return meta;
}

function buildNtqqUserAgent(options = {}) {
  return getNtqqVersionMetadata(options).userAgent;
}

function pruneTempDir(tempDir, maxFiles = 128) {
  try {
    if (!tempDir || !fs.existsSync(tempDir)) return 0;
    const entries = fs
      .readdirSync(tempDir)
      .map((name) => {
        const fullPath = path.join(tempDir, name);
        try {
          const st = fs.statSync(fullPath);
          if (st.isFile()) {
            return { fullPath, mtimeMs: Number(st.mtimeMs || 0) };
          }
        } catch (_) {}
        return null;
      })
      .filter(Boolean);
    if (entries.length <= maxFiles) return 0;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const toRemove = entries.slice(0, entries.length - maxFiles);
    let removed = 0;
    for (const item of toRemove) {
      try {
        fs.unlinkSync(item.fullPath);
        removed++;
      } catch (_) {}
    }
    return removed;
  } catch (_) {
    return 0;
  }
}

function downloadBufferFromUrl(urlStr, timeoutMs = 20000, redirectsLeft = 4) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (e) {
      return reject(e);
    }
    const mod = parsed.protocol === "https:" ? https : http;
    const req = mod.get(
      urlStr,
      {
        headers: {
          "User-Agent": buildNtqqUserAgent(),
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (
          res.statusCode &&
          [301, 302, 303, 307, 308].includes(res.statusCode) &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          res.resume();
          const nextUrl = new URL(res.headers.location, urlStr).toString();
          return downloadBufferFromUrl(nextUrl, timeoutMs, redirectsLeft - 1).then(
            resolve,
            reject
          );
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} fetching ${urlStr}`));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Timeout fetching ${urlStr}`));
    });
    req.on("error", reject);
  });
}

async function resolveMediaSource(sourceStr, options = {}) {
  const raw = String(sourceStr || "").trim();
  if (!raw) {
    throw new Error("Empty media source");
  }
  const tempDir =
    options.tempDir ||
    process.env.ROSMONTIS_TEMP_DIR ||
    process.env.ONEBOT_TEMP_DIR ||
    process.env.XIAO_BRIDGE_TEMP_DIR ||
    path.join(process.env.HOME || "/tmp", ".rosmontis_tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const maxTempFiles = Math.max(8, Number(options.maxTempFiles || 128));

  // 1. base64:// or data:...;base64,...
  if (raw.startsWith("base64://") || /^data:[^;]+;base64,/i.test(raw)) {
    const b64 = raw.startsWith("base64://")
      ? raw.slice("base64://".length)
      : raw.replace(/^data:[^;]+;base64,/i, "");
    const buf = Buffer.from(b64, "base64");
    const md5HexStr = crypto.createHash("md5").update(buf).digest("hex");
    const dim = inspectImageDimensions(buf);
    const ext = options.preferredExt || dim.ext || ".bin";
    const fileName = options.preferredName || `${md5HexStr}${ext}`;
    const localPath = path.join(tempDir, path.basename(fileName));
    fs.writeFileSync(localPath, buf);
    pruneTempDir(tempDir, maxTempFiles);
    return {
      localPath,
      fileName: path.basename(fileName),
      fileSize: buf.length,
      md5HexStr,
      width: dim.width,
      height: dim.height,
      isGif: dim.isGif,
      buffer: buf,
      isTempFile: true,
    };
  }

  // 2. http:// or https://
  if (/^https?:\/\//i.test(raw)) {
    const buf = await downloadBufferFromUrl(raw, options.timeoutMs || 25000);
    const md5HexStr = crypto.createHash("md5").update(buf).digest("hex");
    const dim = inspectImageDimensions(buf);
    const ext = options.preferredExt || dim.ext || ".bin";
    const fileName = options.preferredName || `${md5HexStr}${ext}`;
    const localPath = path.join(tempDir, path.basename(fileName));
    fs.writeFileSync(localPath, buf);
    pruneTempDir(tempDir, maxTempFiles);
    return {
      localPath,
      fileName: path.basename(fileName),
      fileSize: buf.length,
      md5HexStr,
      width: dim.width,
      height: dim.height,
      isGif: dim.isGif,
      buffer: buf,
      isTempFile: true,
    };
  }

  // 3. file:// or local path
  let localPath = raw;
  if (raw.startsWith("file://")) {
    try {
      const u = new URL(raw);
      localPath = decodeURIComponent(u.pathname);
      if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(localPath)) {
        localPath = localPath.slice(1);
      }
    } catch (_) {
      localPath = raw.replace(/^file:\/+/, "/");
    }
  }

  if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
    const buf = fs.readFileSync(localPath);
    const md5HexStr = crypto.createHash("md5").update(buf).digest("hex");
    const dim = inspectImageDimensions(buf);
    const fileName = options.preferredName || path.basename(localPath) || `${md5HexStr}${dim.ext}`;
    return {
      localPath,
      fileName: path.basename(fileName),
      fileSize: buf.length,
      md5HexStr,
      width: dim.width,
      height: dim.height,
      isGif: dim.isGif,
      buffer: buf,
      isTempFile: false,
    };
  }

  throw new Error(`Media source not found or unsupported: ${raw.slice(0, 120)}`);
}

// ============================================================================
// 5. NTQQ `msgElements` <-> OneBot v11 Segments Converter
// ============================================================================

function buildNtPicUrl(picElement, chatType) {
  if (!picElement || typeof picElement !== "object") return "";
  if (typeof picElement.__base64Uri === "string" && picElement.__base64Uri) {
    return picElement.__base64Uri;
  }
  const origin = String(picElement.originImageUrl || "").trim();
  if (origin) {
    if (/^https?:\/\//i.test(origin)) {
      if (!origin.includes("multimedia.nt.qq.com.cn/download") || origin.includes("rkey=")) {
        return origin;
      }
    } else if (origin.startsWith("/download")) {
      if (origin.includes("rkey=")) {
        return `https://multimedia.nt.qq.com.cn${origin}`;
      }
    } else if (origin.startsWith("/")) {
      return `https://gchat.qpic.cn${origin}`;
    }
  }
  const candidatePaths = [];
  if (picElement.sourcePath) candidatePaths.push(String(picElement.sourcePath));
  if (picElement.thumbPath instanceof Map) {
    for (const p of picElement.thumbPath.values()) {
      if (p) candidatePaths.push(String(p));
    }
  } else if (picElement.thumbPath && typeof picElement.thumbPath === "object") {
    for (const p of Object.values(picElement.thumbPath)) {
      if (p) candidatePaths.push(String(p));
    }
  }
  for (const localPath of candidatePaths) {
    try {
      if (localPath && fs.existsSync(localPath)) {
        const st = fs.statSync(localPath);
        if (st.isFile() && st.size > 0) {
          if (st.size <= 10 * 1024 * 1024) {
            const b64 = fs.readFileSync(localPath).toString("base64");
            return `base64://${b64}`;
          }
          return `file://${localPath}`;
        }
      }
    } catch (_) {}
  }
  const md5 = String(picElement.md5HexStr || "").toUpperCase();
  if (!origin.startsWith("/download") && md5 && /^[0-9A-F]{32}$/.test(md5)) {
    return `https://gchat.qpic.cn/gchatpic_new/0/0-0-${md5}/0?term=2`;
  }
  if (origin.startsWith("/download")) {
    return `https://multimedia.nt.qq.com.cn${origin}`;
  }
  return "";
}

/**
 * Convert NTQQ `ntMsg` (or `{ elements, chatType, peerUid }`) into OneBot v11
 * `{ segments, raw_message }`.
 */
function ntMsgToOneBotSegments(ntMsg, ctx = {}) {
  const elements = Array.isArray(ntMsg) ? ntMsg : Array.isArray(ntMsg?.elements) ? ntMsg.elements : [];
  const chatType = Number(ntMsg?.chatType || ctx.chatType || 1);
  const peerUid = String(ntMsg?.peerUid || ctx.peerUid || "");
  const uinUidStore = ctx.uinUidStore || null;
  const messageIdStore = ctx.messageIdStore || ctx.msgIdStore || null;

  if (uinUidStore && ntMsg && !Array.isArray(ntMsg)) {
    uinUidStore.rememberFromNtMsg(ntMsg);
  }

  const segments = [];
  for (const el of elements) {
    if (!el || typeof el !== "object") continue;
    const elType = Number(el.elementType || 0);

    // 1: textElement (text & @ mentions)
    if (elType === 1 && el.textElement) {
      const te = el.textElement;
      const atType = Number(te.atType || 0);
      if (atType === 1) {
        segments.push({
          type: "at",
          data: {
            qq: "all",
            ...(te.content ? { name: String(te.content).replace(/^@/, "") } : {}),
          },
        });
      } else if (atType === 2) {
        let qq = "";
        if (te.atUid && /^\d+$/.test(String(te.atUid)) && Number(te.atUid) > 0) {
          qq = String(te.atUid);
        } else if (uinUidStore && te.atNtUid) {
          qq = uinUidStore.getUinSync(te.atNtUid);
        }
        if (!qq && te.atNtUid) {
          qq = String(te.atNtUid);
        }
        const name = te.content ? String(te.content).replace(/^@/, "").trim() : "";
        segments.push({
          type: "at",
          data: {
            qq: String(qq || "0"),
            ...(name ? { name } : {}),
          },
        });
      } else {
        const text = String(te.content ?? "");
        if (text !== "") {
          segments.push({
            type: "text",
            data: { text },
          });
        }
      }
      continue;
    }

    // 2: picElement
    if (elType === 2 && el.picElement) {
      const pe = el.picElement;
      const url = buildNtPicUrl(pe, chatType);
      const file =
        pe.fileName ||
        (pe.md5HexStr ? `${String(pe.md5HexStr).toLowerCase()}.jpg` : "") ||
        pe.fileUuid ||
        "image.jpg";
      segments.push({
        type: "image",
        data: {
          file: String(file),
          ...(url ? { url } : {}),
          ...(pe.fileUuid ? { file_id: String(pe.fileUuid) } : {}),
          file_size: String(pe.fileSize ?? 0),
          sub_type: Number(pe.picSubType ?? 0),
          ...(pe.summary ? { summary: String(pe.summary) } : {}),
        },
      });
      continue;
    }

    // 3: fileElement
    if (elType === 3 && el.fileElement) {
      const fe = el.fileElement;
      const fileName = String(fe.fileName || "file");
      const fileId = String(fe.fileUuid || fe.fileBizId || fe.fileMd5 || fileName);
      const fileSize = Number(fe.fileSize || 0);
      segments.push({
        type: "file",
        data: {
          file: fileName,
          name: fileName,
          file_name: fileName,
          file_id: fileId,
          size: fileSize,
          file_size: fileSize,
          ...(fe.fileMd5 ? { file_hash: String(fe.fileMd5) } : {}),
          ...(fe.filePath ? { path: String(fe.filePath) } : {}),
          busid: Number(fe.fileBizId || 102),
        },
      });
      continue;
    }

    // 4: pttElement (voice record)
    if (elType === 4 && el.pttElement) {
      const ptt = el.pttElement;
      const file = String(ptt.fileName || ptt.md5HexStr || ptt.fileUuid || "record.amr");
      segments.push({
        type: "record",
        data: {
          file,
          ...(ptt.filePath ? { path: String(ptt.filePath), url: `file://${ptt.filePath}` } : {}),
          ...(ptt.fileUuid ? { file_id: String(ptt.fileUuid) } : {}),
          file_size: String(ptt.fileSize || 0),
          magic: ptt.voiceChangeType ? "1" : "0",
        },
      });
      continue;
    }

    // 5: videoElement
    if (elType === 5 && el.videoElement) {
      const ve = el.videoElement;
      const file = String(ve.fileName || ve.videoMd5 || ve.fileUuid || "video.mp4");
      segments.push({
        type: "video",
        data: {
          file,
          ...(ve.filePath ? { path: String(ve.filePath), url: `file://${ve.filePath}` } : {}),
          ...(ve.fileUuid ? { file_id: String(ve.fileUuid) } : {}),
          file_size: String(ve.fileSize || 0),
        },
      });
      continue;
    }

    // 6: faceElement (standard emoji, dice, rps, poke)
    if (elType === 6 && el.faceElement) {
      const face = el.faceElement;
      const idx = Number(face.faceIndex ?? 0);
      if (face.pokeType !== undefined && face.pokeType !== null && Number(face.faceType) === 5) {
        segments.push({
          type: "poke",
          data: {
            type: String(face.pokeType),
            id: String(face.vasPokeId ?? 0),
            ...(face.vasPokeName ? { name: String(face.vasPokeName) } : {}),
          },
        });
      } else if (idx === 358 || (Number(face.faceType) === 4 && String(face.faceText || "").includes("骰子"))) {
        segments.push({
          type: "dice",
          data: { result: String(face.resultId || "1") },
        });
      } else if (idx === 359 || (Number(face.faceType) === 4 && String(face.faceText || "").includes("猜拳"))) {
        segments.push({
          type: "rps",
          data: { result: String(face.resultId || "1") },
        });
      } else {
        segments.push({
          type: "face",
          data: { id: String(idx) },
        });
      }
      continue;
    }

    // 7: replyElement
    if (elType === 7 && el.replyElement) {
      const re = el.replyElement;
      const rawReplyMsgId =
        re.replayMsgId && String(re.replayMsgId) !== "0"
          ? String(re.replayMsgId)
          : re.sourceMsgIdInRecords && String(re.sourceMsgIdInRecords) !== "0"
          ? String(re.sourceMsgIdInRecords)
          : "";
      const rawReplySeq =
        re.replayMsgSeq && String(re.replayMsgSeq) !== "0" ? String(re.replayMsgSeq) : "";

      let resolvedShortId = null;
      if (messageIdStore) {
        if (rawReplyMsgId) {
          const hit = messageIdStore.getByMsgId(rawReplyMsgId);
          if (hit) resolvedShortId = hit.shortId;
        }
        if (!resolvedShortId && rawReplySeq && peerUid) {
          const hit = messageIdStore.getByPeerAndSeq(chatType, peerUid, rawReplySeq);
          if (hit) resolvedShortId = hit.shortId;
        }
        if (!resolvedShortId && (rawReplyMsgId || rawReplySeq)) {
          resolvedShortId = messageIdStore.register(
            rawReplyMsgId || `seq_${chatType}_${peerUid}_${rawReplySeq}`,
            { chatType, peerUid, guildId: "" },
            rawReplySeq || "0",
            {
              senderUin: re.senderUid ? String(re.senderUid) : "",
              senderUid: re.senderUidStr ? String(re.senderUidStr) : "",
              msgTime: Number(re.replyMsgTime || 0),
            }
          );
        }
      }
      const replyId = resolvedShortId || rawReplyMsgId || rawReplySeq || "0";
      segments.push({
        type: "reply",
        data: { id: String(replyId) },
      });
      continue;
    }

    // 8: grayTipElement (only include if it carries text inside a normal message; system notices are handled separately)
    if (elType === 8 && el.grayTipElement) {
      continue;
    }

    // 10: arkElement (JSON card)
    if (elType === 10 && el.arkElement) {
      const bytesData = el.arkElement.bytesData || "";
      if (bytesData) {
        segments.push({
          type: "json",
          data: { data: String(bytesData) },
        });
      }
      continue;
    }

    // 11: marketFaceElement (mall sticker)
    if (elType === 11 && el.marketFaceElement) {
      const mf = el.marketFaceElement;
      segments.push({
        type: "mface",
        data: {
          emoji_id: String(mf.emojiId || ""),
          emoji_package_id: String(mf.emojiPackageId || ""),
          key: String(mf.key || ""),
          summary: String(mf.faceName || "[商城表情]"),
          ...(mf.url ? { url: String(mf.url) } : {}),
        },
      });
      continue;
    }

    // 16: multiForwardMsgElement (merged forward message)
    if (elType === 16 && el.multiForwardMsgElement) {
      const fwd = el.multiForwardMsgElement;
      const resId = String(fwd.resId || ntMsg?.msgId || "");
      segments.push({
        type: "forward",
        data: {
          id: resId,
          ...(fwd.xmlContent ? { content: String(fwd.xmlContent) } : {}),
        },
      });
      continue;
    }
  }

  return {
    segments,
    raw_message: segmentsToCqCode(segments),
  };
}

/**
 * Convert OneBot v11 message (array of segments or CQ-code string) into NTQQ
 * `msgElements` array ready for `nodeIKernelMsgService/sendMsg`.
 */
async function oneBotSegmentsToNtElements(message, ctx = {}) {
  const segments = normalizeOneBotMessage(message, Boolean(ctx.autoEscape));
  const uinUidStore = ctx.uinUidStore || null;
  const messageIdStore = ctx.messageIdStore || ctx.msgIdStore || null;
  const invokeNt = ctx.invokeNt || null;
  const elements = [];
  const sideEffects = [];
  const cleanupCallbacks = [];
  const tempFiles = [];

  function trackTempMedia(media) {
    if (media && media.isTempFile && media.localPath) {
      const tempPath = media.localPath;
      tempFiles.push(tempPath);
      cleanupCallbacks.push(() => {
        try {
          if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
          }
        } catch (_) {}
      });
    }
  }

  for (const seg of segments) {
    const type = String(seg.type || "");
    const data = seg.data && typeof seg.data === "object" ? seg.data : {};

    if (type === "text") {
      const content = String(data.text ?? "");
      if (content !== "") {
        elements.push({
          elementType: 1,
          elementId: "",
          textElement: {
            content,
            atType: 0,
            atUid: "",
            atTinyId: "",
            atNtUid: "",
          },
        });
      }
      continue;
    }

    if (type === "at") {
      const qq = String(data.qq ?? data.id ?? "").trim();
      if (qq === "all" || qq === "0") {
        const display = data.name
          ? String(data.name).startsWith("@")
            ? String(data.name)
            : `@${data.name}`
          : "@全体成员";
        elements.push({
          elementType: 1,
          elementId: "",
          textElement: {
            content: display,
            atType: 1,
            atUid: "0",
            atTinyId: "",
            atNtUid: "all",
          },
        });
      } else if (qq) {
        let uid = "";
        if (typeof ctx.resolveUid === "function") {
          uid = await ctx.resolveUid(qq);
        } else if (uinUidStore) {
          uid = await uinUidStore.resolveUid(qq, invokeNt);
        }
        let displayName = data.name ? String(data.name).replace(/^@/, "") : "";
        if (!displayName && uinUidStore) {
          const gKey = ctx.groupId ? `${ctx.groupId}:${qq}` : "";
          const gMeta = gKey ? uinUidStore.groupMemberMeta.get(gKey) : null;
          const uMeta = uinUidStore.userMeta.get(qq);
          displayName = gMeta?.card || gMeta?.nickname || uMeta?.nickname || qq;
        }
        if (!displayName) displayName = qq;
        elements.push({
          elementType: 1,
          elementId: "",
          textElement: {
            content: `@${displayName}`,
            atType: 2,
            atUid: qq,
            atTinyId: "",
            atNtUid: String(uid || ""),
          },
        });
      }
      continue;
    }

    if (type === "reply") {
      const rawId = data.id ?? data.message_id;
      let entry = null;
      if (messageIdStore && rawId !== undefined && rawId !== null) {
        entry = messageIdStore.getByShortId(rawId) || messageIdStore.getByMsgId(rawId);
      }
      const replayMsgId = entry?.msgId && /^\d+$/.test(String(entry.msgId)) ? String(entry.msgId) : "0";
      const replayMsgSeq = String(entry?.msgSeq || data.seq || "0");
      const senderUin = String(entry?.senderUin || data.qq || "0");
      const senderUid = String(entry?.senderUid || (uinUidStore ? uinUidStore.getUidSync(senderUin) : "") || "");
      elements.push({
        elementType: 7,
        elementId: "",
        replyElement: {
          replayMsgId,
          replayMsgSeq,
          replayMsgRootSeq: "0",
          replayMsgRootMsgId: "0",
          replayMsgRootCommentCnt: "0",
          sourceMsgIdInRecords: replayMsgId,
          sourceMsgText: "",
          senderUid: senderUin,
          senderUidStr: senderUid,
          replyMsgClientSeq: "0",
          replyMsgTime: String(entry?.msgTime || Math.floor(Date.now() / 1000)),
          replyMsgRevokeType: 0,
          sourceMsgTextElems: [],
          sourceMsgIsIncPic: false,
          sourceMsgExpired: false,
        },
      });
      continue;
    }

    if (type === "face") {
      const faceIndex = Number(data.id ?? 0);
      elements.push({
        elementType: 6,
        elementId: "",
        faceElement: {
          faceIndex,
          faceType: faceIndex >= 1000 ? 2 : 1,
          faceText: data.text ? String(data.text) : "",
          imageType: 0,
          packId: "0",
          stickerId: "0",
          sourceType: 0,
          stickerType: 0,
          resultId: "",
          surpriseId: "",
          randomType: 1,
        },
      });
      continue;
    }

    if (type === "dice" || type === "rps") {
      const isDice = type === "dice";
      elements.push({
        elementType: 6,
        elementId: "",
        faceElement: {
          faceIndex: isDice ? 358 : 359,
          faceType: 4,
          faceText: isDice ? "[骰子]" : "[包剪锤]",
          imageType: 0,
          packId: "1",
          stickerId: isDice ? "33" : "34",
          sourceType: 1,
          stickerType: 2,
          resultId: data.result ? String(data.result) : "",
          surpriseId: "",
          randomType: 1,
        },
      });
      continue;
    }

    if (type === "mface" || type === "marketface") {
      elements.push({
        elementType: 11,
        elementId: "",
        marketFaceElement: {
          itemType: 6,
          faceInfo: 1,
          emojiPackageId: Number(data.emoji_package_id || data.tab_id || 0),
          subType: 3,
          faceName: String(data.summary || "[商城表情]"),
          emojiId: String(data.emoji_id || ""),
          key: String(data.key || ""),
          staticFacePath: "",
          dynamicFacePath: "",
        },
      });
      continue;
    }

    if (type === "image") {
      const src = data.file || data.url || data.path;
      const media =
        typeof ctx.resolveMediaSource === "function"
          ? await ctx.resolveMediaSource(src, { kind: "image" })
          : await resolveMediaSource(src, { tempDir: ctx.tempDir });
      trackTempMedia(media);
      const subType = Number(data.sub_type ?? data.subType ?? 0);
      let finalPath = media.localPath;
      let md5HexStr = media.md5HexStr;
      let fileSize = media.fileSize;
      let fileName = media.fileName;
      if (typeof ctx.prepareNtImagePath === "function") {
        const prepared = await ctx.prepareNtImagePath(media, subType);
        if (prepared && typeof prepared === "object") {
          if (prepared.localPath) finalPath = String(prepared.localPath);
          if (prepared.md5HexStr) md5HexStr = String(prepared.md5HexStr);
          if (prepared.fileSize) fileSize = Number(prepared.fileSize);
          if (prepared.fileName) fileName = String(prepared.fileName);
        } else if (typeof prepared === "string" && prepared) {
          finalPath = prepared;
        }
      }
      const extLower = path.extname(fileName || finalPath || "").toLowerCase();
      const picType = media.isGif || extLower === ".gif"
        ? 2000
        : extLower === ".png"
        ? 1001
        : extLower === ".webp"
        ? 1002
        : extLower === ".bmp"
        ? 1005
        : 1000;
      elements.push({
        elementType: 2,
        elementId: "",
        picElement: {
          md5HexStr,
          fileSize: String(fileSize),
          picWidth: media.width || 512,
          picHeight: media.height || 512,
          fileName,
          sourcePath: finalPath,
          original: true,
          picType,
          picSubType: subType,
          thumbPath: new Map(),
          fileUuid: "",
          fileSubId: "",
          thumbFileSize: 0,
          summary: data.summary ? String(data.summary) : subType === 1 ? "[动画表情]" : "",
        },
      });
      continue;
    }

    if (type === "record") {
      const src = data.file || data.url || data.path;
      const media =
        typeof ctx.resolveMediaSource === "function"
          ? await ctx.resolveMediaSource(src, { kind: "record", preferredExt: ".amr" })
          : await resolveMediaSource(src, { tempDir: ctx.tempDir, preferredExt: ".amr" });
      trackTempMedia(media);
      let finalPath = media.localPath;
      let duration = Math.max(1, Number(data.duration || 3));
      if (typeof ctx.prepareNtRecordPath === "function") {
        const prepared = await ctx.prepareNtRecordPath(media);
        if (prepared && typeof prepared === "object") {
          if (prepared.localPath) finalPath = prepared.localPath;
          if (prepared.duration) duration = prepared.duration;
        } else if (typeof prepared === "string") {
          finalPath = prepared;
        }
      }
      elements.push({
        elementType: 4,
        elementId: "",
        pttElement: {
          fileName: path.basename(finalPath),
          filePath: finalPath,
          md5HexStr: media.md5HexStr,
          fileSize: String(media.fileSize),
          duration,
          formatType: 1,
          voiceType: 1,
          voiceChangeType: Number(data.magic || 0),
          canConvert2Text: true,
          fileId: 0,
          fileUuid: "",
          text: "",
          waveAmplitudes: [18, 42, 65, 51, 33, 72, 48, 25],
        },
      });
      continue;
    }

    if (type === "video") {
      const src = data.file || data.url || data.path;
      const media =
        typeof ctx.resolveMediaSource === "function"
          ? await ctx.resolveMediaSource(src, { kind: "video", preferredExt: ".mp4" })
          : await resolveMediaSource(src, { tempDir: ctx.tempDir, preferredExt: ".mp4" });
      trackTempMedia(media);
      elements.push({
        elementType: 5,
        elementId: "",
        videoElement: {
          filePath: media.localPath,
          fileName: media.fileName,
          videoMd5: media.md5HexStr,
          thumbMd5: "",
          fileTime: Number(data.duration || 5),
          thumbSize: 0,
          fileFormat: 2,
          fileSize: String(media.fileSize),
          thumbWidth: 480,
          thumbHeight: 270,
          busiType: 0,
          subBusiType: 0,
          thumbPath: new Map(),
          transferStatus: 0,
          progress: 0,
          invalidState: 0,
          fileUuid: "",
          fileSubId: "",
          fileBizId: null,
        },
      });
      continue;
    }

    if (type === "file") {
      const src = data.file || data.url || data.path;
      const preferredName = data.name || data.file_name || undefined;
      const media =
        typeof ctx.resolveMediaSource === "function"
          ? await ctx.resolveMediaSource(src, { kind: "file", preferredName })
          : await resolveMediaSource(src, { tempDir: ctx.tempDir, preferredName });
      trackTempMedia(media);
      elements.push({
        elementType: 3,
        elementId: "",
        fileElement: {
          fileMd5: media.md5HexStr,
          fileName: preferredName || media.fileName,
          filePath: media.localPath,
          fileSize: String(media.fileSize),
          picHeight: 0,
          picWidth: 0,
          picThumbPath: new Map(),
          expireTime: "0",
          file10MMd5: "",
          fileSha: "",
          fileSha3: "",
          videoDuration: 0,
          transferStatus: 0,
          progress: 0,
          invalidState: 0,
          fileUuid: "",
          fileSubId: "",
          thumbFileSize: 0,
          fileBizId: null,
        },
      });
      continue;
    }

    if (type === "json") {
      const jsonStr =
        typeof data.data === "string" ? data.data : JSON.stringify(data.data || {});
      elements.push({
        elementType: 10,
        elementId: "",
        arkElement: {
          bytesData: jsonStr,
          linkInfo: null,
          subElementType: null,
        },
      });
      continue;
    }

    if (type === "poke") {
      const targetQq = data.qq || data.id || data.user_id;
      sideEffects.push({
        type: "poke",
        qq: targetQq ? Number(targetQq) : undefined,
        pokeType: Number(data.type || 1),
        pokeId: Number(data.id || 1),
      });
      continue;
    }
  }

  const pokeTargets = sideEffects.filter((s) => s.type === "poke");
  return { elements, sideEffects, pokeTargets, cleanupCallbacks, tempFiles };
}

// ============================================================================
// 6. NTQQ Event -> OneBot v11 Event Formatters
// ============================================================================

function mapNtRoleToOneBot(roleVal) {
  if (roleVal === "owner" || roleVal === 4 || roleVal === 1) return "owner";
  if (roleVal === "admin" || roleVal === 3 || roleVal === 2) return "admin";
  return "member";
}

function parseGrayTipEvent(ntMsg, el, ctx = {}) {
  const gt = el.grayTipElement;
  if (!gt) return null;
  const selfId = Number(ctx.selfId || 0);
  const time = Number(ntMsg.msgTime || Math.floor(Date.now() / 1000));
  const isGroup = Number(ntMsg.chatType) === 2;
  const groupId = isGroup ? Number(ntMsg.peerUid || ntMsg.peerUin || 0) : 0;
  const uinUidStore = ctx.uinUidStore || null;
  const messageIdStore = ctx.messageIdStore || ctx.msgIdStore || null;

  // 1. Revoke / recall
  if (gt.revokeElement) {
    const rev = gt.revokeElement;
    const opUid = rev.operatorUid || ntMsg.senderUid || "";
    const origUid = rev.origMsgSenderUid || ntMsg.senderUid || "";
    const opUin =
      Number(rev.operatorUin || (uinUidStore ? uinUidStore.getUinSync(opUid) : "") || ntMsg.senderUin || 0);
    const origUin =
      Number(rev.origMsgSenderUin || (uinUidStore ? uinUidStore.getUinSync(origUid) : "") || ntMsg.senderUin || opUin || 0);
    let shortId = 0;
    if (messageIdStore) {
      const hit =
        messageIdStore.getByMsgId(ntMsg.msgId) ||
        messageIdStore.getByPeerAndSeq(ntMsg.chatType, ntMsg.peerUid, ntMsg.msgSeq);
      if (hit) shortId = hit.shortId;
    }
    if (!shortId && ntMsg.msgId) {
      shortId = messageIdStore
        ? messageIdStore.register(ntMsg.msgId, { chatType: ntMsg.chatType, peerUid: ntMsg.peerUid }, ntMsg.msgSeq)
        : Number(String(ntMsg.msgId).slice(-9));
    }
    if (isGroup) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_recall",
        group_id: groupId,
        user_id: origUin,
        operator_id: opUin || origUin,
        message_id: shortId,
      };
    }
    return {
      time,
      self_id: selfId,
      post_type: "notice",
      notice_type: "friend_recall",
      user_id: origUin || Number(ntMsg.peerUin || 0),
      message_id: shortId,
    };
  }

  // 2. XML / JSON gray tip (poke, essence, etc.)
  const xmlContent = gt.xmlElement?.content || gt.jsonGrayTipElement?.jsonStr || "";
  const busiId = String(gt.xmlElement?.busiId || gt.jsonGrayTipElement?.busiId || "");
  const templMap =
    gt.xmlElement?.templParam instanceof Map
      ? gt.xmlElement.templParam
      : gt.jsonGrayTipElement?.xmlToJsonParam?.templParam instanceof Map
      ? gt.jsonGrayTipElement.xmlToJsonParam.templParam
      : null;
  if (
    busiId === "1061" ||
    xmlContent.includes("poke") ||
    xmlContent.includes("戳了戳") ||
    (templMap && templMap.has("uin_str1"))
  ) {
    let fromUin = 0;
    let toUin = 0;
    if (templMap) {
      fromUin = Number(templMap.get("uin_str1") || 0);
      toUin = Number(templMap.get("uin_str2") || 0);
    }
    if (!fromUin || !toUin) {
      const uinMatches = [...xmlContent.matchAll(/(?:uin|qq|jp)="?(\d{5,12})"?/gi)].map((m) => Number(m[1]));
      if (uinMatches.length >= 2) {
        fromUin = uinMatches[0];
        toUin = uinMatches[1];
      } else if (uinMatches.length === 1) {
        fromUin = uinMatches[0];
        toUin = selfId;
      }
    }
    if (!fromUin && ntMsg.senderUin) fromUin = Number(ntMsg.senderUin);
    if (!toUin) toUin = selfId;
    if (fromUin > 0 && toUin > 0) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "notify",
        sub_type: "poke",
        user_id: fromUin,
        sender_id: fromUin,
        target_id: toUin,
        ...(isGroup && groupId ? { group_id: groupId } : {}),
        event_id: String(ntMsg.msgId || ntMsg.msgSeq || `${time}_${fromUin}_${toUin}`),
      };
    }
  }

  // Essence message grayTip (busiId 2401 / 2407)
  if ((busiId === "2401" || busiId === "2407" || xmlContent.includes("精华消息")) && isGroup) {
    return {
      time,
      self_id: selfId,
      post_type: "notice",
      notice_type: "essence",
      sub_type: xmlContent.includes("移出") ? "delete" : "add",
      group_id: groupId,
      sender_id: Number(ntMsg.senderUin || 0),
      operator_id: Number(ntMsg.senderUin || 0),
      message_id: Number(ntMsg.msgSeq || 0),
    };
  }

  // 3. Group element (increase, decrease, ban, admin)
  if (gt.groupElement && isGroup) {
    const ge = gt.groupElement;
    const gType = Number(ge.type || 0);
    const memberUin = Number(
      ge.memberUin || (uinUidStore && ge.memberUid ? uinUidStore.getUinSync(ge.memberUid) : 0) || 0
    );
    const adminUin = Number(
      ge.adminUin || (uinUidStore && ge.adminUid ? uinUidStore.getUinSync(ge.adminUid) : 0) || 0
    );
    if (gType === 1) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_increase",
        sub_type: adminUin ? "invite" : "approve",
        group_id: groupId,
        operator_id: adminUin || memberUin,
        user_id: memberUin,
      };
    }
    if (gType === 2 || gType === 3) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_decrease",
        sub_type: memberUin === selfId ? "kick_me" : gType === 3 ? "kick" : "leave",
        group_id: groupId,
        operator_id: adminUin || memberUin,
        user_id: memberUin,
      };
    }
    if (gType === 4 || gType === 8) {
      const shutUp = ge.shutUp;
      const duration = Number(shutUp?.duration ?? (gType === 8 ? 0 : 1800));
      const targetUid = shutUp?.member?.uid || ge.memberUid || "";
      const targetUin = Number(
        shutUp?.member?.uin || (uinUidStore && targetUid ? uinUidStore.getUinSync(targetUid) : 0) || memberUin || 0
      );
      const opUid = shutUp?.admin?.uid || ge.adminUid || "";
      const opUin = Number(
        shutUp?.admin?.uin || (uinUidStore && opUid ? uinUidStore.getUinSync(opUid) : 0) || adminUin || 0
      );
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_ban",
        sub_type: duration > 0 ? "ban" : "lift_ban",
        group_id: groupId,
        operator_id: opUin,
        user_id: targetUin,
        duration,
      };
    }
    if (gType === 5) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_admin",
        sub_type: ge.isAdmin === false ? "unset" : "set",
        group_id: groupId,
        user_id: memberUin,
      };
    }
  }

  // 4. New friend added gray tip
  if (
    !isGroup &&
    (xmlContent.includes("你们已经成为好友") ||
      xmlContent.includes("已添加你为好友") ||
      gt.buddyElement)
  ) {
    const uin = Number(
      ntMsg.peerUin ||
        ntMsg.senderUin ||
        (uinUidStore && ntMsg.peerUid ? uinUidStore.getUinSync(ntMsg.peerUid) : 0) ||
        0
    );
    if (uin > 0) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "friend_add",
        user_id: uin,
      };
    }
  }

  return null;
}

/**
 * Format an NTQQ `RawMessage` into a OneBot v11 Event (or array of events when a
 * group file message also emits a `group_upload` notice).
 */
function formatNtMsgToOneBotEvent(ntMsg, ctx = {}) {
  if (!ntMsg || typeof ntMsg !== "object") return null;
  const selfId = Number(ctx.selfId || 0);
  const time = Number(ntMsg.msgTime || Math.floor(Date.now() / 1000));
  const chatType = Number(ntMsg.chatType || 1);
  const isGroup = chatType === 2;
  const uinUidStore = ctx.uinUidStore || null;
  const messageIdStore = ctx.messageIdStore || ctx.msgIdStore || null;

  if (uinUidStore) {
    uinUidStore.rememberFromNtMsg(ntMsg);
  }

  // Check if this message was recalled (onMsgInfoListUpdate with recallTime > 0)
  if (ntMsg.recallTime && String(ntMsg.recallTime) !== "0" && Number(ntMsg.recallTime) > 0) {
    const revEl = Array.isArray(ntMsg.elements)
      ? ntMsg.elements.find((e) => e?.grayTipElement?.revokeElement)
      : null;
    if (revEl) {
      return parseGrayTipEvent(ntMsg, revEl, ctx);
    }
    const senderUin = Number(
      ntMsg.senderUin || (uinUidStore && ntMsg.senderUid ? uinUidStore.getUinSync(ntMsg.senderUid) : 0) || 0
    );
    const shortId = messageIdStore
      ? (messageIdStore.getByMsgId(ntMsg.msgId)?.shortId ||
          messageIdStore.register(ntMsg.msgId, { chatType, peerUid: ntMsg.peerUid }, ntMsg.msgSeq))
      : Number(String(ntMsg.msgId || 1).slice(-9));
    if (isGroup) {
      return {
        time,
        self_id: selfId,
        post_type: "notice",
        notice_type: "group_recall",
        group_id: Number(ntMsg.peerUid || ntMsg.peerUin || 0),
        user_id: senderUin,
        operator_id: senderUin,
        message_id: shortId,
      };
    }
    return {
      time,
      self_id: selfId,
      post_type: "notice",
      notice_type: "friend_recall",
      user_id: senderUin || Number(ntMsg.peerUin || 0),
      message_id: shortId,
    };
  }

  // Check if message is a system grayTip notice (msgType === 5 or only grayTipElement)
  if (Array.isArray(ntMsg.elements)) {
    for (const el of ntMsg.elements) {
      if (el?.elementType === 8 && el.grayTipElement) {
        const noticeEv = parseGrayTipEvent(ntMsg, el, ctx);
        if (noticeEv) return noticeEv;
      }
    }
  }

  let senderUin = String(ntMsg.senderUin || "");
  if ((!senderUin || senderUin === "0") && uinUidStore && ntMsg.senderUid) {
    senderUin = uinUidStore.getUinSync(ntMsg.senderUid);
  }
  const groupId = isGroup ? String(ntMsg.peerUid || ntMsg.peerUin || "") : "";
  const peerUid = String(ntMsg.peerUid || (isGroup ? groupId : ntMsg.senderUid || ""));

  const { segments, raw_message } = ntMsgToOneBotSegments(ntMsg, ctx);
  if (segments.length === 0 && Number(ntMsg.msgType) === 5) {
    return null;
  }

  const isSelf = Boolean(selfId && Number(senderUin) === selfId);
  const senderRole = mapNtRoleToOneBot(
    ntMsg.roleType ??
      ntMsg.senderRole ??
      (isGroup && uinUidStore
        ? uinUidStore.groupMemberMeta.get(`${groupId}:${senderUin}`)?.role
        : "member")
  );

  const sender = isGroup
    ? {
        user_id: Number(senderUin || 0),
        nickname: String(ntMsg.sendNickName || ""),
        card: String(ntMsg.sendMemberName || ""),
        role: senderRole,
        title: String(ntMsg.sendMemberTitle || ""),
      }
    : {
        user_id: Number(senderUin || 0),
        nickname: String(ntMsg.sendNickName || ""),
        sex: "unknown",
        age: 0,
      };

  const shortId = messageIdStore
    ? messageIdStore.register(
        ntMsg.msgId,
        { chatType, peerUid, guildId: String(ntMsg.guildId || "") },
        ntMsg.msgSeq,
        {
          senderUin,
          senderUid: ntMsg.senderUid || "",
          groupId,
          msgTime: time,
          rawMsg: ntMsg,
        }
      )
    : Number(String(ntMsg.msgId || 1).slice(-9)) || 1;

  const event = {
    time,
    self_id: selfId,
    post_type: isSelf && !ctx.reportSelfMessage ? "message_sent" : "message",
    message_type: isGroup ? "group" : "private",
    sub_type: isGroup ? "normal" : chatType === 100 ? "group" : "friend",
    message_id: shortId,
    user_id: Number(senderUin || 0),
    ...(isGroup ? { group_id: Number(groupId || 0), anonymous: null } : {}),
    message: ctx.messageFormat === "string" ? raw_message : segments,
    raw_message,
    font: 0,
    sender,
  };

  if (messageIdStore) {
    const entry = messageIdStore.getByShortId(shortId);
    if (entry) entry.oneBotEvent = event;
  }

  return event;
}

function formatGroupUploadNotice(ntMsg, ctx = {}) {
  if (!ntMsg || Number(ntMsg.chatType) !== 2 || !Array.isArray(ntMsg.elements)) return null;
  const fileEl = ntMsg.elements.find((e) => e?.elementType === 3 && e.fileElement)?.fileElement;
  if (!fileEl) return null;
  const selfId = Number(ctx.selfId || 0);
  const time = Number(ntMsg.msgTime || Math.floor(Date.now() / 1000));
  const uinUidStore = ctx.uinUidStore || null;
  const senderUin = Number(
    ntMsg.senderUin || (uinUidStore && ntMsg.senderUid ? uinUidStore.getUinSync(ntMsg.senderUid) : 0) || 0
  );
  return {
    time,
    self_id: selfId,
    post_type: "notice",
    notice_type: "group_upload",
    group_id: Number(ntMsg.peerUid || ntMsg.peerUin || 0),
    user_id: senderUin,
    file: {
      id: String(fileEl.fileUuid || fileEl.fileBizId || fileEl.fileMd5 || ""),
      name: String(fileEl.fileName || "file"),
      size: Number(fileEl.fileSize || 0),
      busid: Number(fileEl.fileBizId || 102),
    },
  };
}

function formatNoticeEvent(noticeType, payload = {}, ctx = {}) {
  const selfId = Number(ctx.selfId ?? payload.self_id ?? 0);
  const time = Number(payload.time || Math.floor(Date.now() / 1000));
  const base = {
    time,
    self_id: selfId,
    post_type: "notice",
    notice_type: noticeType,
  };
  return { ...base, ...payload, time, self_id: selfId, post_type: "notice", notice_type: noticeType };
}

function formatRequestEvent(requestType, payload = {}, ctx = {}) {
  const selfId = Number(ctx.selfId ?? payload.self_id ?? 0);
  const time = Number(payload.time || Math.floor(Date.now() / 1000));
  if (requestType === "friend") {
    return {
      time,
      self_id: selfId,
      post_type: "request",
      request_type: "friend",
      user_id: Number(payload.user_id || 0),
      comment: String(payload.comment || ""),
      flag: String(payload.flag || ""),
    };
  }
  return {
    time,
    self_id: selfId,
    post_type: "request",
    request_type: "group",
    sub_type: String(payload.sub_type || "add"),
    group_id: Number(payload.group_id || 0),
    user_id: Number(payload.user_id || 0),
    comment: String(payload.comment || ""),
    flag: String(payload.flag || ""),
  };
}

function formatMetaEvent(metaEventType, payload = {}, ctx = {}) {
  const selfId = Number(ctx.selfId ?? payload.self_id ?? 0);
  const time = Number(payload.time || Math.floor(Date.now() / 1000));
  if (metaEventType === "lifecycle") {
    return {
      time,
      self_id: selfId,
      post_type: "meta_event",
      meta_event_type: "lifecycle",
      sub_type: String(payload.sub_type || "connect"),
    };
  }
  return {
    time,
    self_id: selfId,
    post_type: "meta_event",
    meta_event_type: "heartbeat",
    status: payload.status || { online: true, good: true },
    interval: Number(payload.interval || 5000),
  };
}

module.exports = {
  MessageIdStore,
  UinUidStore,
  escapeCqText,
  unescapeCqText,
  escapeCqParam,
  segmentsToCqCode,
  parseCqCodeToSegments,
  normalizeOneBotMessage,
  inspectImageDimensions,
  getNtqqVersionMetadata,
  buildNtqqUserAgent,
  pruneTempDir,
  resolveMediaSource,
  buildNtPicUrl,
  ntMsgToOneBotSegments,
  oneBotSegmentsToNtElements,
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
  formatMetaEvent,
};
