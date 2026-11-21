// @ts-check
"use strict";

const crypto = require("crypto");

/** @typedef {import("../types").SessionQueueStats} SessionQueueStats */

/**
 * @typedef {object} QueueWaiter
 * @property {string} peerKey
 * @property {boolean} advisory
 * @property {() => Promise<any> | any} taskFn
 * @property {(val: any) => void} resolve
 * @property {(err: any) => void} reject
 * @property {NodeJS.Timeout | null} queueTimer
 * @property {AbortSignal | null} signal
 * @property {(() => void) | null} onAbort
 * @property {boolean} settled
 */

/**
 * @param {string} code
 * @param {number} retcode
 * @param {string} message
 * @returns {Error & { code: string, retcode: number }}
 */
function makeSessionQueueError(code, retcode, message) {
  const err = /** @type {Error & { code: string, retcode: number }} */ (new Error(message));
  err.code = code;
  err.retcode = retcode;
  return err;
}

/**
 * CausalSessionScheduler (`src/core/session_scheduler.js`)
 *
 * Upgrades AIO mutex serialization and human session-switch scheduling:
 * - Peer-affinity exclusive mutex queue with starvation cap (`maxAffinityStreak`),
 *   bounded queue depth (`maxQueueSize`), queue wait deadline (`defaultQueueTimeoutMs` /
 *   `timeoutMs`), `AbortSignal` disconnect cancellation, and non-advisory priority over
 *   `advisory: true` background tasks.
 * - High-frequency session switch cooldown (`shouldAllowSwitch` / `recordSwitch`).
 * - Jittered human delay helper (`computeDelayMs` / `sleepUnref`) with full handle
 *   tracking so `dispose()` cancels all timers immediately without leaking handles.
 * - Coalesced private-message auto-read/typing reaction scheduler per `peerKey`.
 */
class CausalSessionScheduler {
  /**
   * @param {Record<string, any>} [options={}]
   */
  constructor(options = {}) {
    this._customGetActivePeerKey =
      typeof options.getActivePeerKey === "function" ? options.getActivePeerKey : null;
    this._logger = options.logger || null;

    const rawMaxStreak = Number(options.maxAffinityStreak);
    this.maxAffinityStreak =
      Number.isFinite(rawMaxStreak) && rawMaxStreak >= 0 ? Math.floor(rawMaxStreak) : 8;

    const rawCooldown = Number(options.switchCooldownMs);
    this.switchCooldownMs =
      Number.isFinite(rawCooldown) && rawCooldown >= 0 ? rawCooldown : 800;

    const rawMaxQueue = Number(options.maxQueueSize);
    this.maxQueueSize =
      Number.isFinite(rawMaxQueue) && rawMaxQueue >= 0 ? Math.floor(rawMaxQueue) : 0;

    const rawQueueTimeout = Number(options.defaultQueueTimeoutMs);
    this.defaultQueueTimeoutMs =
      Number.isFinite(rawQueueTimeout) && rawQueueTimeout >= 0 ? Math.floor(rawQueueTimeout) : 0;

    this.enforceHardCooldownOnExplicit = Boolean(options.enforceHardCooldownOnExplicit);
    this.defaultPrivateRecvDelay =
      options.defaultPrivateRecvDelay !== undefined
        ? options.defaultPrivateRecvDelay
        : [500, 1800];

    this._locked = false;
    /** @type {QueueWaiter[]} */
    this._queue = [];
    this._affinityStreak = 0;
    this.stats = {
      enqueued: 0,
      timedOut: 0,
      overflowRejected: 0,
      aborted: 0,
      evictedAdvisory: 0,
    };

    this.lastSwitchAt = 0;
    this.lastPeerKey = "";
    this._hasSwitched = false;

    /** @type {Set<NodeJS.Timeout>} */
    this._activeTimers = new Set();
    /** @type {Set<{ timer: NodeJS.Timeout | null, resolve: () => void }>} */
    this._activeSleeps = new Set();
    /** @type {Map<string, { peerKey: string, timer: NodeJS.Timeout | null, delayMs: number }>} */
    this._peerReactions = new Map();
  }

