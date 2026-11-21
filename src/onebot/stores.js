// @ts-check
"use strict";

/**
 * Bounded LRU Protocol Stores (`src/onebot/stores.js`)
 *
 * Provides `MessageIdStore` (31-bit OneBot `message_id` <-> NTQQ 64-bit `msgId`
 * + media/forward index) and `UinUidStore` (bi-directional QQ UIN <-> NTQQ UID
 * & profile metadata cache) with debounced atomic snapshot persistence.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * @typedef {object} PersistBatch
 * @property {string} filePath
 * @property {Promise<boolean>} promise
 * @property {(value: boolean) => void} resolve
 * @property {(reason?: any) => void} reject
 */

/**
 * @typedef {object} PersistState
 * @property {boolean} enabled
 * @property {string} filePath
 * @property {number} debounceMs
 * @property {ReturnType<typeof setTimeout> | null} timer
 * @property {boolean} dirty
 * @property {boolean} running
 * @property {PersistBatch | null} pendingBatch
 * @property {PersistBatch[]} queue
 */

/**
 * @typedef {{ debug?: (scope: string, err?: any) => any }} StoreLogger
 */

/**
 * Lazily retrieves `buildNtMarketFaceUrl` from `./segment_converter` to avoid
 * a load-order circular require (`segment_converter.js` imports `stores.js`).
 *
 * @param {any} marketFaceElement
 * @returns {string}
 */
function _resolveMarketFaceUrl(marketFaceElement) {
  const { buildNtMarketFaceUrl } = require("./segment_converter");
  return buildNtMarketFaceUrl(marketFaceElement);
}

/**
 * Returns the first positive integer UIN among `candidates`, or `0` if none match.
 *
 * @param {...any} candidates
 * @returns {number}
 */
function pickPositiveUin(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined || c === "" || typeof c === "boolean") continue;
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) {
      const t = Math.trunc(n);
      if (t > 0) return t;
    }
  }
  return 0;
}

/**
 * @returns {PersistState}
 */
function createPersistState() {
  return {
    enabled: false,
    filePath: "",
    debounceMs: 2000,
    timer: null,
    dirty: false,
    running: false,
    pendingBatch: null,
    queue: [],
  };
}

/**
 * @param {string} filePath
 * @param {() => Record<string, any>} getSnapshot
 * @param {StoreLogger | null} [logger=null]
 * @returns {Promise<void>}
 */
