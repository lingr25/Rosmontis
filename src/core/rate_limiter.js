// @ts-check
"use strict";

/**
 * Outbound Rate Limiter & Circuit Breaker (`src/core/rate_limiter.js`)
 *
 * Pure-JS zero-dependency token-bucket rate limiter (global + bounded per-peer LRU)
 * with consecutive-rejection circuit breaker (`closed` -> `open` -> `half_open` -> `closed`).
 * Disabled by default (`enabled: false`) so unconfigured bridges retain full backward compatibility.
 */

const { BoundedMap } = require("./primitives");

const DEFAULT_RATE_LIMIT_CONFIG = Object.freeze({
  enabled: false,
  globalPerSec: 10,
  globalBurst: 20,
  perPeerPerSec: 2,
  perPeerBurst: 5,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 30000,
  maxPeers: 2000,
});

function parseNonNegativeNumber(val, fallback) {
  if (val === undefined || val === null || val === "") return fallback;
  const num = Number(val);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

function parseNonNegativeInt(val, fallback) {
  if (val === undefined || val === null || val === "") return fallback;
  const num = Number(val);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : fallback;
}

function parsePositiveInt(val, fallback) {
  if (val === undefined || val === null || val === "") return fallback;
  const num = Number(val);
  return Number.isFinite(num) && num >= 1 ? Math.trunc(num) : fallback;
}

function normalizeRateLimitConfig(cfg) {
  const src = cfg && typeof cfg === "object" ? cfg : {};
  return {
    enabled: Boolean(src.enabled),
    globalPerSec: parseNonNegativeNumber(src.globalPerSec, DEFAULT_RATE_LIMIT_CONFIG.globalPerSec),
    globalBurst: parseNonNegativeNumber(src.globalBurst, DEFAULT_RATE_LIMIT_CONFIG.globalBurst),
    perPeerPerSec: parseNonNegativeNumber(
      src.perPeerPerSec,
      DEFAULT_RATE_LIMIT_CONFIG.perPeerPerSec
    ),
    perPeerBurst: parseNonNegativeNumber(src.perPeerBurst, DEFAULT_RATE_LIMIT_CONFIG.perPeerBurst),
    circuitBreakerThreshold: parseNonNegativeInt(
      src.circuitBreakerThreshold,
      DEFAULT_RATE_LIMIT_CONFIG.circuitBreakerThreshold
    ),
    circuitBreakerCooldownMs: parseNonNegativeNumber(
      src.circuitBreakerCooldownMs,
      DEFAULT_RATE_LIMIT_CONFIG.circuitBreakerCooldownMs
    ),
    maxPeers: parsePositiveInt(src.maxPeers, DEFAULT_RATE_LIMIT_CONFIG.maxPeers),
  };
}

class OutboundRateLimiter {
  /**
   * @param {object} [options]
   * @param {boolean} [options.enabled=false]
   * @param {number} [options.globalPerSec=10]
   * @param {number} [options.globalBurst=20]
   * @param {number} [options.perPeerPerSec=2]
   * @param {number} [options.perPeerBurst=5]
   * @param {number} [options.circuitBreakerThreshold=5]
   * @param {number} [options.circuitBreakerCooldownMs=30000]
   * @param {number} [options.maxPeers=2000]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    const src = options && typeof options === "object" ? options : {};
    const customNow = typeof src.now === "function" ? src.now : null;
    this._hasCustomClock = Boolean(customNow);
    /** @type {() => number} */
    this._now = customNow || (() => Date.now());
    this._usedExplicitNow = false;
    this._config = normalizeRateLimitConfig(src);

    /** @type {{ tokens: number, lastRefillAt: number } | null} */
    this._globalBucket = null;
    /** @type {Map<string, { tokens: number, lastRefillAt: number }> & { maxEntries: number }} */
    this._peerBuckets = new BoundedMap(this._config.maxPeers);

    /** @type {"closed" | "open" | "half_open"} */
    this._circuitState = "closed";
    this._circuitOpenUntil = 0;
    this._consecutiveRejections = 0;

    this._stats = {
      allowed: 0,
      rejected: 0,
      globalRejected: 0,
      peerRejected: 0,
      circuitRejected: 0,
      circuitOpens: 0,
    };
  }

  get enabled() {
    return this._config.enabled;
  }

  get config() {
    return { ...this._config };
  }

  _resolveNow(nowArg) {
    if (nowArg !== undefined && nowArg !== null && Number.isFinite(Number(nowArg))) {
      this._usedExplicitNow = true;
      return Number(nowArg);
    }
    return Number(this._now());
  }

  _refillBucket(bucket, ratePerSec, burst, ts) {
    const elapsedMs = Math.max(0, ts - bucket.lastRefillAt);
    if (elapsedMs > 0) {
      if (ratePerSec > 0) {
        bucket.tokens = Math.min(burst, bucket.tokens + (elapsedMs / 1000) * ratePerSec);
      }
      bucket.lastRefillAt = ts;
    }
    if (bucket.tokens > burst) {
      bucket.tokens = burst;
    }
  }

  _retryAfterForDeficit(tokens, ratePerSec) {
    const deficit = Math.max(0, 1 - tokens);
    if (deficit <= 0) return 0;
    if (ratePerSec > 0) {
      return Math.max(1, Math.ceil((deficit / ratePerSec) * 1000));
    }
    return Math.max(1, Math.ceil(this._config.circuitBreakerCooldownMs || 1000));
  }

  _recordBucketRejection(ts, wasHalfOpen, bucketRetryMs) {
    this._consecutiveRejections += 1;
    const threshold = this._config.circuitBreakerThreshold;
    if (wasHalfOpen || (threshold > 0 && this._consecutiveRejections >= threshold)) {
      this._circuitState = "open";
      this._circuitOpenUntil = ts + this._config.circuitBreakerCooldownMs;
      this._stats.circuitOpens += 1;
      return Math.max(bucketRetryMs, Math.ceil(this._config.circuitBreakerCooldownMs));
    }
    return bucketRetryMs;
  }

  /**
   * Attempts to consume 1 outbound token (circuit breaker -> global bucket -> per-peer bucket).
   * If global passes and per-peer fails, the global token is refunded so a noisy peer never
   * starves other peers.
   *
   * @param {string} [peerKey="default"]
   * @param {number} [now]
   * @returns {{ allowed: boolean, reason: string, retryAfterMs: number, state: "closed" | "open" | "half_open" }}
   */
  consume(peerKey = "default", now = undefined) {
    if (!this._config.enabled) {
      return {
        allowed: true,
        reason: "disabled",
        retryAfterMs: 0,
        state: this._circuitState,
      };
    }

    const ts = this._resolveNow(now);

    // 1. Circuit breaker check
    let wasHalfOpen = this._circuitState === "half_open";
    if (this._circuitState === "open") {
      const remaining = this._circuitOpenUntil - ts;
      if (remaining > 0) {
        this._stats.rejected += 1;
        this._stats.circuitRejected += 1;
        return {
          allowed: false,
          reason: "circuit_open",
          retryAfterMs: Math.max(1, Math.ceil(remaining)),
          state: "open",
        };
      }
      this._circuitState = "half_open";
      wasHalfOpen = true;
    }

    // 2. Global token bucket check
    if (!this._globalBucket) {
      this._globalBucket = {
        tokens: this._config.globalBurst,
        lastRefillAt: ts,
      };
    } else {
      this._refillBucket(
        this._globalBucket,
        this._config.globalPerSec,
        this._config.globalBurst,
        ts
      );
    }

    if (this._globalBucket.tokens < 1) {
      this._stats.rejected += 1;
      this._stats.globalRejected += 1;
      const retryMs = this._retryAfterForDeficit(
        this._globalBucket.tokens,
        this._config.globalPerSec
      );
      const retryAfterMs = this._recordBucketRejection(ts, wasHalfOpen, retryMs);
      return {
        allowed: false,
        reason: "global_rate_limit",
        retryAfterMs,
        state: this._circuitState,
      };
    }

    // Tentatively deduct global token; refund below if per-peer bucket rejects.
    this._globalBucket.tokens -= 1;

    // 3. Per-peer token bucket check
    const key = String(peerKey || "default");
    let peerBucket = this._peerBuckets.get(key);
    if (!peerBucket) {
      peerBucket = {
        tokens: this._config.perPeerBurst,
        lastRefillAt: ts,
      };
      this._peerBuckets.set(key, peerBucket);
    } else {
      this._refillBucket(
        peerBucket,
        this._config.perPeerPerSec,
        this._config.perPeerBurst,
        ts
      );
    }

    if (peerBucket.tokens < 1) {
      // Refund global token so a single noisy peer cannot starve other peers.
      this._globalBucket.tokens = Math.min(
        this._config.globalBurst,
        this._globalBucket.tokens + 1
      );
      this._stats.rejected += 1;
      this._stats.peerRejected += 1;
      const retryMs = this._retryAfterForDeficit(
        peerBucket.tokens,
        this._config.perPeerPerSec
      );
      const retryAfterMs = this._recordBucketRejection(ts, wasHalfOpen, retryMs);
      return {
        allowed: false,
        reason: "peer_rate_limit",
        retryAfterMs,
        state: this._circuitState,
      };
    }

    peerBucket.tokens -= 1;

    // Allowed: close circuit (if half_open) and clear consecutive rejections.
    this._consecutiveRejections = 0;
    this._circuitState = "closed";
    this._circuitOpenUntil = 0;
    this._stats.allowed += 1;

    return {
      allowed: true,
      reason: "ok",
      retryAfterMs: 0,
      state: "closed",
    };
  }

  /**
   * Live hot-reload of rate limiter settings while preserving cumulative stats.
   *
   * @param {import("../types").RateLimitConfig & { now?: () => number }} [nextCfg={}]
   * @returns {import("../types").RateLimitConfig}
   */
  updateConfig(nextCfg = {}) {
    const src = nextCfg && typeof nextCfg === "object" ? nextCfg : {};
    if (typeof src.now === "function") {
      this._now = src.now;
      this._hasCustomClock = true;
    }
    this._config = normalizeRateLimitConfig(src);
    this._peerBuckets.maxEntries = this._config.maxPeers;
    while (this._peerBuckets.size > this._config.maxPeers) {
      const oldest = this._peerBuckets.keys().next();
      if (oldest.done) break;
      this._peerBuckets.delete(oldest.value);
    }
    if (this._globalBucket && this._globalBucket.tokens > this._config.globalBurst) {
      this._globalBucket.tokens = this._config.globalBurst;
    }
    for (const bucket of this._peerBuckets.values()) {
      if (bucket && bucket.tokens > this._config.perPeerBurst) {
        bucket.tokens = this._config.perPeerBurst;
      }
    }
    return this.config;
  }

  /**
   * Returns snapshot of cumulative counters, circuit breaker state, and active peer count.
   *
   * @param {number} [now]
   * @returns {import("../types").RateLimitStats}
   */
  getStats(now = undefined) {
    let circuitState = this._circuitState;
    if (circuitState === "open") {
      /** @type {number | null} */
      let checkTs = null;
      if (now !== undefined && now !== null && Number.isFinite(Number(now))) {
        checkTs = Number(now);
      } else if (this._hasCustomClock || !this._usedExplicitNow) {
        checkTs = Number(this._now());
      }
      if (checkTs !== null && checkTs >= this._circuitOpenUntil) {
        circuitState = "half_open";
      }
    }
    return {
      enabled: this._config.enabled,
      allowed: this._stats.allowed,
      rejected: this._stats.rejected,
      globalRejected: this._stats.globalRejected,
      peerRejected: this._stats.peerRejected,
      circuitRejected: this._stats.circuitRejected,
      circuitOpens: this._stats.circuitOpens,
      circuitState,
      activePeers: this._peerBuckets.size,
    };
  }

  /**
   * Resets all buckets, circuit breaker state, and cumulative stats.
   */
  reset() {
    this._globalBucket = null;
    this._peerBuckets.clear();
    this._circuitState = "closed";
    this._circuitOpenUntil = 0;
    this._consecutiveRejections = 0;
    this._usedExplicitNow = false;
    this._stats = {
      allowed: 0,
      rejected: 0,
      globalRejected: 0,
      peerRejected: 0,
      circuitRejected: 0,
      circuitOpens: 0,
    };
  }
}

module.exports = {
  OutboundRateLimiter,
  DEFAULT_RATE_LIMIT_CONFIG,
  normalizeRateLimitConfig,
};