  _ensureStats() {
    if (!this.stats || typeof this.stats !== "object") {
      this.stats = {
        enqueued: 0,
        timedOut: 0,
        overflowRejected: 0,
        aborted: 0,
        evictedAdvisory: 0,
      };
    }
    return this.stats;
  }

  /**
   * @returns {SessionQueueStats}
   */
  getStats() {
    const st = this._ensureStats();
    return {
      locked: Boolean(this._locked),
      queueLength: Array.isArray(this._queue) ? this._queue.length : 0,
      maxQueueSize: Number.isFinite(this.maxQueueSize) ? this.maxQueueSize : 0,
      defaultQueueTimeoutMs: Number.isFinite(this.defaultQueueTimeoutMs)
        ? this.defaultQueueTimeoutMs
        : 0,
      enqueued: st.enqueued,
      timedOut: st.timedOut,
      overflowRejected: st.overflowRejected,
      aborted: st.aborted,
      evictedAdvisory: st.evictedAdvisory,
    };
  }

  getActivePeerKey() {
    if (this._customGetActivePeerKey) {
      return String(this._customGetActivePeerKey() || "");
    }
    return this.lastPeerKey;
  }

  get isLocked() {
    return this._locked;
  }

  get queueLength() {
    return this._queue.length;
  }

  get pendingReactionCount() {
    return this._peerReactions.size;
  }

  /**
   * @param {QueueWaiter} waiter
   */
  _cleanupWaiterHooks(waiter) {
    if (!waiter) return;
    if (waiter.queueTimer) {
      clearTimeout(waiter.queueTimer);
      this._activeTimers?.delete(waiter.queueTimer);
      waiter.queueTimer = null;
    }
    if (waiter.signal && waiter.onAbort) {
      try {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      } catch (_rmErr) {
        // Benign: custom AbortSignal shim without removeEventListener.
      }
      waiter.onAbort = null;
    }
  }

  /**
   * @param {QueueWaiter} waiter
   * @param {Error} err
   */
  _evictQueuedWaiter(waiter, err) {
    if (!waiter || waiter.settled) return false;
    const idx = this._queue.indexOf(waiter);
    if (idx === -1) return false;
    this._queue.splice(idx, 1);
    waiter.settled = true;
    this._cleanupWaiterHooks(waiter);
    waiter.reject(err);
    return true;
  }