async function atomicWriteSnapshot(filePath, getSnapshot, logger = null) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const payload = JSON.stringify(getSnapshot());
  try {
    await fs.promises.writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    try {
      await fs.promises.rename(tmpPath, filePath);
    } catch (/** @type {any} */ renameErr) {
      if (
        renameErr &&
        (renameErr.code === "EEXIST" ||
          renameErr.code === "EPERM" ||
          renameErr.code === "EACCES")
      ) {
        try {
          await fs.promises.unlink(filePath);
        } catch (/** @type {any} */ unlinkErr) {
          if (unlinkErr && unlinkErr.code !== "ENOENT") {
            throw renameErr;
          }
        }
        await fs.promises.rename(tmpPath, filePath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    try {
      await fs.promises.unlink(tmpPath);
    } catch (cleanupErr) {
      // Best-effort removal of orphaned temp snapshot file
      logger?.debug?.("stores:cleanupTempSnapshot", cleanupErr);
    }
    throw err;
  }
}

/**
 * @param {PersistState} state
 * @param {() => Record<string, any>} getSnapshot
 * @param {StoreLogger | null} [logger=null]
 * @returns {Promise<void>}
 */
async function drainPersistQueue(state, getSnapshot, logger = null) {
  if (state.running) return;
  state.running = true;
  try {
    while (state.queue.length > 0) {
      const batch = state.queue.shift();
      if (!batch) continue;
      if (state.pendingBatch === batch) {
        state.pendingBatch = null;
      }
      try {
        await atomicWriteSnapshot(batch.filePath, getSnapshot, logger);
        batch.resolve(true);
      } catch (err) {
        batch.reject(err);
      }
    }
  } finally {
    state.running = false;
  }
}

/**
 * @param {PersistState} state
 * @param {string} filePath
 * @param {() => Record<string, any>} getSnapshot
 * @param {StoreLogger | null} [logger=null]
 * @returns {Promise<boolean>}
 */
function enqueueCoalescedSave(state, filePath, getSnapshot, logger = null) {
  const targetPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!targetPath) {
    return Promise.reject(new Error("saveToFile requires a non-empty filePath"));
  }
  if (state.running && state.pendingBatch && state.pendingBatch.filePath === targetPath) {
    return state.pendingBatch.promise;
  }
  /** @type {(value: boolean) => void} */
  let resolveBatch = () => {};
  /** @type {(reason?: any) => void} */
  let rejectBatch = () => {};
  const promise = new Promise((resolve, reject) => {
    resolveBatch = resolve;
    rejectBatch = reject;
  });
  /** @type {PersistBatch} */
  const batch = {
    filePath: targetPath,
    promise,
    resolve: resolveBatch,
    reject: rejectBatch,
  };
  state.queue.push(batch);
  if (state.running) {
    state.pendingBatch = batch;
  } else {
    drainPersistQueue(state, getSnapshot, logger);
  }
  return promise;
}

// ============================================================================
// 1. MessageIdStore (Bounded LRU, 32-bit positive integer OneBot message_id)
// ============================================================================

class MessageIdStore {
  /**
   * @param {number | Record<string, any>} [maxEntries=10000]
   * @param {number} [maxRawEntries=256]
   * @param {number | Record<string, any>} [options={}]
   */
  constructor(maxEntries = 10000, maxRawEntries = 256, options = {}) {
    /** @type {number | Record<string, any>} */
    let resolvedMaxEntries = maxEntries;
    /** @type {number} */
    let resolvedMaxRaw = maxRawEntries;
    /** @type {number | Record<string, any>} */
    let resolvedOptions = options;
    if (resolvedMaxEntries && typeof resolvedMaxEntries === "object") {
      resolvedOptions = resolvedMaxEntries;
      resolvedMaxEntries = resolvedOptions.maxEntries ?? 10000;
      resolvedMaxRaw = resolvedOptions.maxRawEntries ?? 256;
    }
    this.maxEntries = Math.max(2, Number(resolvedMaxEntries) || 10000);
    const parsedMaxRaw =
      resolvedMaxRaw !== undefined && resolvedMaxRaw !== null ? Number(resolvedMaxRaw) : 256;
    this.maxRawEntries =
      Number.isFinite(parsedMaxRaw) && parsedMaxRaw >= 0 ? Math.trunc(parsedMaxRaw) : 256;
    const rawMaxMedia =
      typeof resolvedOptions === "number"
        ? resolvedOptions
        : resolvedOptions && typeof resolvedOptions === "object"
        ? resolvedOptions.maxMediaKeys
        : undefined;
    this.maxMediaKeys =
      rawMaxMedia !== undefined && rawMaxMedia !== null && Number(rawMaxMedia) > 0
        ? Math.max(1, Math.trunc(Number(rawMaxMedia)))
        : Math.max(64, this.maxEntries * 4);
    /** @type {StoreLogger | null} */
    this._logger =
      resolvedOptions && typeof resolvedOptions === "object" && resolvedOptions.logger
        ? resolvedOptions.logger
        : null;
    /** @type {Map<number, Record<string, any>>} */
    this.byShortId = new Map();
    this.byOneBotId = this.byShortId;
    /** @type {Map<string, Record<string, any>>} */
    this.byMsgId = new Map();
    this.byPeerMsgId = this.byMsgId;
    /** @type {Map<string, Record<string, any>>} */
    this.byPeerSeq = new Map();
    /** @type {Set<number>} */
    this._rawIds = new Set();
    /** @type {Map<string, Record<string, any>>} */
    this.byMediaKey = new Map();
    /** @type {Map<string, Record<string, any>>} */
    this.byForwardId = new Map();
    this._seqCounter = 100000;
    this._persist = createPersistState();
  }

  /**
   * @param {string} key
   * @param {Record<string, any>} desc
   */
  _setMediaKey(key, desc) {
    this.byMediaKey.delete(key);
    this.byMediaKey.set(key, desc);
    while (this.byMediaKey.size > this.maxMediaKeys) {
      const oldestKey = this.byMediaKey.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.byMediaKey.get(oldestKey);
      this.byMediaKey.delete(oldestKey);
      if (evicted && evicted.oneBotId != null) {
        const owner = this.byShortId.get(evicted.oneBotId);
        if (owner && owner._mediaKeys) {
          owner._mediaKeys.delete(oldestKey);
        }
      }
    }
  }

  /**
   * @param {any} chatType
   * @param {any} peerUid
   * @param {any} msgSeq
   * @returns {string}
   */
  static _peerSeqKey(chatType, peerUid, msgSeq) {
    if (!peerUid || msgSeq === undefined || msgSeq === null || String(msgSeq) === "0" || String(msgSeq) === "") {
      return "";
    }
    return `${Number(chatType) || 0}:${String(peerUid)}:${String(msgSeq)}`;
  }

  /**
   * @param {string} msgIdStr
   * @param {Record<string, any> | null | undefined} peer
   * @param {string} msgSeq
   * @returns {number}
   */
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

  /**
   * @param {number | string | null | undefined} oneBotId
   */
  _touchRawId(oneBotId) {
    if (oneBotId === undefined || oneBotId === null) return;
    const id = Number(oneBotId);
    this._rawIds.delete(id);
    this._rawIds.add(id);
    this._evictRawIfNeeded();
  }

  _evictRawIfNeeded() {
    while (this._rawIds.size > this.maxRawEntries) {
      const id = this._rawIds.values().next().value;
      if (id === undefined) break;
      this._rawIds.delete(id);
      const old = this.byShortId.get(id);
      if (old) {
        old.rawMsg = null;
        old.oneBotEvent = null;
      }
    }
  }

  _evictIfNeeded() {
    while (this.byShortId.size > this.maxEntries) {
      const oldestKey = this.byShortId.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = this.byShortId.get(oldestKey);
      this.byShortId.delete(oldestKey);
      this._rawIds.delete(oldestKey);
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
        if (entry._mediaKeys) {
          for (const k of entry._mediaKeys) {
            const cur = this.byMediaKey.get(k);
            if (cur && cur.oneBotId === oldestKey) {
              this.byMediaKey.delete(k);
            }
          }
        }
        if (entry._forwardKeys) {
          for (const fk of entry._forwardKeys) {
            const curFwd = this.byForwardId.get(fk);
            if (curFwd && curFwd.oneBotId === oldestKey) {
              this.byForwardId.delete(fk);
            }
          }
        }
      }
    }
  }

  /**
   * @param {Record<string, any> | null | undefined} entry
   * @returns {Record<string, any> | null}
   */
  _touch(entry) {
    if (!entry) return null;
    this.byShortId.delete(entry.shortId);
    this.byShortId.set(entry.shortId, entry);
    return entry;
  }

  get size() {
    return this.byShortId.size;
  }

  /**
   * @param {any} chatType
   * @param {any} peerUid
   * @param {any} msgId
   * @returns {Record<string, any> | null}
   */
  resolveByNtKey(chatType, peerUid, msgId) {
    if (msgId !== undefined && msgId !== null && String(msgId) !== "" && String(msgId) !== "0") {
      const byId = this.byMsgId.get(String(msgId));
      if (byId) return this._touch(byId);
    }
    return null;
  }

  /**
   * @param {any} id
   * @returns {{ entry: Record<string, any>, msgId: string, peer: Record<string, any>, msgSeq: string } | null}
   */
  resolve(id) {
    if (id === undefined || id === null || id === "") return null;
    const entry = this.get(id) || this.getByNtMsgId(String(id));
    if (!entry) return null;
    return {
      entry,
      msgId: entry.msgId,
      peer: entry.peer,
      msgSeq: entry.msgSeq,
    };
  }

  /**
   * Indexes media & forward references inside an NTQQ raw message for subsequent
   * `get_image` / `get_record` / `get_file` / `get_forward_msg` resolution.
   *
   * @param {Record<string, any>} ntMsg
   * @param {number | null} [oneBotId=null]
   */
  indexMsgMedia(ntMsg, oneBotId = null) {
    if (!ntMsg || typeof ntMsg !== "object" || !Array.isArray(ntMsg.elements)) return;
    if (oneBotId == null && ntMsg.msgId && ntMsg.peerUid) {
      oneBotId = this.resolveByNtKey(ntMsg.chatType, ntMsg.peerUid, ntMsg.msgId)?.oneBotId ?? null;
    } else if (oneBotId == null && ntMsg.msgId) {
      oneBotId = this.byMsgId.get(String(ntMsg.msgId))?.oneBotId ?? null;
    }
    const entry = oneBotId != null ? this.byOneBotId.get(Number(oneBotId)) || null : null;
    if (entry && !entry._mediaKeys) {
      entry._mediaKeys = new Set();
    }
    const resolvedOneBotId = entry
      ? entry.oneBotId
      : oneBotId != null
      ? Number(oneBotId) || null
      : null;

    /**
     * @param {string} k
     * @param {Record<string, any>} desc
     * @param {boolean} [fallbackOnly=false]
     */
    const setKey = (k, desc, fallbackOnly = false) => {
      if (!k || typeof k !== "string") return;
      const trimmed = k.trim();
      if (!trimmed) return;
      if (fallbackOnly && this.byMediaKey.has(trimmed)) {
        const prev = this.byMediaKey.get(trimmed);
        if (prev && prev.ntMsgId && desc.ntMsgId && prev.ntMsgId !== desc.ntMsgId) {
          return;
        }
      }
      if (entry) entry._mediaKeys.add(trimmed);
      this._setMediaKey(trimmed, desc);
    };

    for (const el of ntMsg.elements) {
      if (!el || typeof el !== "object") continue;
      const elementType = Number(el.elementType) || 0;
      let md5 = "";
      let fileUuid = "";
      let fileName = "";
      let sourcePath = "";
      let url = "";

      if (elementType === 2 && el.picElement) {
        const pe = el.picElement;
        md5 = pe.md5HexStr || "";
        fileUuid = pe.fileUuid || "";
        fileName = pe.fileName || "";
        sourcePath = pe.sourcePath || "";
        url = pe.originImageUrl || "";
      } else if (elementType === 3 && el.fileElement) {
        const fe = el.fileElement;
        md5 = fe.fileMd5 || "";
        fileUuid = fe.fileUuid || "";
        fileName = fe.fileName || "";
        sourcePath = fe.filePath || "";
        url = "";
      } else if (elementType === 4 && el.pttElement) {
        const ptt = el.pttElement;
        md5 = ptt.md5HexStr || "";
        fileUuid = ptt.fileUuid || "";
        fileName = ptt.fileName || "";
        sourcePath = ptt.filePath || ptt.sourcePath || "";
        url = "";
      } else if (elementType === 5 && el.videoElement) {
        const ve = el.videoElement;
        md5 = ve.videoMd5 || ve.md5HexStr || "";
        fileUuid = ve.fileUuid || "";
        fileName = ve.fileName || "";
        sourcePath = ve.filePath || ve.sourcePath || "";
        url = "";
      } else if (elementType === 11 && el.marketFaceElement) {
        const mf = el.marketFaceElement;
        md5 = mf.emojiId || "";
        fileName = mf.emojiId ? `${String(mf.emojiId).toLowerCase()}.gif` : "";
        sourcePath = mf.dynamicFacePath || mf.staticFacePath || "";
        url = _resolveMarketFaceUrl(mf);
      } else if (elementType === 16 && el.multiForwardMsgElement) {
        const fwd = el.multiForwardMsgElement;
        const fwdPeer =
          (entry?.forwardPeer && entry.forwardPeer.peerUid ? entry.forwardPeer : null) ||
          (entry?.peer && entry.peer.peerUid ? entry.peer : null) || {
            chatType: Number(ntMsg.chatType) || 0,
            peerUid: String(ntMsg.peerUid || ""),
            guildId: String(ntMsg.guildId || ""),
          };
        const parentMsgId = String(ntMsg.msgId || entry?.msgId || "");
        const rootMsgId = String(entry?.rootMsgId || parentMsgId);
        if (parentMsgId && fwdPeer.peerUid) {
          const fwdDesc = {
            oneBotId: resolvedOneBotId,
            shortId: resolvedOneBotId,
            peer: fwdPeer,
            rootMsgId: rootMsgId || parentMsgId,
            parentMsgId,
            resId: String(fwd.resId || ""),
          };
          const candidates = [String(fwd.resId || ""), String(fwd.fileName || "")];
          const xml = String(fwd.xmlContent || "");
          if (xml) {
            for (const m of xml.matchAll(/\b(?:m_resid|resid|m_fileName)="([^"]+)"/gi)) {
              if (m[1]) candidates.push(m[1]);
            }
          }
          for (const cand of candidates) {
            const trimmed = cand.trim();
            if (!trimmed) continue;
            this.byForwardId.set(trimmed, fwdDesc);
            if (entry) {
              if (!entry._forwardKeys) entry._forwardKeys = new Set();
              entry._forwardKeys.add(trimmed);
            }
          }
        }
        continue;
      } else {
        continue;
      }

      const desc = {
        oneBotId: resolvedOneBotId,
        shortId: resolvedOneBotId,
        ntMsgId: String(ntMsg.msgId || ""),
        msgId: String(ntMsg.msgId || ""),
        chatType: Number(ntMsg.chatType) || 0,
        peerUid: String(ntMsg.peerUid || ""),
        elementId: String(el.elementId || ""),
        elementType,
        md5: String(md5 || ""),
        fileUuid: String(fileUuid || ""),
        fileName: String(fileName || ""),
        sourcePath: String(sourcePath || ""),
        url: String(url || ""),
      };

      if (desc.fileUuid) {
        setKey(desc.fileUuid, desc);
      }
      if (desc.md5) {
        setKey(desc.md5, desc);
        setKey(desc.md5.toLowerCase(), desc);
      }
      if (desc.fileName) {
        const base = path.basename(desc.fileName);
        setKey(desc.fileName, desc);
        setKey(desc.fileName.toLowerCase(), desc, true);
        if (base && base !== desc.fileName) {
          setKey(base, desc);
          setKey(base.toLowerCase(), desc, true);
        }
      }
      if (desc.md5) {
        const md5Lower = desc.md5.toLowerCase();
        for (const ext of [".jpg", ".png", ".gif", ".amr", ".silk"]) {
          setKey(`${md5Lower}${ext}`, desc, true);
        }
      }
    }
  }

  /**
   * @param {string} fileToken
   * @returns {Record<string, any> | null}
   */
  lookupMedia(fileToken) {
    if (!fileToken || typeof fileToken !== "string") return null;
    const raw = fileToken.trim();
    if (!raw) return null;

    const direct = this.byMediaKey.get(raw) || this.byMediaKey.get(raw.toLowerCase());
    if (direct) return direct;

    if (raw.startsWith("ntqq://")) {
      try {
        const normalized = raw.includes("&amp;") ? raw.replace(/&amp;/g, "&") : raw;
        const parsed = new URL(normalized);
        const uuid = parsed.searchParams.get("uuid") || "";
        const md5 = parsed.searchParams.get("md5") || "";
        const file = parsed.searchParams.get("file") || "";
        for (const cand of [uuid, md5, md5.toLowerCase(), file, file.toLowerCase()]) {
          if (cand && this.byMediaKey.has(cand)) {
            return this.byMediaKey.get(cand) || null;
          }
        }
        if (file) {
          const fileMd5Match = /^([0-9a-fA-F]{32})\.[a-zA-Z0-9]+$/.exec(file);
          if (fileMd5Match) {
            const byFileMd5 =
              this.byMediaKey.get(fileMd5Match[1].toLowerCase()) ||
              this.byMediaKey.get(fileMd5Match[1]);
            if (byFileMd5) return byFileMd5;
          }
        }
      } catch (_urlErr) {
        // Malformed ntqq:// URI token; fall through to raw MD5-prefix matching
      }
    }

    const md5ExtMatch = /^([0-9a-fA-F]{32})\.[a-zA-Z0-9]+$/.exec(raw);
    if (md5ExtMatch) {
      const hit =
        this.byMediaKey.get(md5ExtMatch[1].toLowerCase()) ||
        this.byMediaKey.get(md5ExtMatch[1]);
      if (hit) return hit;
    }

    return null;
  }

  /**
   * @param {any} token
   * @returns {Record<string, any> | null}
   */
  lookupForward(token) {
    if (token === undefined || token === null) return null;
    const raw = String(token).trim();
    if (!raw) return null;
    return this.byForwardId.get(raw) || null;
  }

  /**
   * Registers or merges a message mapping and returns its positive 31-bit OneBot `message_id`.
   *
   * @param {any} msgId
   * @param {any} [peer]
   * @param {any} [msgSeq]
   * @param {Record<string, any>} [extra={}]
   * @param {...any} _legacyRest
   * @returns {number}
   */
  register(msgId, peer, msgSeq, extra = {}, ..._legacyRest) {
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
    if (peer !== undefined && peer !== null && typeof peer !== "object" && arguments.length >= 3) {
      const chatTypeArg = peer;
      const peerUidArg = msgSeq;
      const msgSeqArg = arguments[3];
      const senderUinArg = arguments[4];
      const rawMsgArg = arguments[5] ?? null;
      const oneBotEventArg = arguments[6] ?? null;
      return this.register(
        msgId,
        { chatType: Number(chatTypeArg) || 1, peerUid: String(peerUidArg ?? ""), guildId: "" },
        msgSeqArg,
        {
          ...(senderUinArg !== undefined ? { senderUin: senderUinArg } : {}),
          ...(rawMsgArg !== null && rawMsgArg !== undefined ? { rawMsg: rawMsgArg } : {}),
          ...(oneBotEventArg !== null && oneBotEventArg !== undefined
            ? { oneBotEvent: oneBotEventArg }
            : {}),
        }
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
    const rawMsg = extra.rawMsg || null;
    const rawRandom =
      extra.msgRandom !== undefined && extra.msgRandom !== null && extra.msgRandom !== ""
        ? extra.msgRandom
        : rawMsg?.msgRandom;
    const msgRandom =
      rawRandom !== undefined && rawRandom !== null && rawRandom !== "" ? String(rawRandom) : null;

    /** @type {Record<string, any> | null} */
    let existing = null;
    if (msgIdStr && this.byMsgId.has(msgIdStr)) {
      existing = this.byMsgId.get(msgIdStr) || null;
    } else if (psKey && this.byPeerSeq.has(psKey)) {
      const candidate = this.byPeerSeq.get(psKey);
      const candMsgId = candidate && candidate.msgId ? String(candidate.msgId) : "";
      if (
        candidate &&
        (!msgIdStr ||
          !candMsgId ||
          candMsgId === "0" ||
          candMsgId.startsWith("sent_") ||
          candMsgId === String(candidate.shortId))
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
      if (extra.senderUin !== undefined) {
        const nextUin = String(extra.senderUin);
        if (pickPositiveUin(nextUin) > 0 || !existing.senderUin) {
          existing.senderUin = nextUin;
        }
      }
      if (extra.senderUid !== undefined && (extra.senderUid || !existing.senderUid)) {
        existing.senderUid = String(extra.senderUid);
      }
      if (extra.groupId !== undefined && (extra.groupId || !existing.groupId)) {
        existing.groupId = String(extra.groupId);
      }
      if (extra.msgTime !== undefined) {
        existing.msgTime = Number(extra.msgTime);
        existing.time = existing.msgTime;
      } else if (extra.time !== undefined) {
        existing.msgTime = Number(extra.time);
        existing.time = existing.msgTime;
      }
      if (msgRandom && !existing.msgRandom) existing.msgRandom = msgRandom;
      if (extra.rootMsgId) existing.rootMsgId = String(extra.rootMsgId);
      if (extra.forwardPeer && extra.forwardPeer.peerUid) {
        existing.forwardPeer = extra.forwardPeer;
      }
      if (extra.emojiLikesSnapshot !== undefined) {
        existing.emojiLikesSnapshot = extra.emojiLikesSnapshot;
      }
      if (!existing._mediaKeys) existing._mediaKeys = new Set();
      if (!existing._forwardKeys) existing._forwardKeys = new Set();
      if (rawMsg) {
        existing.rawMsg = rawMsg;
        this._touchRawId(existing.shortId);
        this.indexMsgMedia(rawMsg, existing.shortId);
      }
      if (extra.oneBotEvent) existing.oneBotEvent = extra.oneBotEvent;
      this._touch(existing);
      this.schedulePersist();
      return existing.shortId;
    }

    const shortId = this._computeShortId(msgIdStr, normPeer, msgSeqStr);
    const resolvedTime = Number(
      extra.msgTime ?? extra.time ?? Math.floor(Date.now() / 1000)
    );
    const entry = {
      shortId,
      oneBotId: shortId,
      msgId: msgIdStr || String(shortId),
      rootMsgId: String(extra.rootMsgId || msgIdStr || ""),
      forwardPeer:
        extra.forwardPeer && extra.forwardPeer.peerUid ? extra.forwardPeer : null,
      peer: normPeer,
      chatType: normPeer.chatType,
      peerUid: normPeer.peerUid,
      msgSeq: msgSeqStr || "0",
      msgRandom,
      senderUin: extra.senderUin !== undefined ? String(extra.senderUin) : "",
      senderUid: extra.senderUid !== undefined ? String(extra.senderUid) : "",
      groupId: extra.groupId !== undefined ? String(extra.groupId) : "",
      msgTime: resolvedTime,
      time: resolvedTime,
      rawMsg,
      oneBotEvent: extra.oneBotEvent || null,
      emojiLikesSnapshot:
        extra.emojiLikesSnapshot !== undefined ? extra.emojiLikesSnapshot : null,
      createdAt: Date.now(),
      _mediaKeys: new Set(),
      _forwardKeys: new Set(),
    };

    this.byShortId.set(shortId, entry);
    if (msgIdStr) {
      this.byMsgId.set(msgIdStr, entry);
    }
    if (psKey) {
      this.byPeerSeq.set(psKey, entry);
    }
    if (rawMsg) {
      this._touchRawId(shortId);
      this.indexMsgMedia(rawMsg, shortId);
    }
    this._evictIfNeeded();
    this.schedulePersist();
    return shortId;
  }

  /**
   * @param {number} [maxItems]
   * @returns {{ version: number, entries: Array<Record<string, any>> }}
   */
  toSnapshot(maxItems) {
    let limit = this.maxEntries;
    if (maxItems !== undefined && maxItems !== null) {
      const parsed = Math.trunc(Number(maxItems));
      if (Number.isFinite(parsed) && parsed >= 0) {
        limit = Math.min(this.maxEntries, parsed);
      }
    }
    const allEntries = Array.from(this.byShortId.values());
    const slice =
      limit === 0
        ? []
        : allEntries.length > limit
        ? allEntries.slice(-limit)
        : allEntries;
    const entries = slice.map((entry) => {
      /** @type {Record<string, any>} */
      const item = {
        shortId: entry.shortId,
        msgId: entry.msgId || "",
        peer: {
          chatType: Number(entry.peer?.chatType ?? entry.chatType ?? 1),
          peerUid: String(entry.peer?.peerUid ?? entry.peerUid ?? ""),
          guildId: String(entry.peer?.guildId ?? ""),
        },
        msgSeq: String(entry.msgSeq || "0"),
        msgRandom: entry.msgRandom || null,
        senderUin: String(entry.senderUin || ""),
        senderUid: String(entry.senderUid || ""),
        time: Number(entry.msgTime ?? entry.time ?? 0) || 0,
      };
      if (entry.emojiLikesSnapshot != null) {
        item.emojiLikesSnapshot = entry.emojiLikesSnapshot;
      }
      return item;
    });
    return {
      version: 1,
      entries,
    };
  }

  /**
   * @param {Record<string, any>} snapshot
   * @returns {boolean}
   */
  loadSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.entries)) {
      return false;
    }
    const slice =
      snapshot.entries.length > this.maxEntries
        ? snapshot.entries.slice(-this.maxEntries)
        : snapshot.entries;
    for (const item of slice) {
      if (!item || typeof item !== "object") continue;
      const msgIdStr =
        item.msgId !== undefined && item.msgId !== null && String(item.msgId) !== "0"
          ? String(item.msgId)
          : "";
      const normPeer = {
        chatType: Number(item.peer?.chatType ?? item.chatType ?? 1),
        peerUid: String(item.peer?.peerUid ?? item.peerUid ?? ""),
        guildId: String(item.peer?.guildId ?? item.guildId ?? ""),
      };
      const msgSeqStr =
        item.msgSeq !== undefined && item.msgSeq !== null ? String(item.msgSeq) : "0";
      const parsedShort = Number(item.shortId);
      const shortId =
        Number.isInteger(parsedShort) && parsedShort > 0 && parsedShort <= 0x7fffffff
          ? parsedShort
          : this._computeShortId(msgIdStr, normPeer, msgSeqStr);
      const msgTime =
        Number(item.time ?? item.msgTime ?? 0) || Math.floor(Date.now() / 1000);
      const msgRandom =
        item.msgRandom !== undefined && item.msgRandom !== null && item.msgRandom !== ""
          ? String(item.msgRandom)
          : null;
      const entry = {
        shortId,
        oneBotId: shortId,
        msgId: msgIdStr || String(shortId),
        rootMsgId: String(item.rootMsgId || msgIdStr || ""),
        forwardPeer:
          item.forwardPeer && item.forwardPeer.peerUid ? item.forwardPeer : null,
        peer: normPeer,
        chatType: normPeer.chatType,
        peerUid: normPeer.peerUid,
        msgSeq: msgSeqStr || "0",
        msgRandom,
        senderUin: item.senderUin !== undefined ? String(item.senderUin) : "",
        senderUid: item.senderUid !== undefined ? String(item.senderUid) : "",
        groupId:
          item.groupId !== undefined
            ? String(item.groupId)
            : normPeer.chatType === 2 && /^\d+$/.test(normPeer.peerUid)
            ? normPeer.peerUid
            : "",
        msgTime,
        time: msgTime,
        rawMsg: null,
        oneBotEvent: null,
        emojiLikesSnapshot:
          item.emojiLikesSnapshot !== undefined ? item.emojiLikesSnapshot : null,
        createdAt: Date.now(),
        _mediaKeys: new Set(),
        _forwardKeys: new Set(),
      };
      this.byShortId.delete(shortId);
      this.byShortId.set(shortId, entry);
      if (msgIdStr) {
        this.byMsgId.delete(msgIdStr);
        this.byMsgId.set(msgIdStr, entry);
      }
      const psKey = MessageIdStore._peerSeqKey(
        normPeer.chatType,
        normPeer.peerUid,
        msgSeqStr
      );
      if (psKey) {
        this.byPeerSeq.delete(psKey);
        this.byPeerSeq.set(psKey, entry);
      }
    }
    this._evictIfNeeded();
    return true;
  }

  /**
   * @param {string} filePath
   * @returns {boolean}
   */
  loadFromFileSync(filePath) {
    if (!filePath || typeof filePath !== "string" || !filePath.trim()) {
      return false;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Boolean(this.loadSnapshot(parsed));
    } catch (err) {
      // Missing or corrupted snapshot on startup is non-fatal; start with empty store
      this._logger?.debug?.("stores:loadMessageIdSnapshot", err);
      return false;
    }
  }

  /**
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async saveToFile(filePath) {
    return enqueueCoalescedSave(this._persist, filePath, () => this.toSnapshot(), this._logger);
  }

  /**
   * @param {string} filePath
   * @param {{ debounceMs?: number }} [opts={}]
   * @returns {boolean}
   */
  enableAutoPersist(filePath, { debounceMs = 2000 } = {}) {
    const targetPath = typeof filePath === "string" ? filePath.trim() : "";
    if (!targetPath) {
      this.disableAutoPersist();
      return false;
    }
    this._persist.filePath = targetPath;
    const parsedDebounce = Number(debounceMs);
    this._persist.debounceMs =
      Number.isFinite(parsedDebounce) && parsedDebounce >= 0
        ? Math.trunc(parsedDebounce)
        : 2000;
    this._persist.enabled = true;
    return true;
  }

  disableAutoPersist() {
    this._persist.enabled = false;
    this._persist.dirty = false;
    if (this._persist.timer) {
      clearTimeout(this._persist.timer);
      this._persist.timer = null;
    }
  }

  /**
   * @returns {boolean}
   */
  schedulePersist() {
    if (!this._persist.enabled || !this._persist.filePath) return false;
    this._persist.dirty = true;
    if (this._persist.timer) {
      clearTimeout(this._persist.timer);
    }
    const targetPath = this._persist.filePath;
    const timer = setTimeout(() => {
      this._persist.timer = null;
      if (!this._persist.enabled || !this._persist.dirty) return;
      this._persist.dirty = false;
      this.saveToFile(targetPath).catch((err) => {
        // Background debounced snapshot write failure must not surface as unhandled rejection
        this._logger?.debug?.("stores:autoPersistMessageIds", err);
      });
    }, this._persist.debounceMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
    this._persist.timer = timer;
    return true;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async flushPersist() {
    if (this._persist.timer) {
      clearTimeout(this._persist.timer);
      this._persist.timer = null;
    }
    if (!this._persist.enabled || !this._persist.filePath) {
      return false;
    }
    this._persist.dirty = false;
    await this.saveToFile(this._persist.filePath);
    return true;
  }

  /**
   * @param {any} shortId
   * @returns {Record<string, any> | null}
   */
  get(shortId) {
    return this.getByShortId(shortId);
  }

  /**
   * @param {any} shortId
   * @returns {Record<string, any> | null}
   */
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

  /**
   * @param {any} msgId
   * @returns {Record<string, any> | null}
   */
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

  /**
   * @param {any} msgId
   * @returns {Record<string, any> | null}
   */
  getByNtMsgId(msgId) {
    return this.getByMsgId(msgId);
  }

  /**
   * @param {any} chatType
   * @param {any} peerUid
   * @param {any} msgSeq
   * @returns {Record<string, any> | null}
   */
  getByPeerAndSeq(chatType, peerUid, msgSeq) {
    const psKey = MessageIdStore._peerSeqKey(chatType, peerUid, msgSeq);
    if (!psKey) return null;
    const entry = this.byPeerSeq.get(psKey);
    return entry ? this._touch(entry) : null;
  }

  /**
   * @param {any} chatType
   * @param {any} peerUid
   * @param {any} msgSeq
   * @returns {Record<string, any> | null}
   */
  getByPeerSeq(chatType, peerUid, msgSeq) {
    return this.getByPeerAndSeq(chatType, peerUid, msgSeq);
  }

  /**
   * @param {any} rawId
   * @returns {Record<string, any> | null}
   */
  resolveByOneBotId(rawId) {
    const res = this.resolve(rawId);
    return res ? res.entry : this.getByShortId(rawId);
  }
}

// ============================================================================
// 2. UinUidStore (Bi-Directional QQ UIN <-> NTQQ UID Cache)
// ============================================================================

class UinUidStore {
  /**
   * @param {number | Record<string, any>} [maxEntries=20000]
   * @param {Record<string, any>} [options={}]
   */
  constructor(maxEntries = 20000, options = {}) {
    /** @type {number | Record<string, any>} */
    let resolvedMax = maxEntries;
    /** @type {Record<string, any>} */
    let resolvedOpts = options;
    if (resolvedMax && typeof resolvedMax === "object") {
      resolvedOpts = resolvedMax;
      resolvedMax = resolvedOpts.maxEntries ?? 20000;
    }
    const opts = resolvedOpts && typeof resolvedOpts === "object" ? resolvedOpts : {};
    this.maxEntries = Math.max(2, Number(resolvedMax) || 20000);
    this.maxUserMetaEntries = Math.max(
      2,
      Number(opts.maxUserMetaEntries) || this.maxEntries
    );
    this.maxGroupMemberMetaEntries = Math.max(
      4,
      Number(opts.maxGroupMemberMetaEntries) || this.maxEntries * 2
    );
    /** @type {StoreLogger | null} */
    this._logger = opts.logger || null;
    /** @type {Map<string, string>} */
    this.uinToUid = new Map();
    /** @type {Map<string, string>} */
    this.uidToUin = new Map();
    /** @type {Map<string, Record<string, any>>} */
    this.userMeta = new Map(); // uin -> { uin, uid, nickname, remark, sex, age }
    /** @type {Map<string, Record<string, any>>} */
    this.groupMemberMeta = new Map(); // `${groupId}:${uin}` -> { uin, uid, nickname, card, role, title }
    this._persist = createPersistState();
  }

  _evictIfNeeded() {
    while (this.uinToUid.size > this.maxEntries) {
      const oldUin = this.uinToUid.keys().next().value;
      if (oldUin === undefined) break;
      const uid = this.uinToUid.get(oldUin);
      this.uinToUid.delete(oldUin);
      if (uid && this.uidToUin.get(uid) === oldUin) {
        this.uidToUin.delete(uid);
      }
      this.userMeta.delete(oldUin);
    }
    while (this.userMeta.size > this.maxUserMetaEntries) {
      const oldestKey = this.userMeta.keys().next().value;
      if (oldestKey === undefined) break;
      this.userMeta.delete(oldestKey);
    }
    while (this.groupMemberMeta.size > this.maxGroupMemberMetaEntries) {
      const oldestKey = this.groupMemberMeta.keys().next().value;
      if (oldestKey === undefined) break;
      this.groupMemberMeta.delete(oldestKey);
    }
  }

  /**
   * @param {string} uinStr
   * @param {Record<string, any>} value
   */
  _setUserMeta(uinStr, value) {
    this.userMeta.delete(uinStr);
    this.userMeta.set(uinStr, value);
    while (this.userMeta.size > this.maxUserMetaEntries) {
      const oldestKey = this.userMeta.keys().next().value;
      if (oldestKey === undefined) break;
      this.userMeta.delete(oldestKey);
    }
  }

  /**
   * @param {string} gKey
   * @param {Record<string, any>} value
   */
  _setGroupMemberMeta(gKey, value) {
    this.groupMemberMeta.delete(gKey);
    this.groupMemberMeta.set(gKey, value);
    while (this.groupMemberMeta.size > this.maxGroupMemberMetaEntries) {
      const oldestKey = this.groupMemberMeta.keys().next().value;
      if (oldestKey === undefined) break;
      this.groupMemberMeta.delete(oldestKey);
    }
  }

  /**
   * @param {any} uin
   * @param {any} uid
   * @param {Record<string, any> | null} [meta=null]
   */
  record(uin, uid, meta = null) {
    return this.remember(uin, uid, meta);
  }

  /**
   * @param {any} uin
   * @param {any} uid
   * @param {Record<string, any> | null} [meta=null]
   */
  register(uin, uid, meta = null) {
    return this.remember(uin, uid, meta);
  }

  /**
   * @param {any} groupId
   * @param {any} [uin]
   * @param {any} [uid=""]
   * @param {Record<string, any> | null} [meta=null]
   */
  recordGroupMember(groupId, uin, uid = "", meta = null) {
    if (groupId && typeof groupId === "object") {
      const obj = groupId;
      const gId = obj.groupId ?? obj.group_id ?? obj.groupCode ?? "";
      return this.recordGroupMember(gId, obj.uin ?? obj.user_id, obj.uid ?? "", obj);
    }
    if (uin && typeof uin === "object") {
      const m = uin;
      const roleNum = m.role ?? m.permission;
      const role =
        typeof roleNum === "string" && !/^\d+$/.test(roleNum.trim())
          ? roleNum
          : Number(roleNum) === 4
          ? "owner"
          : Number(roleNum) === 3
          ? "admin"
          : m.role !== undefined || m.permission !== undefined
          ? "member"
          : "";
      return this.remember(m.uin ?? m.user_id, m.uid ?? "", {
        groupId,
        nickname: m.nick ?? m.nickname ?? m.memberName ?? "",
        card: m.cardName ?? m.card ?? m.memberCard?.memberCard ?? "",
        ...(role ? { role } : {}),
        title: m.memberSpecialTitle ?? m.specialTitle ?? m.title ?? "",
      });
    }
    if (uid && typeof uid === "object") {
      const objMeta = uid;
      meta = objMeta;
      uid = objMeta.uid ?? "";
    }
    return this.remember(uin, uid, {
      ...(meta && typeof meta === "object" ? meta : {}),
      groupId,
    });
  }

  /**
   * @param {any} uin
   * @param {any} uid
   * @param {Record<string, any> | null} [meta=null]
   */
  remember(uin, uid, meta = null) {
    const uinStr = uin !== undefined && uin !== null ? String(uin).trim() : "";
    const uidStr = uid !== undefined && uid !== null ? String(uid).trim() : "";
    const validUin = /^\d+$/.test(uinStr) && Number(uinStr) > 0;
    const validUid = uidStr.length > 0 && uidStr !== "0";
    let mutated = false;

    if (validUin && validUid) {
      this.uinToUid.delete(uinStr);
      this.uinToUid.set(uinStr, uidStr);
      this.uidToUin.delete(uidStr);
      this.uidToUin.set(uidStr, uinStr);
      this._evictIfNeeded();
      mutated = true;
    }

    if (validUin && meta && typeof meta === "object") {
      const nickVal = meta.nickname ?? meta.nick;
      const prev = this.userMeta.get(uinStr) || { uin: Number(uinStr), uid: uidStr };
      this._setUserMeta(uinStr, {
        ...prev,
        ...(validUid ? { uid: uidStr } : {}),
        ...(nickVal ? { nickname: String(nickVal) } : {}),
        ...(meta.remark !== undefined ? { remark: String(meta.remark) } : {}),
        ...(meta.sex ? { sex: String(meta.sex) } : {}),
        ...(meta.age !== undefined ? { age: Number(meta.age) } : {}),
      });
      if (meta.groupId && /^\d+$/.test(String(meta.groupId))) {
        const gKey = `${meta.groupId}:${uinStr}`;
        const prevG = this.groupMemberMeta.get(gKey) || {};
        this._setGroupMemberMeta(gKey, {
          ...prevG,
          group_id: Number(meta.groupId),
          user_id: Number(uinStr),
          uid: validUid ? uidStr : prevG.uid || "",
          nickname: String(nickVal ?? prevG.nickname ?? ""),
          card: String(meta.card ?? prevG.card ?? ""),
          role: String(meta.role ?? prevG.role ?? ""),
          title: String(meta.title ?? prevG.title ?? ""),
        });
      }
      mutated = true;
    }

    if (mutated) {
      this.schedulePersist();
    }
  }

  /**
   * @param {Record<string, any>} ntMsg
   */
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

  /**
   * @param {any} buddyData
   */
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

  /**
   * @param {Record<string, any>} buddy
   */
  _rememberBuddyObject(buddy) {
    if (!buddy || typeof buddy !== "object") return;
    const core = buddy.coreInfo || buddy.baseInfo || buddy;
    const uin = buddy.uin || core.uin;
    const uid = buddy.uid || core.uid;
    const nickname = buddy.nick || core.nick || buddy.nickname || "";
    const remark = buddy.remark || core.remark || "";
    this.remember(uin, uid, { nickname, remark });
  }

  /**
   * @param {any} groupId
   * @param {any} membersContainer
   */
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
        typeof roleNum === "string" && !/^\d+$/.test(roleNum.trim())
          ? roleNum
          : Number(roleNum) === 4
          ? "owner"
          : Number(roleNum) === 3
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

  /**
   * @param {any} uin
   * @returns {string}
   */
  getUid(uin) {
    return this.getUidSync(uin);
  }

  /**
   * @param {any} uid
   * @returns {string}
   */
  getUin(uid) {
    return this.getUinSync(uid);
  }

  /**
   * @param {any} uin
   * @returns {string}
   */
  getUidSync(uin) {
    if (uin === undefined || uin === null) return "";
    const str = String(uin).trim();
    if (!str || str === "0") return "";
    if (str.startsWith("u_")) return str;
    return this.uinToUid.get(str) || "";
  }

  /**
   * @param {any} uid
   * @returns {string}
   */
  getUinSync(uid) {
    if (uid === undefined || uid === null) return "";
    const str = String(uid).trim();
    if (!str || str === "0") return "";
    if (/^\d+$/.test(str) && Number(str) > 0) return str;
    return this.uidToUin.get(str) || "";
  }

  /**
   * @param {any} uin
   * @param {import("../types").InvokeNtFn | null} [invokeNt]
   * @returns {Promise<string>}
   */
  async resolveUid(uin, invokeNt) {
    const str = String(uin ?? "").trim();
    if (!str || str === "0") return "";
    if (str.startsWith("u_")) return str;
    const cached = this.getUidSync(str);
    if (cached) return cached;
    if (typeof invokeNt === "function" && /^\d+$/.test(str) && Number(str) > 0) {
      /** @param {any} mapOrObj */
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
        if (resolved && String(resolved).trim() !== "0") {
          this.remember(str, resolved);
          return String(resolved);
        }
      } catch (err) {
        // Primary UixConvertService unavailable; fall through to GroupService lookup
        this._logger?.debug?.("stores:resolveUid:uixConvert", err);
      }
      try {
        const res2 = await invokeNt(
          "nodeIKernelGroupService/getUidByUins",
          { uinList: [str] },
          [[str]]
        );
        const resolved2 = extractUid(res2?.uids || res2?.uidInfo || res2);
        if (resolved2 && String(resolved2).trim() !== "0") {
          this.remember(str, resolved2);
          return String(resolved2);
        }
      } catch (err) {
        // Secondary GroupService lookup also unavailable; return empty UID
        this._logger?.debug?.("stores:resolveUid:groupService", err);
      }
    }
    return "";
  }

  /**
   * @param {any} uid
   * @param {import("../types").InvokeNtFn | null} [invokeNt]
   * @returns {Promise<string>}
   */
  async resolveUin(uid, invokeNt) {
    const str = String(uid ?? "").trim();
    if (!str || str === "0") return "";
    if (/^\d+$/.test(str) && Number(str) > 0) return str;
    const cached = this.getUinSync(str);
    if (cached) return cached;
    if (typeof invokeNt === "function") {
      /** @param {any} mapOrObj */
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
      } catch (err) {
        // Primary UixConvertService unavailable; fall through to GroupService lookup
        this._logger?.debug?.("stores:resolveUin:uixConvert", err);
      }
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
      } catch (err) {
        // Secondary GroupService lookup also unavailable; return empty UIN
        this._logger?.debug?.("stores:resolveUin:groupService", err);
      }
    }
    return "";
  }

  /**
   * @param {number} [maxItems]
   * @returns {{ version: number, pairs: Array<[string, string]>, userMeta: Array<[string, Record<string, any>]> }}
   */
  toSnapshot(maxItems) {
    let pairLimit = this.maxEntries;
    let metaLimit = Math.min(this.maxEntries, this.maxUserMetaEntries);
    if (maxItems !== undefined && maxItems !== null) {
      const parsed = Math.trunc(Number(maxItems));
      if (Number.isFinite(parsed) && parsed >= 0) {
        pairLimit = Math.min(this.maxEntries, parsed);
        metaLimit = Math.min(metaLimit, parsed);
      }
    }
    const allPairs = Array.from(this.uinToUid.entries());
    /** @type {Array<[string, string]>} */
    const pairs = (
      pairLimit === 0
        ? []
        : allPairs.length > pairLimit
        ? allPairs.slice(-pairLimit)
        : allPairs
    ).map(([uin, uid]) => [String(uin), String(uid)]);

    const allMeta = Array.from(this.userMeta.entries());
    /** @type {Array<[string, Record<string, any>]>} */
    const userMeta = (
      metaLimit === 0
        ? []
        : allMeta.length > metaLimit
        ? allMeta.slice(-metaLimit)
        : allMeta
    ).map(([uin, meta]) => [String(uin), { ...meta }]);

    return {
      version: 1,
      pairs,
      userMeta,
    };
  }

  /**
   * @param {Record<string, any>} snapshot
   * @returns {boolean}
   */
  loadSnapshot(snapshot) {
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      (!Array.isArray(snapshot.pairs) && !Array.isArray(snapshot.userMeta))
    ) {
      return false;
    }
    if (Array.isArray(snapshot.pairs)) {
      const pairSlice =
        snapshot.pairs.length > this.maxEntries
          ? snapshot.pairs.slice(-this.maxEntries)
          : snapshot.pairs;
      for (const item of pairSlice) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const uinStr =
          item[0] !== undefined && item[0] !== null ? String(item[0]).trim() : "";
        const uidStr =
          item[1] !== undefined && item[1] !== null ? String(item[1]).trim() : "";
        const validUin = /^\d+$/.test(uinStr) && Number(uinStr) > 0;
        const validUid = uidStr.length > 0 && uidStr !== "0";
        if (validUin && validUid) {
          this.uinToUid.delete(uinStr);
          this.uinToUid.set(uinStr, uidStr);
          this.uidToUin.delete(uidStr);
          this.uidToUin.set(uidStr, uinStr);
        }
      }
    }
    if (Array.isArray(snapshot.userMeta)) {
      const metaCap = Math.min(this.maxEntries, this.maxUserMetaEntries);
      const metaSlice =
        snapshot.userMeta.length > metaCap
          ? snapshot.userMeta.slice(-metaCap)
          : snapshot.userMeta;
      for (const item of metaSlice) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const uinStr =
          item[0] !== undefined && item[0] !== null ? String(item[0]).trim() : "";
        const meta = item[1];
        const validUin = /^\d+$/.test(uinStr) && Number(uinStr) > 0;
        if (!validUin || !meta || typeof meta !== "object" || Array.isArray(meta)) {
          continue;
        }
        const nickVal = meta.nickname ?? meta.nick;
        const rawUid =
          meta.uid !== undefined && meta.uid !== null
            ? String(meta.uid).trim()
            : this.uinToUid.get(uinStr) || "";
        this._setUserMeta(uinStr, {
          uin: Number(uinStr),
          uid: rawUid !== "0" ? rawUid : "",
          ...(nickVal ? { nickname: String(nickVal) } : {}),
          ...(meta.remark !== undefined ? { remark: String(meta.remark) } : {}),
          ...(meta.sex ? { sex: String(meta.sex) } : {}),
          ...(meta.age !== undefined && Number.isFinite(Number(meta.age))
            ? { age: Number(meta.age) }
            : {}),
        });
      }
    }
    this._evictIfNeeded();
    return true;
  }

  /**
   * @param {string} filePath
   * @returns {boolean}
   */
  loadFromFileSync(filePath) {
    if (!filePath || typeof filePath !== "string" || !filePath.trim()) {
      return false;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Boolean(this.loadSnapshot(parsed));
    } catch (err) {
      // Missing or corrupted snapshot on startup is non-fatal; start with empty cache
      this._logger?.debug?.("stores:loadUinUidSnapshot", err);
      return false;
    }
  }

  /**
   * @param {string} filePath
   * @returns {Promise<boolean>}
   */
  async saveToFile(filePath) {
    return enqueueCoalescedSave(this._persist, filePath, () => this.toSnapshot(), this._logger);
  }

  /**
   * @param {string} filePath
   * @param {{ debounceMs?: number }} [opts={}]
   * @returns {boolean}
   */
  enableAutoPersist(filePath, { debounceMs = 2000 } = {}) {
    const targetPath = typeof filePath === "string" ? filePath.trim() : "";
    if (!targetPath) {
      this.disableAutoPersist();
      return false;
    }
    this._persist.filePath = targetPath;
    const parsedDebounce = Number(debounceMs);
    this._persist.debounceMs =
      Number.isFinite(parsedDebounce) && parsedDebounce >= 0
        ? Math.trunc(parsedDebounce)
        : 2000;
    this._persist.enabled = true;
    return true;
  }

  disableAutoPersist() {
    this._persist.enabled = false;
    this._persist.dirty = false;
    if (this._persist.timer) {
      clearTimeout(this._persist.timer);
      this._persist.timer = null;
    }
  }

  /**
   * @returns {boolean}
   */
  schedulePersist() {
    if (!this._persist.enabled || !this._persist.filePath) return false;
    this._persist.dirty = true;
    if (this._persist.timer) {
      clearTimeout(this._persist.timer);
    }
    const targetPath = this._persist.filePath;
    const timer = setTimeout(() => {
      this._persist.timer = null;
      if (!this._persist.enabled || !this._persist.dirty) return;
      this._persist.dirty = false;
      this.saveToFile(targetPath).catch((err) => {
        // Background debounced snapshot write failure must not surface as unhandled rejection
        this._logger?.debug?.("stores:autoPersistUinUid", err);
      });
    }, this._persist.debounceMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
    this._persist.timer = timer;
    return true;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async flushPersist() {
    if (this._persist.timer) {
      clearTimeout(this._persist.timer);
      this._persist.timer = null;
    }
    if (!this._persist.enabled || !this._persist.filePath) {
      return false;
    }
    this._persist.dirty = false;
    await this.saveToFile(this._persist.filePath);
    return true;
  }
}

/**
 * Looks up a cached UIN synchronously from a `UinUidStore` (or compatible mock).
 *
 * @param {any} uinUidStore
 * @param {any} uid
 * @returns {string | number}
 */
function lookupCachedUin(uinUidStore, uid) {
  if (!uinUidStore || !uid) return 0;
  const uidStr = String(uid).trim();
  if (!uidStr || uidStr === "0") return 0;
  if (typeof uinUidStore.getUinSync === "function") {
    return uinUidStore.getUinSync(uidStr);
  }
  if (typeof uinUidStore.getUin === "function") {
    return uinUidStore.getUin(uidStr);
  }
  if (typeof uinUidStore.resolveUin === "function") {
    const r = uinUidStore.resolveUin(uidStr);
    if (r && typeof r.then !== "function") return r;
  }
  return 0;
}

module.exports = {
  pickPositiveUin,
  lookupCachedUin,
  MessageIdStore,
  UinUidStore,
};
