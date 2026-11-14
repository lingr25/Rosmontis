"use strict";

const { createActionRouter, waitForEventOnce } = require("../core/primitives");
const {
  isPositiveUin,
  pickPositiveUin,
  normalizeBuddyProfile,
} = require("../core/nt_normalizer");

const BUDDY_LIST_WAIT_TIMEOUT_MS = 1200;

function extractBuddyCategories(res) {
  if (Array.isArray(res)) return res;
  if (!res || typeof res !== "object") return [];
  if (Array.isArray(res.buddyCategory) && res.buddyCategory.length > 0) {
    return res.buddyCategory;
  }
  if (Array.isArray(res.data) && res.data.length > 0) {
    return res.data;
  }
  if (Array.isArray(res.buddyCategory)) return res.buddyCategory;
  if (Array.isArray(res.data)) return res.data;
  return [];
}

function entriesFromMapOrObject(mapOrObj) {
  if (mapOrObj instanceof Map) return Array.from(mapOrObj.entries());
  if (mapOrObj && typeof mapOrObj === "object" && !Array.isArray(mapOrObj)) {
    return Object.entries(mapOrObj);
  }
  return [];
}

const ACTION_HANDLERS = {
  async get_friend_list(p) {
    const waitBuddyEvent = waitForEventOnce(
      this._buddyListWaiters,
      BUDDY_LIST_WAIT_TIMEOUT_MS
    );

    const forceRefresh = Boolean(p.no_cache);
    let res = null;
    try {
      res = await this.invokeNt(
        "nodeIKernelBuddyService/getBuddyList",
        { force_update: forceRefresh, noCache: forceRefresh },
        [forceRefresh]
      );
    } catch (_) {}

    let directCats = extractBuddyCategories(res);

    if (directCats.length === 0) {
      try {
        const v2Cache = await this.invokeNt(
          "nodeIKernelBuddyService/getBuddyListFromCache",
          { buddyListReqType: 0 },
          [0]
        );
        const v2Cats = extractBuddyCategories(v2Cache);
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
        const v2Cats = extractBuddyCategories(v2Res);
        if (v2Cats.length > 0) {
          res = v2Res;
          directCats = v2Cats;
        }
      } catch (_) {}
    }

    if (directCats.length > 0) {
      this.uinUidStore.rememberFromBuddyList(res);
      this._buddyCategoriesCache = directCats;
    } else if (forceRefresh || this._buddyCategoriesCache.length === 0) {
      await waitBuddyEvent;
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
      const missingUinUids = v2Uids.filter(
        (uid) => !isPositiveUin(this.uinUidStore.getUinSync(uid))
      );
      if (missingUinUids.length > 0) {
        try {
          const uinRes = await this.invokeNt(
            "nodeIKernelUixConvertService/getUin",
            { uids: missingUinUids },
            [missingUinUids]
          );
          const pairs = entriesFromMapOrObject(uinRes?.uinInfo || uinRes);
          for (const [uid, rawUin] of pairs) {
            const uin = pickPositiveUin(rawUin);
            if (uin > 0) {
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
        const pairs = entriesFromMapOrObject(coreRes?.coreInfos || coreRes);
        for (const [uidKey, info] of pairs) {
          if (!info || typeof info !== "object") continue;
          const profile = normalizeBuddyProfile(info, String(uidKey || ""));
          const uin =
            profile.uin ||
            pickPositiveUin(this.uinUidStore.getUinSync(profile.uid || uidKey));
          if (uin > 0) {
            this.uinUidStore.remember(String(uin), profile.uid || uidKey, {
              nickname: profile.nickname,
              remark: profile.remark,
            });
          }
        }
      } catch (_) {}
    }

    const list = [];
    const seenUins = new Set();
    const pushBuddyItem = (rawBuddy) => {
      if (!rawBuddy || typeof rawBuddy !== "object") return;
      const profile = normalizeBuddyProfile(rawBuddy);
      if (profile.uin > 0 && !seenUins.has(profile.uin)) {
        seenUins.add(profile.uin);
        list.push({
          user_id: profile.uin,
          nickname: String(profile.nickname || profile.uin),
          remark: String(profile.remark || ""),
        });
      }
    };

    for (const cat of categories) {
      if (Array.isArray(cat?.buddyList)) {
        for (const b of cat.buddyList) {
          pushBuddyItem(b);
        }
      } else if (Array.isArray(cat?.buddyUids)) {
        for (const uid of cat.buddyUids) {
          let uinStr = this.uinUidStore.getUinSync(uid);
          if (!isPositiveUin(uinStr)) {
            uinStr = await this.uinUidStore.resolveUin(uid, this.invokeNt.bind(this));
          }
          const uin = pickPositiveUin(uinStr);
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
        pushBuddyItem(cat);
      }
    }
    return list;
  },

  async get_stranger_info(p) {
    const userId = Number(p.user_id || 0);
    const uid = await this.uinUidStore.resolveUid(userId, this.invokeNt.bind(this));
    let detail = null;
    if (uid) {
      const extractDetail = (res) => {
        if (!res || typeof res !== "object") return null;
        if (res.detail instanceof Map) return res.detail.get(uid) || null;
        if (res.detail && typeof res.detail === "object") {
          if (res.detail[uid]) return res.detail[uid];
          if (res.detail.uid || res.detail.simpleInfo || res.detail.coreInfo || res.detail.nick) {
            return res.detail;
          }
        }
        if (res.info && typeof res.info === "object") return res.info;
        if (res.simpleInfo || res.coreInfo || res.baseInfo || res.nick || res.nickname) {
          return res;
        }
        return null;
      };

      try {
        const res = await this.invokeNt(
          "nodeIKernelProfileService/fetchUserDetailInfo",
          {
            callFrom: "BuddyProfileStore",
            uid: [uid],
            uids: [uid],
            source: 0,
            bizList: [0],
          },
          ["BuddyProfileStore", [uid], 0, [0]]
        );
        detail = extractDetail(res);
      } catch (_) {
        let cleanupWaiter = null;
        const waitDetail =
          this._profileDetailWaiters instanceof Map
            ? new Promise((resolve) => {
                let timer = setTimeout(() => {
                  timer = null;
                  cleanupWaiter?.();
                  resolve(null);
                }, 300);
                timer.unref?.();
                const onDetail = (info) => {
                  if (timer) {
                    clearTimeout(timer);
                    timer = null;
                  }
                  cleanupWaiter?.();
                  resolve(info);
                };
                cleanupWaiter = () => {
                  const set = this._profileDetailWaiters.get(uid);
                  if (set) {
                    set.delete(onDetail);
                    if (set.size === 0) this._profileDetailWaiters.delete(uid);
                  }
                };
                if (!this._profileDetailWaiters.has(uid)) {
                  this._profileDetailWaiters.set(uid, new Set());
                }
                this._profileDetailWaiters.get(uid).add(onDetail);
              })
            : Promise.resolve(null);
        try {
          const fallbackRes = await this.invokeNt(
            "nodeIKernelProfileService/getUserDetailInfo",
            { uid },
            [uid]
          );
          detail = extractDetail(fallbackRes) || (await waitDetail);
        } catch (_) {
          cleanupWaiter?.();
        }
      }
    }
    const profile = normalizeBuddyProfile(detail, uid);
    const base = detail?.simpleInfo?.baseInfo || detail?.baseInfo || detail || {};
    const cached = this.uinUidStore.userMeta.get(String(userId)) || {};
    const age = profile.age > 0 ? profile.age : Number(base.age ?? detail?.age ?? cached.age ?? 0);
    const level = Number(base.qqLevel ?? detail?.qqLevel ?? 0);
    return {
      user_id: userId,
      nickname: String(profile.nickname || cached.nickname || ""),
      sex: profile.sex,
      age,
      qq_level: level,
      level,
    };
  },

  async delete_friend(p) {
    const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
    const delInfo = {
      friendUid: uid,
      tempBlock: Boolean(p.block),
      tempBothDel: true,
    };
    await this.invokeNt(
      "nodeIKernelBuddyService/delBuddy",
      { delInfo },
      [delInfo]
    );
    return {};
  },

  async set_friend_add_request(p) {
    const flag = String(p.flag || "");
    const [friendUidPart, reqTimePart] = flag.split(":");
    const cached = this._buddyReqsCache.get(flag);
    const friendUid =
      cached?.friendUid ||
      (friendUidPart?.startsWith("u_")
        ? friendUidPart
        : await this.uinUidStore.resolveUid(friendUidPart, this.invokeNt.bind(this)));
    const reqTime = String(cached?.reqTime || reqTimePart || Math.floor(Date.now() / 1000));
    const approvalInfo = {
      friendUid,
      reqTime,
      accept: Boolean(p.approve ?? true),
    };
    await this.invokeNt(
      "nodeIKernelBuddyService/approvalFriendRequest",
      { approvalInfo },
      [approvalInfo]
    );
    return {};
  },

  async set_friend_remark(p) {
    const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
    const remarkParams = { uid, remark: String(p.remark ?? "") };
    await this.invokeNt(
      "nodeIKernelBuddyService/setBuddyRemark",
      { remarkParams },
      [remarkParams]
    );
    return {};
  },

  async get_doubt_friends_add_request(p = {}) {
    const reqId = String(Date.now());
    const reqNum = Math.max(1, Number(p?.count || 50));
    const cookie = String(p?.cookie || "");
    const waitDoubt = this._doubtBuddyWaiters
      ? waitForEventOnce(this._doubtBuddyWaiters, 200)
      : Promise.resolve(null);
    const res = await this.invokeNt(
      "nodeIKernelBuddyService/getDoubtBuddyReq",
      { reqId, reqNum, cookie },
      [reqId, reqNum, cookie]
    );
    if (Array.isArray(res?.doubtList)) {
      return res.doubtList;
    }
    const asyncEvt = await waitDoubt;
    if (Array.isArray(asyncEvt?.doubtList)) {
      return asyncEvt.doubtList;
    }
    return Array.isArray(asyncEvt) ? asyncEvt : [];
  },

  async set_doubt_friends_add_request(p = {}) {
    const rawTarget = String(p.uid || p.flag || p.req_id || p.user_id || "").trim();
    const uid =
      rawTarget.startsWith("u_") || !/^\d+$/.test(rawTarget)
        ? rawTarget
        : await this.uinUidStore.resolveUid(rawTarget, this.invokeNt.bind(this));
    if (!uid) throw new Error("uid or flag is required");
    const approve = Boolean(p.approve ?? true);
    if (approve) {
      const groupId = String(p.group_id ?? "");
      const remark = String(p.remark ?? "");
      await this.invokeNt(
        "nodeIKernelBuddyService/approvalDoubtBuddyReq",
        { uid, groupId, remark },
        [uid, groupId, remark]
      );
    } else {
      await this.invokeNt(
        "nodeIKernelBuddyService/delDoubtBuddyReq",
        { uid },
        [uid]
      );
    }
    return {};
  },

  async get_friends_with_category(p) {
    const noCache = Boolean(p.no_cache);
    const res = await this.invokeNt(
      "nodeIKernelBuddyService/getBuddyList",
      { noCache },
      [noCache]
    );
    return Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
  },
};

const ACTION_ALIASES = {
  get_friend_With_category: "get_friends_with_category",
};

const { HANDLED_ACTIONS, dispatch } = createActionRouter(ACTION_HANDLERS, ACTION_ALIASES);

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
};
