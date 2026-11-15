"use strict";

const { isPrefixedEnvFlagOne } = require("./env");

// Native `Map.prototype.set`, captured at module load before any bridge hook is installed.
const NATIVE_MAP_SET = Map.prototype.set;

// Process-wide state of the temporary `Map.prototype.set` capture hook (one per process).
const MAP_HOOK_STATE = {
  owner: null, // NtqqOneBotBridge receiving captures
  hookFn: null, // our installed wrapper
  orig: null, // Map.prototype.set at install time
  inspecting: false, // re-entrancy guard
};

const ntCaptureMixin = {
  installMapPrototypeHook() {
    // Another bridge instance in this process (tests / hot reinstall) already owns our hook:
    // route captures to the newest instance instead of stacking a second wrapper.
    if (MAP_HOOK_STATE.hookFn && Map.prototype.set === MAP_HOOK_STATE.hookFn) {
      MAP_HOOK_STATE.owner = this;
      this._mapSetHook = MAP_HOOK_STATE.hookFn;
      this._scheduleMapHookMaxLifetime();
      return;
    }
    if (Map.prototype.__rosmontisBridgeHooked__) return;

    const origSet = Map.prototype.set;
    Object.defineProperty(Map.prototype, "__rosmontisBridgeHooked__", {
      value: true,
      enumerable: false,
      configurable: true,
    });

    const hookFn = function (k, v) {
      const res = origSet.call(this, k, v);
      const owner = MAP_HOOK_STATE.owner;
      if (owner && !MAP_HOOK_STATE.inspecting) {
        MAP_HOOK_STATE.inspecting = true;
        try {
          owner._inspectMapEntry(this, k, v);
        } catch (err) {
          try {
            owner.logger?.debug?.("nt_capture", err);
          } catch (_) {}
        } finally {
          MAP_HOOK_STATE.inspecting = false;
        }
      }
      return res;
    };

    MAP_HOOK_STATE.owner = this;
    MAP_HOOK_STATE.hookFn = hookFn;
    MAP_HOOK_STATE.orig = origSet;
    this._mapSetHook = hookFn;
    Map.prototype.set = hookFn;
    this._scheduleMapHookMaxLifetime();
  },

  _mapHookReleaseDisabled() {
    return (
      Boolean(this.config && this.config.keepMapHook) ||
      isPrefixedEnvFlagOne("KEEP_MAP_HOOK")
    );
  },

  _scheduleMapHookMaxLifetime() {
    if (this._mapHookReleaseDisabled() || this._mapHookMaxTimer) return;
    const maxMs = Number(this.config?.mapHookMaxLifetimeMs ?? 10 * 60 * 1000);
    if (!(maxMs > 0)) return;
    this._mapHookMaxTimer = setTimeout(() => {
      this._mapHookMaxTimer = null;
      this.releaseMapPrototypeHook("max_lifetime");
    }, maxMs);
    if (typeof this._mapHookMaxTimer.unref === "function") this._mapHookMaxTimer.unref();
  },

  _mapHookCapturesComplete() {
    const cs = this.capturedServices;
    let hasNtApi = false;
    try {
      hasNtApi = Boolean(
        cs.ntApi &&
          (typeof cs.ntApi["nodeIKernelMsgService/sendMsg"] === "function" ||
            (cs.ntApi.invoke && typeof cs.ntApi.invoke["nodeIKernelMsgService/sendMsg"] === "function"))
      );
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }
    return hasNtApi && Boolean(cs.ntStore) && Boolean(cs.wrapperSession || cs.ntSessionManager);
  },

  /**
   * Called after every successful capture. Once ntApi + ntStore + session are all captured,
   * schedule restoring the native `Map.prototype.set` (after a grace period so the second
   * `globalIPCMainMap` "ntApi" registration is still observed). Later kernel listeners keep
   * flowing through `ntStore.emitter`, the hooked `setNewListenEmitter`, the instance-level
   * `listenerEventEmitterMap.set` patch and the Inversify `binding.cache` watchers.
   */
  _maybeScheduleMapHookRelease() {
    if (!this._mapSetHook || this._mapHookReleaseTimer || this._mapHookReleaseDisabled()) return;
    if (MAP_HOOK_STATE.owner !== this) return;
    if (!this._mapHookCapturesComplete()) return;
    const delayMs = Math.max(0, Number(this.config?.mapHookReleaseDelayMs ?? 15000));
    this._mapHookReleaseTimer = setTimeout(() => {
      this._mapHookReleaseTimer = null;
      this.releaseMapPrototypeHook("captured");
    }, delayMs);
    if (typeof this._mapHookReleaseTimer.unref === "function") this._mapHookReleaseTimer.unref();
  },

  releaseMapPrototypeHook(reason = "manual") {
    for (const key of ["_mapHookReleaseTimer", "_mapHookMaxTimer"]) {
      if (this[key]) {
        clearTimeout(this[key]);
        this[key] = null;
      }
    }
    if (!this._mapSetHook || MAP_HOOK_STATE.owner !== this || MAP_HOOK_STATE.hookFn !== this._mapSetHook) {
      return false;
    }
    let restored = false;
    if (Map.prototype.set === MAP_HOOK_STATE.hookFn) {
      Map.prototype.set = MAP_HOOK_STATE.orig;
      try {
        delete Map.prototype.__rosmontisBridgeHooked__;
      } catch (err) {
        this.logger?.debug?.("nt_capture", err);
      }
      restored = true;
    }
    // If something wrapped Map.prototype.set on top of us we can not unlink safely; with no
    // owner our hook degrades to a pure pass-through.
    MAP_HOOK_STATE.owner = null;
    MAP_HOOK_STATE.hookFn = restored ? null : MAP_HOOK_STATE.hookFn;
    this._mapSetHook = null;
    this.mapHookRelease = { reason, restored, at: Date.now() };
    this._restoreModuleLoad();

    const missing = [];
    if (!this.capturedServices.ntApi) missing.push("ntApi");
    if (!this.capturedServices.ntStore) missing.push("ntStore");
    if (!this.capturedServices.wrapperSession && !this.capturedServices.ntSessionManager) missing.push("session");
    const releaseMsg = `Map.prototype.set hook released (reason=${reason}, restored=${restored}${
      missing.length ? `, missing=${missing.join("/")}` : ""
    })`;
    if (typeof this._logWarn === "function") {
      this._logWarn("map-hook-release", releaseMsg, 0);
    } else {
      this.logger?.warnThrottled?.("map-hook-release", releaseMsg, 0);
    }
    return restored;
  },

  installWrapperHook() {
    try {
      const Module = require("module");
      if (!Module || Module._load.__rosmontisWrapperHooked__) return;
      const origLoad = Module._load;
      const self = this;
      const wrappedLoad = function (request, parent, isMain) {
        const exp = origLoad.apply(this, [request, parent, isMain]);
        try {
          if (typeof request === "string" && request.includes("wrapper.node") && exp) {
            if (self._hookWrapperExports(exp)) {
              // wrapper.node is loaded once per process; stop intercepting every require().
              self._restoreModuleLoad();
            }
          }
        } catch (err) {
          try {
            self.logger?.debug?.("nt_capture", err);
          } catch (_) {}
        }
        return exp;
      };
      Object.defineProperty(wrappedLoad, "__rosmontisWrapperHooked__", {
        value: true,
        enumerable: false,
      });
      Module._load = wrappedLoad;
      this._moduleLoadHook = { Module, origLoad, wrappedLoad };
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }
  },

  _restoreModuleLoad() {
    const h = this._moduleLoadHook;
    if (!h) return false;
    this._moduleLoadHook = null;
    if (h.Module._load === h.wrappedLoad) {
      h.Module._load = h.origLoad;
      return true;
    }
    return false;
  },

  _hookWrapperExports(wrapperExports) {
    if (
      !wrapperExports ||
      (typeof wrapperExports !== "object" && typeof wrapperExports !== "function")
    ) {
      return false;
    }
    let matched = false;
    const SessionClass = wrapperExports.NodeIQQNTWrapperSession;
    const isWrapperSessionObj = (val) => {
      if (!val || typeof val !== "object" || val === SessionClass) return false;
      try {
        if (typeof SessionClass === "function" && val instanceof SessionClass) {
          return true;
        }
      } catch (_) {}
      try {
        const proto = Object.getPrototypeOf(val) || {};
        return (
          typeof val.getMsgService === "function" ||
          typeof proto.getMsgService === "function"
        );
      } catch (_) {
        return false;
      }
    };

    if (SessionClass && (typeof SessionClass === "function" || typeof SessionClass === "object")) {
      matched = true;
      let hookState = SessionClass.__rosmontisSessionHookState__;
      if (!hookState) {
        hookState = { owner: this };
        try {
          Object.defineProperty(SessionClass, "__rosmontisSessionHookState__", {
            value: hookState,
            enumerable: false,
            configurable: true,
          });
        } catch (_) {}
      } else {
        hookState.owner = this;
      }

      if (!SessionClass.__rosmontisHookedSessionClass__) {
        try {
          Object.defineProperty(SessionClass, "__rosmontisHookedSessionClass__", {
            value: true,
            enumerable: false,
            configurable: true,
          });
          for (const staticFn of ["get", "create", "getNTWrapperSession"]) {
            if (typeof SessionClass[staticFn] === "function") {
              const origFn = SessionClass[staticFn].bind(SessionClass);
              SessionClass[staticFn] = function (...args) {
                const inst = origFn(...args);
                const owner = hookState.owner;
                if (owner && inst && typeof inst === "object") {
                  owner.capturedServices.wrapperSession = inst;
                  owner._maybeScheduleMapHookRelease();
                }
                return inst;
              };
            }
          }
        } catch (err) {
          this.logger?.debug?.("nt_capture", err);
        }
      }

      try {
        const clsKeys = Reflect.ownKeys(SessionClass).slice(0, 32);
        for (const key of clsKeys) {
          if (key === "arguments" || key === "caller" || key === "prototype") continue;
          const desc = Object.getOwnPropertyDescriptor(SessionClass, key);
          if (!desc || !("value" in desc)) continue;
          if (isWrapperSessionObj(desc.value)) {
            this.capturedServices.wrapperSession = desc.value;
            this._maybeScheduleMapHookRelease();
            break;
          }
        }
      } catch (err) {
        this.logger?.debug?.("nt_capture", err);
      }
    }

    try {
      const expKeys = Reflect.ownKeys(wrapperExports).slice(0, 64);
      for (const key of expKeys) {
        if (key === "arguments" || key === "caller" || key === "prototype") continue;
        const desc = Object.getOwnPropertyDescriptor(wrapperExports, key);
        if (!desc || !("value" in desc)) continue;
        if (isWrapperSessionObj(desc.value)) {
          this.capturedServices.wrapperSession = desc.value;
          this._maybeScheduleMapHookRelease();
          matched = true;
          break;
        }
      }
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }

    return matched;
  },

  probeExistingRuntime(options = {}) {
    const summary = {
      wrapperModulesFound: 0,
      mapsScanned: 0,
      rmIpcChannels: [],
    };
    const opts = options && typeof options === "object" ? options : {};
    const seenMaps = new WeakSet();
    const seenObjs = new WeakSet();
    const MAX_MAPS = 128;
    const MAX_MAP_ENTRIES = 2000;

    const scanMap = (map) => {
      if (!(map instanceof Map) || seenMaps.has(map) || summary.mapsScanned >= MAX_MAPS) {
        return;
      }
      seenMaps.add(map);
      summary.mapsScanned += 1;
      let count = 0;
      try {
        for (const [k, v] of map.entries()) {
          if (count >= MAX_MAP_ENTRIES) break;
          count += 1;
          const prevInspecting = MAP_HOOK_STATE.inspecting;
          MAP_HOOK_STATE.inspecting = true;
          try {
            this._inspectMapEntry(map, k, v);
          } catch (err) {
            try {
              this.logger?.debug?.("nt_capture", err);
            } catch (_) {}
          } finally {
            MAP_HOOK_STATE.inspecting = prevInspecting;
          }
        }
      } catch (err) {
        this.logger?.debug?.("nt_capture", err);
      }
    };

    const inspectShallowObjectForMaps = (obj, maxKeys = 32) => {
      if (!obj || (typeof obj !== "object" && typeof obj !== "function") || seenObjs.has(obj)) {
        return;
      }
      seenObjs.add(obj);
      if (typeof obj === "object") {
        try {
          this._inspectInversifyCache(obj);
        } catch (_) {}
      }
      try {
        const keys = Reflect.ownKeys(obj).slice(0, maxKeys);
        for (const key of keys) {
          if (key === "arguments" || key === "caller" || key === "prototype") continue;
          let desc;
          try {
            desc = Object.getOwnPropertyDescriptor(obj, key);
          } catch (_) {
            continue;
          }
          if (!desc || !("value" in desc)) continue;
          const val = desc.value;
          if (val instanceof Map) {
            scanMap(val);
          } else if (key === "_bindingDictionary" && val && typeof val === "object") {
            try {
              const mapDesc = Object.getOwnPropertyDescriptor(val, "_map");
              if (mapDesc && "value" in mapDesc && mapDesc.value instanceof Map) {
                scanMap(mapDesc.value);
              }
            } catch (_) {}
          } else if (val && typeof val === "object" && !Array.isArray(val)) {
            try {
              const bdDesc = Object.getOwnPropertyDescriptor(val, "_bindingDictionary");
              if (bdDesc && "value" in bdDesc && bdDesc.value && typeof bdDesc.value === "object") {
                const mapDesc = Object.getOwnPropertyDescriptor(bdDesc.value, "_map");
                if (mapDesc && "value" in mapDesc && mapDesc.value instanceof Map) {
                  scanMap(mapDesc.value);
                }
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    };

    // 1. Retrospective Module._cache scan for already-loaded wrapper.node
    try {
      const Module = require("module");
      const cache = opts.moduleCache || (Module && Module._cache);
      if (cache && typeof cache === "object") {
        const cacheKeys = Object.keys(cache);
        const limit = Math.min(cacheKeys.length, 5000);
        for (let i = 0; i < limit; i += 1) {
          const cacheKey = cacheKeys[i];
          try {
            const desc = Object.getOwnPropertyDescriptor(cache, cacheKey);
            if (!desc || !("value" in desc)) continue;
            const mod = desc.value;
            const filename = mod && typeof mod.filename === "string" ? mod.filename : "";
            const modId = mod && typeof mod.id === "string" ? mod.id : "";
            if (
              /wrapper\.node$/i.test(cacheKey) ||
              /wrapper\.node$/i.test(filename) ||
              /wrapper\.node$/i.test(modId)
            ) {
              const exp = mod ? mod.exports : null;
              if (exp && (typeof exp === "object" || typeof exp === "function")) {
                if (this._hookWrapperExports(exp)) {
                  summary.wrapperModulesFound += 1;
                }
              }
            }
          } catch (err) {
            this.logger?.debug?.("nt_capture", err);
          }
        }
      }
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }

    // 2. Read-only inspection of electron.ipcMain (_events & own data properties)
    try {
      let ipcMain = opts.ipcMain || opts.electron?.ipcMain || null;
      if (!ipcMain && process.versions?.electron) {
        try {
          const electronMod = require("electron");
          if (electronMod && typeof electronMod === "object") {
            ipcMain = electronMod.ipcMain || null;
          }
        } catch (_) {}
      }
      if (ipcMain && typeof ipcMain === "object") {
        try {
          const eventsDesc = Object.getOwnPropertyDescriptor(ipcMain, "_events");
          const eventsObj = eventsDesc && "value" in eventsDesc ? eventsDesc.value : null;
          if (eventsObj && typeof eventsObj === "object") {
            const evKeys = Reflect.ownKeys(eventsObj).slice(0, 256);
            for (const evKey of evKeys) {
              if (typeof evKey === "string" && evKey.startsWith("RM_IPCFROM_RENDERER")) {
                summary.rmIpcChannels.push(evKey);
              }
              let evDesc;
              try {
                evDesc = Object.getOwnPropertyDescriptor(eventsObj, evKey);
              } catch (_) {
                continue;
              }
              if (!evDesc || !("value" in evDesc) || !evDesc.value) continue;
              const listeners = Array.isArray(evDesc.value) ? evDesc.value : [evDesc.value];
              for (const fn of listeners.slice(0, 32)) {
                inspectShallowObjectForMaps(fn, 32);
              }
            }
          }
        } catch (_) {}
        inspectShallowObjectForMaps(ipcMain, 128);
      }
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }

    // 3. Safe own-key scan of globalThis (strictly skipping getters)
    try {
      const targetGlobal =
        opts.globalObject || (typeof globalThis !== "undefined" ? globalThis : global);
      if (targetGlobal && typeof targetGlobal === "object") {
        const gKeys = Reflect.ownKeys(targetGlobal).slice(0, 2000);
        for (const gKey of gKeys) {
          if (
            gKey === "global" ||
            gKey === "globalThis" ||
            gKey === "process" ||
            gKey === "console"
          ) {
            continue;
          }
          let desc;
          try {
            desc = Object.getOwnPropertyDescriptor(targetGlobal, gKey);
          } catch (_) {
            continue;
          }
          if (!desc || !("value" in desc)) continue;
          const gVal = desc.value;
          if (gVal instanceof Map) {
            scanMap(gVal);
          } else if (
            gVal &&
            typeof gVal === "object" &&
            !Array.isArray(gVal) &&
            !(typeof Buffer !== "undefined" && Buffer.isBuffer(gVal))
          ) {
            try {
              this._inspectInversifyCache(gVal);
            } catch (_) {}
            if (
              typeof gKey === "symbol" ||
              (typeof gKey === "string" && /nt|qq|ipc|inversify|container|store/i.test(gKey))
            ) {
              inspectShallowObjectForMaps(gVal, 32);
            } else {
              try {
                const bdDesc = Object.getOwnPropertyDescriptor(gVal, "_bindingDictionary");
                if (bdDesc && "value" in bdDesc && bdDesc.value && typeof bdDesc.value === "object") {
                  const mapDesc = Object.getOwnPropertyDescriptor(bdDesc.value, "_map");
                  if (mapDesc && "value" in mapDesc && mapDesc.value instanceof Map) {
                    scanMap(mapDesc.value);
                  }
                }
              } catch (_) {}
            }
          }
        }
      }
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }

    return summary;
  },

  _inspectMapEntry(_mapInstance, k, v) {
    // 1. String keys in Inversify or globalIPCMainMap or listenerEventEmitterMap
    if (typeof k === "string") {
      if (k === "ntApi" && v && !Array.isArray(v)) {
        // First registration is the direct ntApi route Proxy; second registration in
        // globalIPCMainMap is `{ emit: Proxy, invoke: Proxy }` where `v.invoke` is the route Proxy.
        if (typeof v["nodeIKernelMsgService/sendMsg"] === "function") {
          this.capturedServices.ntApi = v;
        } else if (
          v.invoke &&
          typeof v.invoke["nodeIKernelMsgService/sendMsg"] === "function"
        ) {
          this.capturedServices.ntApi = v.invoke;
        } else if (!this.capturedServices.ntApi) {
          this.capturedServices.ntApi = v;
        }
        this.capturedServices.ntApiContainer = v;
        this._maybeScheduleMapHookRelease();
        return;
      }
      if (
        k === "WindowApi" ||
        k === "PerformanceApi" ||
        k === "LoggerApi" ||
        k === "UserBehaviorReportService" ||
        k === "SubWindowApi" ||
        k === "ScreenRecordApi" ||
        k === "ntCall"
      ) {
        this.capturedServices[k] = v;
        return;
      }
      if (k.startsWith("nodeIKernel") && k.endsWith("Listener") && v) {
        this._attachKernelListenerEmitter(k, v);
        return;
      }
    }

    // 2. Symbol or Inversify binding arrays: [{ cache, implementationType, type }]
    if (Array.isArray(v)) {
      for (const binding of v) {
        if (!binding || typeof binding !== "object") continue;
        if (binding.cache) {
          this._inspectInversifyCache(binding.cache);
        } else if ("cache" in binding) {
          this._watchBindingCacheProperty(binding);
        }
      }
    } else if (v && typeof v === "object") {
      this._inspectInversifyCache(v);
    }
  },

  _watchBindingCacheProperty(binding) {
    if (binding.__rosmontisWatched__) return;
    try {
      Object.defineProperty(binding, "__rosmontisWatched__", {
        value: true,
        enumerable: false,
      });
      let currentCache = binding.cache;
      const self = this;
      Object.defineProperty(binding, "cache", {
        configurable: true,
        enumerable: true,
        get() {
          return currentCache;
        },
        set(newVal) {
          currentCache = newVal;
          try {
            self._inspectInversifyCache(newVal);
          } catch (err) {
            try {
              self.logger?.debug?.("nt_capture", err);
            } catch (_) {}
          }
        },
      });
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }
  },

  _updateSelfIdentity({ uin, uid, nick, nickname, markOnline = false } = {}) {
    const prevUin = this.selfUin;
    if (uin && /^\d+$/.test(String(uin))) {
      this.selfUin = String(uin);
    }
    if (uid && String(uid).trim()) {
      this.selfUid = String(uid).trim();
    }
    const incomingNick =
      nick !== undefined && nick !== null && String(nick).trim() !== "" ? nick : nickname;
    if (incomingNick && String(incomingNick).trim()) {
      this.selfNickname = String(incomingNick).trim();
    }
    if (this.selfUin && this.selfUid) {
      const cleanNick =
        this.selfNickname && this.selfNickname !== "QQBot" ? this.selfNickname : "";
      this.uinUidStore?.record?.(this.selfUin, this.selfUid, {
        nickname: cleanNick,
        nick: cleanNick,
      });
    }
    if (markOnline) {
      const wasOnline = this.online;
      this.online = true;
      if (!wasOnline && this.config.autoQuickLogin !== false && !this._persistedAutoLogin) {
        this._persistedAutoLogin = true;
        const t = setTimeout(() => {
          this.invokeNt("nodeIKernelLoginService/setAutoLogin", { shouldAutoLogin: true }, [true]).catch(() => {});
          this.invokeNt("nodeIKernelSettingService/setAutoLoginSwitch", { state: true }, [true]).catch(() => {});
        }, 1000);
        if (t && typeof t.unref === "function") t.unref();
      }
    }
    if ((!prevUin || prevUin === "0") && this.selfUin && this.selfUin !== "0") {
      this._reconnectUnidentifiedReverseWs();
    }
  },

  _reconnectUnidentifiedReverseWs() {
    if (!this.selfUin || this.selfUin === "0") return;
    for (const rev of this._reverseWsClients) {
      if (!rev.stopped && rev.conn && (!rev.connectedSelfId || rev.connectedSelfId === "0")) {
        rev.immediateReconnectOnce = true;
        try {
          rev.conn.close();
        } catch (_) {}
      }
    }
  },

  _inspectInversifyCache(obj) {
    if (!obj || typeof obj !== "object") return;
    const proto = Object.getPrototypeOf(obj) || {};

    // Check if obj is ntStore (has listenerEventEmitterMap, setNewListenEmitter, or emitter + session)
    if (
      obj.listenerEventEmitterMap instanceof Map ||
      typeof obj.setNewListenEmitter === "function" ||
      typeof proto.setNewListenEmitter === "function" ||
      (obj.emitter &&
        typeof obj.emitter.emit === "function" &&
        ("listenerEventEmitterMap" in obj || "wrapperSession" in obj || "session" in obj))
    ) {
      this._inspectNtStore(obj);
    }

    // Check if obj is ntSessionManager (has createNt or ntStore)
    if (
      typeof obj.createNt === "function" ||
      typeof proto.createNt === "function" ||
      (obj.ntStore && typeof obj.ntStore === "object")
    ) {
      this.capturedServices.ntSessionManager = obj;
      this._hookNtSessionManager(obj);
      this._maybeScheduleMapHookRelease();
    }

    // Check if obj is authMgr (has initAppSessionAndWindowPool) to auto-sync selfUin/selfUid/selfNickname
    if (
      typeof obj.initAppSessionAndWindowPool === "function" ||
      typeof proto.initAppSessionAndWindowPool === "function"
    ) {
      if (!obj.__rosmontisHookedAuthMgr__) {
        try {
          Object.defineProperty(obj, "__rosmontisHookedAuthMgr__", {
            value: true,
            enumerable: false,
          });
          const origInitPool = obj.initAppSessionAndWindowPool;
          const self = this;
          obj.initAppSessionAndWindowPool = function (authInfo, ...rest) {
            try {
              if (authInfo && typeof authInfo === "object") {
                self._updateSelfIdentity({
                  uin: authInfo.uin,
                  uid: authInfo.uid,
                  nick: authInfo.nick || authInfo.nickName,
                  markOnline: true,
                });
              }
            } catch (err) {
              try {
                self.logger?.debug?.("nt_capture", err);
              } catch (_) {}
            }
            return origInitPool.apply(this, [authInfo, ...rest]);
          };
        } catch (err) {
          this.logger?.debug?.("nt_capture", err);
        }
      }
    }

    // Check if obj is NodeIQQNTWrapperSession (has getMsgService & getGroupService)
    if (
      typeof obj.getMsgService === "function" ||
      typeof proto.getMsgService === "function"
    ) {
      this.capturedServices.wrapperSession = obj;
      this._maybeScheduleMapHookRelease();
    }

    // Check if obj is a direct or wrapped ntApi router inside an Inversify binding cache
    try {
      if (typeof obj["nodeIKernelMsgService/sendMsg"] === "function") {
        this.capturedServices.ntApi = obj;
        this._maybeScheduleMapHookRelease();
      } else if (
        obj.invoke &&
        typeof obj.invoke["nodeIKernelMsgService/sendMsg"] === "function"
      ) {
        this.capturedServices.ntApi = obj.invoke;
        this._maybeScheduleMapHookRelease();
      }
    } catch (_) {}
  },

  _inspectNtStore(ntStore) {
    if (!ntStore || typeof ntStore !== "object") return;
    this.capturedServices.ntStore = ntStore;
    if (ntStore.wrapperSession || ntStore.session) {
      this.capturedServices.wrapperSession = ntStore.wrapperSession || ntStore.session;
    }
    if (ntStore.emitter && typeof ntStore.emitter === "object") {
      this._attachNtStoreRootEmitter(ntStore.emitter);
    }
    if (ntStore.listenerEventEmitterMap instanceof Map) {
      for (const [listenerName, emitter] of ntStore.listenerEventEmitterMap.entries()) {
        this._attachKernelListenerEmitter(listenerName, emitter);
      }
      this._patchListenerEmitterMapInstance(ntStore.listenerEventEmitterMap);
    }
    if (typeof ntStore.setNewListenEmitter === "function" && !ntStore.__rosmontisHookedSetNew__) {
      try {
        Object.defineProperty(ntStore, "__rosmontisHookedSetNew__", {
          value: true,
          enumerable: false,
        });
        const origSetNew = ntStore.setNewListenEmitter;
        const self = this;
        ntStore.setNewListenEmitter = function (listenerName, emitter, ...rest) {
          const res = origSetNew.apply(this, [listenerName, emitter, ...rest]);
          try {
            if (listenerName && emitter) {
              self._attachKernelListenerEmitter(String(listenerName), emitter);
            }
          } catch (err) {
            try {
              self.logger?.debug?.("nt_capture", err);
            } catch (_) {}
          }
          return res;
        };
      } catch (err) {
        this.logger?.debug?.("nt_capture", err);
      }
    }
    this._maybeScheduleMapHookRelease();
  },

  /**
   * Instance-level replacement for the global `Map.prototype.set` hook on the one Map that
   * keeps receiving kernel listener emitters after startup, so the global hook can be released.
   */
  _patchListenerEmitterMapInstance(map) {
    if (!(map instanceof Map) || Object.prototype.hasOwnProperty.call(map, "set")) return;
    const self = this;
    try {
      Object.defineProperty(map, "set", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function (k, v) {
          const res = NATIVE_MAP_SET.call(this, k, v);
          try {
            if (typeof k === "string" && v) {
              self._attachKernelListenerEmitter(k, v);
            }
          } catch (err) {
            try {
              self.logger?.debug?.("nt_capture", err);
            } catch (_) {}
          }
          return res;
        },
      });
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }
  },

  _attachNtStoreRootEmitter(emitter) {
    if (!emitter || typeof emitter.emit !== "function") return;
    if (this._attachedEmitters.has(emitter)) return;
    this._attachedEmitters.add(emitter);
    const origEmit = emitter.emit;
    const self = this;
    emitter.emit = function (fullEventName, ...args) {
      try {
        const name = String(fullEventName || "");
        const sepIdx = name.indexOf("-") >= 0 ? name.indexOf("-") : name.indexOf("/");
        if (sepIdx > 0) {
          const listenerName = name.slice(0, sepIdx);
          const shortEvent = name.slice(sepIdx + 1);
          if (listenerName && shortEvent) {
            self._handleKernelEvent(listenerName, shortEvent, args);
          }
        }
      } catch (err) {
        try {
          self.logger?.debug?.("nt_capture", err);
        } catch (_) {}
      }
      return origEmit.apply(this, [fullEventName, ...args]);
    };
  },

  _hookNtSessionManager(mgr) {
    if (!mgr || mgr.__rosmontisHooked__) return;
    try {
      Object.defineProperty(mgr, "__rosmontisHooked__", { value: true, enumerable: false });
    } catch (err) {
      this.logger?.debug?.("nt_capture", err);
    }

    if (mgr.ntStore) {
      this._inspectNtStore(mgr.ntStore);
    }

    if (typeof mgr.createNt === "function") {
      const origCreateNt = mgr.createNt;
      const self = this;
      mgr.createNt = function (...args) {
        const session = origCreateNt.apply(this, args);
        if (session && typeof session === "object") {
          self.capturedServices.wrapperSession = session;
          if (self.selfUid) {
            self.online = true;
          }
        }
        if (this.ntStore) {
          self._inspectNtStore(this.ntStore);
        }
        self._maybeScheduleMapHookRelease();
        return session;
      };
    }
  },

  _attachKernelListenerEmitter(listenerName, emitterOrMap) {
    if (!emitterOrMap || typeof emitterOrMap !== "object") return;
    if (emitterOrMap instanceof Map) {
      for (const sub of emitterOrMap.values()) {
        this._attachKernelListenerEmitter(listenerName, sub);
      }
      return;
    }
    if (this._attachedEmitters.has(emitterOrMap)) return;
    if (typeof emitterOrMap.on !== "function" && typeof emitterOrMap.emit !== "function") return;
    this._attachedEmitters.add(emitterOrMap);

    const self = this;
    if (typeof emitterOrMap.emit === "function") {
      const origEmit = emitterOrMap.emit;
      emitterOrMap.emit = function (eventName, ...args) {
        try {
          self._handleKernelEvent(listenerName, String(eventName), args);
        } catch (err) {
          try {
            self.logger?.debug?.("nt_capture", err);
          } catch (_) {}
        }
        return origEmit.apply(this, [eventName, ...args]);
      };
    }
  },
};

module.exports = {
  NATIVE_MAP_SET,
  MAP_HOOK_STATE,
  ntCaptureMixin,
};
