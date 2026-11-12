"use strict";

const HANDLED_ACTIONS = new Set([
  "get_friend_list",
  "get_stranger_info",
  "delete_friend",
  "set_friend_add_request",
  "set_friend_remark",
  "get_doubt_friends_add_request",
  "set_doubt_friends_add_request",
  "get_friend_With_category",
  "get_friends_with_category",
]);

async function dispatch(action, p, context = {}) {
  switch (action) {
    // ---- 5. Friends ----
    case "get_friend_list": {
      let cancelWait = null;
      const waitBuddyEvent = new Promise((resolve) => {
        const onUpdate = (payload) => {
          clearTimeout(timer);
          this._buddyListWaiters.delete(onUpdate);
          resolve(payload);
        };
        const timer = setTimeout(() => {
          this._buddyListWaiters.delete(onUpdate);
          resolve(null);
        }, 1200);
        if (typeof timer.unref === "function") timer.unref();
        cancelWait = () => {
          clearTimeout(timer);
          this._buddyListWaiters.delete(onUpdate);
          resolve(null);
        };
        this._buddyListWaiters.add(onUpdate);
      });

      const forceRefresh = Boolean(p.no_cache);
      let res = null;
      try {
        res = await this.invokeNt(
          "nodeIKernelBuddyService/getBuddyList",
          { force_update: forceRefresh, noCache: forceRefresh },
          [forceRefresh]
        );
      } catch (_) {}

      let directCats = Array.isArray(res)
        ? res
        : Array.isArray(res?.buddyCategory)
        ? res.buddyCategory
        : Array.isArray(res?.data)
        ? res.data
        : [];

      if (directCats.length === 0) {
        try {
          const v2Cache = await this.invokeNt(
            "nodeIKernelBuddyService/getBuddyListFromCache",
            { buddyListReqType: 0 },
            [0]
          );
          const v2Cats = Array.isArray(v2Cache)
            ? v2Cache
            : Array.isArray(v2Cache?.data)
            ? v2Cache.data
            : Array.isArray(v2Cache?.buddyCategory)
            ? v2Cache.buddyCategory
            : [];
          if (v2Cats.length > 0) {
            res = v2Cache;
            directCats = v2Cats;
          }
        } catch (_) {}
      }

      if (directCats.length === 0 || forceRefresh) {
        try {
          const v2Res = await this.invokeNt(
            "nodeIKernelBuddyService/getBuddyListV2",
            { callFrom: "ContactNodeStore", forceRefresh, reqType: 0 },
            ["ContactNodeStore", forceRefresh, 0]
          );
          const v2Cats = Array.isArray(v2Res)
            ? v2Res
            : Array.isArray(v2Res?.data)
            ? v2Res.data
            : Array.isArray(v2Res?.buddyCategory)
            ? v2Res.buddyCategory
            : [];
          if (v2Cats.length > 0) {
            res = v2Res;
            directCats = v2Cats;
          }
        } catch (_) {}
      }

      if (directCats.length > 0) {
        if (cancelWait) cancelWait();
        this.uinUidStore.rememberFromBuddyList(res);
        this._buddyCategoriesCache = directCats;
      } else if (forceRefresh || this._buddyCategoriesCache.length === 0) {
        await waitBuddyEvent;
      } else if (cancelWait) {
        cancelWait();
      }

      const categories =
        directCats.length > 0 ? directCats : this._buddyCategoriesCache;

      // Collect any V2 buddyUids across categories and batch-hydrate UIN + CoreInfo
      const v2Uids = [];
      for (const cat of categories) {
        if (Array.isArray(cat?.buddyUids)) {
          for (const uid of cat.buddyUids) {
            if (uid && typeof uid === "string") v2Uids.push(uid);
          }
        }
      }
      if (v2Uids.length > 0) {
        const missingUinUids = v2Uids.filter((uid) => !this.uinUidStore.getUinSync(uid));
        if (missingUinUids.length > 0) {
          try {
            const uinRes = await this.invokeNt(
              "nodeIKernelUixConvertService/getUin",
              { uids: missingUinUids },
              [missingUinUids]
            );
            const uinMap = uinRes?.uinInfo || uinRes;
            const pairs =
              uinMap instanceof Map
                ? Array.from(uinMap.entries())
                : uinMap && typeof uinMap === "object"
                ? Object.entries(uinMap)
                : [];
            for (const [uid, uin] of pairs) {
              if (uin && /^\d+$/.test(String(uin)) && Number(uin) > 0) {
                this.uinUidStore.remember(String(uin), String(uid));
              }
            }
          } catch (_) {}
        }

        try {
          const coreRes = await this.invokeNt(
            "nodeIKernelProfileService/getCoreInfo",
            { callFrom: "BuddyList", uids: v2Uids },
            ["BuddyList", v2Uids]
          );
          const coreMap = coreRes?.coreInfos || coreRes;
          const pairs =
            coreMap instanceof Map
              ? Array.from(coreMap.entries())
              : coreMap && typeof coreMap === "object"
              ? Object.entries(coreMap)
              : [];
          for (const [uidKey, info] of pairs) {
            if (!info || typeof info !== "object") continue;
            const core = info.coreInfo || info;
            const uin = core.uin || this.uinUidStore.getUinSync(core.uid || uidKey);
            if (uin) {
              this.uinUidStore.remember(uin, core.uid || uidKey, {
                nickname: core.nick || "",
                remark: core.remark || "",
              });
            }
          }
        } catch (_) {}
      }

      const list = [];
      const seenUins = new Set();
      for (const cat of categories) {
        if (Array.isArray(cat?.buddyList)) {
          for (const b of cat.buddyList) {
            if (!b || typeof b !== "object") continue;
            const core = b.coreInfo || b.baseInfo || b;
            const uin = Number(b.uin || core.uin || 0);
            if (uin > 0 && !seenUins.has(uin)) {
              seenUins.add(uin);
              list.push({
                user_id: uin,
                nickname: String(b.nick || core.nick || b.nickname || uin),
                remark: String(b.remark || core.remark || ""),
              });
            }
          }
        } else if (Array.isArray(cat?.buddyUids)) {
          for (const uid of cat.buddyUids) {
            let uinStr = this.uinUidStore.getUinSync(uid);
            if (!uinStr) {
              uinStr = await this.uinUidStore.resolveUin(uid, this.invokeNt.bind(this));
            }
            const uin = Number(uinStr || 0);
            if (uin > 0 && !seenUins.has(uin)) {
              seenUins.add(uin);
              const meta = this.uinUidStore.userMeta.get(String(uin)) || {};
              list.push({
                user_id: uin,
                nickname: String(meta.nickname || uin),
                remark: String(meta.remark || ""),
              });
            }
          }
        } else if (cat && typeof cat === "object") {
          const core = cat.coreInfo || cat.baseInfo || cat;
          const uin = Number(cat.uin || core.uin || 0);
          if (uin > 0 && !seenUins.has(uin)) {
            seenUins.add(uin);
            list.push({
              user_id: uin,
              nickname: String(cat.nick || core.nick || cat.nickname || uin),
              remark: String(cat.remark || core.remark || ""),
            });
          }
        }
      }
      return list;
    }

    case "get_stranger_info": {
      const userId = Number(p.user_id || 0);
      const uid = await this.uinUidStore.resolveUid(userId, this.invokeNt.bind(this));
      let detail = null;
      if (uid) {
        try {
          const res = await this.invokeNt(
            "nodeIKernelProfileService/getUserDetailInfo",
            { uid },
            [uid]
          );
          detail = res?.info || res?.detail?.[uid] || res;
        } catch (_) {}
      }
      const core = detail?.simpleInfo?.coreInfo || detail?.coreInfo || detail || {};
      const base = detail?.simpleInfo?.baseInfo || detail?.baseInfo || detail || {};
      const cached = this.uinUidStore.userMeta.get(String(userId)) || {};
      const sexNum = Number(base.sex ?? core.sex ?? 0);
      const sex = sexNum === 1 ? "male" : sexNum === 2 ? "female" : "unknown";
      const level = Number(base.qqLevel ?? detail?.qqLevel ?? 0);
      return {
        user_id: userId,
        nickname: String(core.nick || detail?.nick || cached.nickname || ""),
        sex,
        age: Number(base.age ?? detail?.age ?? cached.age ?? 0),
        qq_level: level,
        level,
      };
    }

    case "delete_friend": {
      const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
      await this.invokeNt("nodeIKernelBuddyService/delBuddy", {
        delInfo: {
          friendUid: uid,
          tempBlock: Boolean(p.block),
          tempBothDel: true,
        },
      });
      return {};
    }

    case "set_friend_add_request": {
      const flag = String(p.flag || "");
      const [friendUidPart, reqTimePart] = flag.split(":");
      const cached = this._buddyReqsCache.get(flag);
      const friendUid =
        cached?.friendUid ||
        (friendUidPart?.startsWith("u_")
          ? friendUidPart
          : await this.uinUidStore.resolveUid(friendUidPart, this.invokeNt.bind(this)));
      const reqTime = String(cached?.reqTime || reqTimePart || Math.floor(Date.now() / 1000));
      await this.invokeNt("nodeIKernelBuddyService/approvalFriendRequest", {
        approvalInfo: {
          friendUid,
          reqTime,
          accept: Boolean(p.approve ?? true),
        },
      });
      return {};
    }

    case "set_friend_remark": {
      const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
      await this.invokeNt("nodeIKernelBuddyService/setBuddyRemark", {
        remarkParams: { uid, remark: String(p.remark ?? "") },
      });
      return {};
    }

    case "get_doubt_friends_add_request": {
      const res = await this.invokeNt("nodeIKernelBuddyService/getDoubtBuddyReq", {});
      return Array.isArray(res?.doubtList) ? res.doubtList : [];
    }

    case "set_doubt_friends_add_request": {
      await this.invokeNt("nodeIKernelBuddyService/approvalDoubtBuddyReq", {
        reqId: String(p.flag || p.req_id || ""),
        accept: Boolean(p.approve ?? true),
      });
      return {};
    }

    case "get_friend_With_category":
    case "get_friends_with_category": {
      const res = await this.invokeNt(
        "nodeIKernelBuddyService/getBuddyList",
        { noCache: Boolean(p.no_cache) },
        [Boolean(p.no_cache)]
      );
      return Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
    }

    default:
      throw new Error(`Unsupported OneBot action: ${action}`);
  }
}

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
};