  /**
   * Executes `taskFn` with strict mutual exclusion over AIO session operations.
   * Supports both `runExclusive(peerKey, taskFn, options)` and `runExclusive(taskFn, options)`.
   *
   * @param {string | (() => Promise<any> | any)} peerKey
   * @param {((() => Promise<any> | any) | Record<string, any>)} [taskFn]
   * @param {Record<string, any>} [options={}]
   * @returns {Promise<any>}
   */
  runExclusive(peerKey, taskFn, options = {}) {
    if (typeof peerKey === "function") {
      options = taskFn && typeof taskFn === "object" ? taskFn : {};
      taskFn = peerKey;
      peerKey = options.peerKey || "";
    }
    if (typeof taskFn !== "function") {
      return Promise.reject(new TypeError("taskFn must be a function"));
    }

    const opts = options && typeof options === "object" ? options : {};
    const normPeerKey = peerKey ? String(peerKey) : "";
    const advisory = Boolean(opts.advisory);
    /** @type {AbortSignal | null} */
    const signal =
      opts.signal && typeof opts.signal === "object" && "aborted" in opts.signal
        ? /** @type {AbortSignal} */ (opts.signal)
        : null;
    const st = this._ensureStats();

    if (signal && signal.aborted) {
      st.aborted += 1;
      return Promise.reject(
        makeSessionQueueError(
          "ERR_SESSION_QUEUE_ABORTED",
          1499,
          "Outbound request was aborted before entering session lock"
        )
      );
    }

    const fnToRun = /** @type {() => Promise<any> | any} */ (taskFn);

    return new Promise((resolve, reject) => {
      /** @type {QueueWaiter} */
      const waiter = {
        peerKey: normPeerKey,
        advisory,
        taskFn: fnToRun,
        resolve,
        reject,
        queueTimer: null,
        signal,
        onAbort: null,
        settled: false,
      };

      if (!this._locked) {
        this._locked = true;
        this._affinityStreak = 0;
        this._executeWaiter(waiter);
        return;
      }

      const maxCap = Number.isFinite(this.maxQueueSize) ? Math.floor(this.maxQueueSize) : 0;
      if (maxCap > 0 && this._queue.length >= maxCap) {
        let madeRoom = false;
        if (!advisory) {
          const advIdx = this._queue.findIndex((w) => w.advisory && !w.settled);
          if (advIdx !== -1) {
            const [advWaiter] = this._queue.splice(advIdx, 1);
            advWaiter.settled = true;
            this._cleanupWaiterHooks(advWaiter);
            st.evictedAdvisory += 1;
            advWaiter.reject(
              makeSessionQueueError(
                "ERR_SESSION_QUEUE_EVICTED",
                1429,
                "Advisory session task evicted to admit explicit outbound action"
              )
            );
            madeRoom = true;
          }
        }
        if (!madeRoom) {
          st.overflowRejected += 1;
          reject(
            makeSessionQueueError(
              "ERR_SESSION_QUEUE_FULL",
              1429,
              `Outbound session queue is full (maxQueueSize=${maxCap})`
            )
          );
          return;
        }
      }

      const rawTimeout =
        opts.timeoutMs !== undefined && opts.timeoutMs !== null
          ? Number(opts.timeoutMs)
          : !advisory && Number.isFinite(this.defaultQueueTimeoutMs)
          ? this.defaultQueueTimeoutMs
          : 0;
      const effectiveTimeoutMs =
        Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.floor(rawTimeout) : 0;

      if (effectiveTimeoutMs > 0) {
        const timer = setTimeout(() => {
          this._activeTimers.delete(timer);
          waiter.queueTimer = null;
          if (
            this._evictQueuedWaiter(
              waiter,
              makeSessionQueueError(
                "ERR_SESSION_QUEUE_TIMEOUT",
                1429,
                `Timed out after ${effectiveTimeoutMs}ms waiting in outbound session queue`
              )
            )
          ) {
            st.timedOut += 1;
          }
        }, effectiveTimeoutMs);
        waiter.queueTimer = timer;
        this._activeTimers.add(timer);
      }

      if (signal && typeof signal.addEventListener === "function") {
        const onAbort = () => {
          waiter.onAbort = null;
          if (
            this._evictQueuedWaiter(
              waiter,
              makeSessionQueueError(
                "ERR_SESSION_QUEUE_ABORTED",
                1499,
                "Caller disconnected while waiting in outbound session queue"
              )
            )
          ) {
            st.aborted += 1;
          }
        };
        waiter.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      st.enqueued += 1;
      this._queue.push(waiter);
    });
  }

  /**
   * @param {QueueWaiter} waiter
   */
  _executeWaiter(waiter) {
    waiter.settled = true;
    this._cleanupWaiterHooks(waiter);
    Promise.resolve()
      .then(() => waiter.taskFn())
      .then(
        (result) => {
          this._advanceQueue();
          waiter.resolve(result);
        },
        (err) => {
          this._advanceQueue();
          waiter.reject(err);
        }
      );
  }

  _advanceQueue() {
    if (this._queue.length === 0) {
      this._locked = false;
      this._affinityStreak = 0;
      return;
    }

    const activePeerKey = this.getActivePeerKey();
    let chosenIdx = -1;

    if (activePeerKey && this._affinityStreak < this.maxAffinityStreak) {
      chosenIdx = this._queue.findIndex(
        (w) => !w.advisory && w.peerKey && w.peerKey === activePeerKey
      );
      if (chosenIdx === -1) {
        chosenIdx = this._queue.findIndex((w) => w.peerKey && w.peerKey === activePeerKey);
      }
      if (chosenIdx !== -1) {
        const [nextWaiter] = this._queue.splice(chosenIdx, 1);
        this._affinityStreak += 1;
        this._executeWaiter(nextWaiter);
        return;
      }
    }

    chosenIdx = this._queue.findIndex((w) => !w.advisory);
    if (chosenIdx === -1) {
      chosenIdx = 0;
    }
    const [nextWaiter] = this._queue.splice(chosenIdx, 1);
    this._affinityStreak = 0;
    this._executeWaiter(nextWaiter);
  }

  /**
   * Evaluates whether switching AIO focus to `targetPeerKey` should proceed, wait, or skip.
   */
  shouldAllowSwitch(targetPeerKey, { advisory = false, now = Date.now() } = {}) {
    const normTarget = targetPeerKey ? String(targetPeerKey) : "";
    const activePeerKey = this.getActivePeerKey();

    if (!normTarget || normTarget === activePeerKey) {
      return { allowed: true, waitMs: 0 };
    }

    if ((!this._hasSwitched && this.lastSwitchAt === 0) || this.switchCooldownMs <= 0) {
      return { allowed: true, waitMs: 0 };
    }

    const elapsed = Number(now) - this.lastSwitchAt;
    const remainingMs = this.switchCooldownMs - elapsed;
    if (remainingMs <= 0) {
      return { allowed: true, waitMs: 0 };
    }

    if (advisory === true) {
      return {
        allowed: false,
        waitMs: 0,
        skippedByCooldown: true,
        remainingMs,
      };
    }

    if (this.enforceHardCooldownOnExplicit === true) {
      return {
        allowed: true,
        waitMs: remainingMs,
      };
    }

    return { allowed: true, waitMs: 0 };
  }

  /**
   * Records an AIO switch to `targetPeerKey` at `now`.
   */
  recordSwitch(targetPeerKey, now = Date.now()) {
    const normTarget = targetPeerKey ? String(targetPeerKey) : "";
    if (!normTarget) return;
    this._hasSwitched = true;
    this.lastPeerKey = normTarget;
    this.lastSwitchAt = Number(now);
  }

  /**
   * Computes a concrete non-negative integer delay in milliseconds from a fixed number
   * or `[minMs, maxMs]` jitter range using `crypto.randomInt`.
   */
  computeDelayMs(spec, fallbackMs = 0) {
    if (typeof spec === "number") {
      if (Number.isFinite(spec) && spec >= 0) {
        return Math.floor(spec);
      }
      return this._resolveFallbackDelay(fallbackMs);
    }

    if (typeof spec === "string" && spec.trim() !== "") {
      const parsed = Number(spec);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return Math.floor(parsed);
      }
    }

    if (Array.isArray(spec)) {
      if (spec.length === 1) {
        return this.computeDelayMs(spec[0], fallbackMs);
      }
      if (spec.length >= 2) {
        const rawMin = Number(spec[0]);
        const rawMax = Number(spec[1]);
        if (Number.isFinite(rawMin) && Number.isFinite(rawMax) && rawMin >= 0 && rawMax >= 0) {
          const min = Math.floor(Math.min(rawMin, rawMax));
          const max = Math.floor(Math.max(rawMin, rawMax));
          if (max > min) {
            return crypto.randomInt(min, max + 1);
          }
          return min;
        }
      }
    }

    return this._resolveFallbackDelay(fallbackMs);
  }

  _resolveFallbackDelay(fallbackMs) {
    if (Array.isArray(fallbackMs)) {
      return this.computeDelayMs(fallbackMs, 0);
    }
    const n = Number(fallbackMs);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  /**
   * Sleeps for `ms` milliseconds using an `.unref()`ed timer tracked in `_activeTimers`
   * so `dispose()` cancels and resolves pending sleeps immediately on shutdown.
   *
   * @param {number} ms
   * @returns {Promise<void>}
   */
  sleepUnref(ms) {
    const delay = Number(ms);
    if (!Number.isFinite(delay) || delay <= 0) {
      return Promise.resolve();
    }

    return new Promise((/** @type {() => void} */ resolve) => {
      /** @type {{ timer: NodeJS.Timeout | null, resolve: () => void }} */
      const sleepRecord = { timer: null, resolve };
      const timer = setTimeout(() => {
        this._activeTimers.delete(timer);
        this._activeSleeps.delete(sleepRecord);
        resolve();
      }, delay);
      if (typeof timer.unref === "function") timer.unref();
      sleepRecord.timer = timer;
      this._activeTimers.add(timer);
      this._activeSleeps.add(sleepRecord);
    });
  }

  /**
   * Coalesces rapid incoming private messages per `peerKey` into a single delayed reaction.
   */
  schedulePrivateRecvReaction(peerKey, delaySpec, callback) {
    if (typeof delaySpec === "function") {
      callback = delaySpec;
      delaySpec = undefined;
    }
    const key = peerKey ? String(peerKey) : "";
    if (!key || typeof callback !== "function") {
      return null;
    }

    this.cancelPeerReaction(key);

    const effectiveSpec =
      delaySpec !== undefined && delaySpec !== null ? delaySpec : this.defaultPrivateRecvDelay;
    const delayMs = this.computeDelayMs(effectiveSpec, 500);

    /** @type {{ peerKey: string, timer: NodeJS.Timeout | null, delayMs: number }} */
    const entry = { peerKey: key, timer: null, delayMs };
    const timer = setTimeout(() => {
      this._activeTimers.delete(timer);
      if (this._peerReactions.get(key) === entry) {
        this._peerReactions.delete(key);
      }
      Promise.resolve()
        .then(() => callback(key))
        .catch((err) => {
          // Swallow unhandled reaction callback errors to prevent timer rejection crashes
          this._logger?.debug?.("session_scheduler.privateRecvReaction", err);
        });
    }, delayMs);
    if (typeof timer.unref === "function") timer.unref();

    entry.timer = timer;
    this._activeTimers.add(timer);
    this._peerReactions.set(key, entry);

    return {
      peerKey: key,
      delayMs,
      cancel: () => this.cancelPeerReaction(key),
    };
  }

  hasPendingReaction(peerKey) {
    return this._peerReactions.has(String(peerKey || ""));
  }

  cancelPeerReaction(peerKey) {
    const key = peerKey ? String(peerKey) : "";
    const entry = this._peerReactions.get(key);
    if (!entry) return false;
    if (entry.timer) {
      clearTimeout(entry.timer);
      this._activeTimers.delete(entry.timer);
    }
    this._peerReactions.delete(key);
    return true;
  }

  cancelAllReactions() {
    for (const entry of this._peerReactions.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        this._activeTimers.delete(entry.timer);
      }
    }
    this._peerReactions.clear();
  }

  /**
   * Immediately cancels all pending reaction timers, sleep timers, and queued waiter hooks without leaking handles.
   */
  dispose() {
    this.cancelAllReactions();
    for (const waiter of this._queue) {
      this._cleanupWaiterHooks(waiter);
    }
    for (const sleepRecord of this._activeSleeps) {
      if (sleepRecord.timer) {
        clearTimeout(sleepRecord.timer);
        this._activeTimers.delete(sleepRecord.timer);
      }
      sleepRecord.resolve();
    }
    this._activeSleeps.clear();
    for (const timer of this._activeTimers) {
      clearTimeout(timer);
    }
    this._activeTimers.clear();
    this._affinityStreak = 0;
  }
}

module.exports = {
  CausalSessionScheduler,
  makeSessionQueueError,
};
