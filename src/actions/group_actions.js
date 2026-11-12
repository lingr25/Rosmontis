"use strict";

const {
  computeBkn,
  cookieObjToString,
  httpRequestText,
  parseJsonpOrJson,
} = require("../core/web_http");

const { isWebCredentialApiEnabled } = require("../core/qzone_actions");

const HANDLED_ACTIONS = new Set([
  "get_group_list",
  "get_group_info",
  "get_group_info_ex",
  "get_group_detail_info",
  "get_group_share_link",
  "get_group_member_list",
  "get_group_member_info",
  "get_group_at_all_remain",
  "get_group_shut_list",
  "set_group_kick",
  "set_group_ban",
  "set_group_whole_ban",
  "set_group_admin",
  "set_group_card",
  "set_group_special_title",
  "set_group_name",
  "set_group_remark",
  "set_group_leave",
  "set_group_add_request",
  "get_group_system_msg",
  "get_group_ignored_notifies",
  "get_group_ignore_add_request",
  "get_essence_msg_list",
  "set_essence_msg",
  "delete_essence_msg",
  "_send_group_notice",
  "_get_group_notice",
  "get_group_honor_info",
]);

async function dispatch(action, p, context = {}) {
  switch (action) {
    // ---- 6. Groups & Group Admin ----
    case "get_group_list": {
      let cancelWait = null;
      const waitGroupEvent = new Promise((resolve) => {
        const onUpdate = (groupList) => {
          clearTimeout(timer);
          this._groupListWaiters.delete(onUpdate);
          resolve(groupList);
        };
        const timer = setTimeout(() => {
          this._groupListWaiters.delete(onUpdate);
          resolve(null);
        }, 1200);
        if (typeof timer.unref === "function") timer.unref();
        cancelWait = () => {
          clearTimeout(timer);
          this._groupListWaiters.delete(onUpdate);
          resolve(null);
        };
        this._groupListWaiters.add(onUpdate);
      });

      let res;
      try {
        res = await this.invokeNt(
          "nodeIKernelGroupService/getGroupList",
          { force: Boolean(p.no_cache) },
          [Boolean(p.no_cache)]
        );
      } catch (err) {
        if (cancelWait) cancelWait();
        throw err;
      }

      const hasDirectGroups =
        Array.isArray(res) || Array.isArray(res?.groupList) || Array.isArray(res?.groups);
      if (hasDirectGroups) {
        if (cancelWait) cancelWait();
      } else if (Boolean(p.no_cache) || this._groupListCache.size === 0) {
        await waitGroupEvent;
      } else if (cancelWait) {
        cancelWait();
      }

      const rawGroups = hasDirectGroups
        ? Array.isArray(res)
          ? res
          : res?.groupList || res?.groups || []
        : Array.from(this._groupListCache.values());

      return rawGroups.map((g) => {
        const gid = Number(g.groupCode || g.groupUin || g.group_id || 0);
        if (gid > 0) this._setBoundedMap(this._groupListCache, String(gid), g);
        const allShut =
          Number(g.shutUpAllTimestamp || g.info?.shutUpAllTimestamp || 0) > 0 ||
          Boolean(g.isAllShut || g.shutUpAll)
            ? -1
            : 0;
        return {
          group_id: gid,
          group_name: String(g.groupName || g.info?.groupName || ""),
          group_remark: String(g.remarkName || g.groupRemark || g.info?.remarkName || ""),
          member_count: Number(g.memberCount || g.info?.memberCount || 0),
          max_member_count: Number(g.maxMember || g.info?.memberMax || 0),
          group_create_time: Number(g.createTime || g.info?.createdTime || 0),
          group_level: Number(g.groupLevel || 0),
          group_memo: String(g.richFingerMemo || g.info?.announcement || ""),
          group_all_shut: allShut,
        };
      });
    }

    case "get_group_info":
    case "get_group_info_ex":
    case "get_group_detail_info": {
      const groupId = Number(p.group_id || 0);
      try {
        const res = await this.invokeNt(
          "nodeIKernelGroupService/getGroupAllInfo",
          { groupCode: String(groupId), source: 4 },
          [String(groupId), 4]
        );
        const d = res?.groupInfo || res?.detail || res || {};
        if (d.groupName || d.memberCount || d.maxMember) {
          const allShut =
            Number(d.shutUpAllTimestamp || 0) > 0 || Boolean(d.isAllShut || d.shutUpAll) ? -1 : 0;
          return {
            group_id: groupId,
            group_name: String(d.groupName || ""),
            group_remark: String(d.remarkName || d.groupRemark || ""),
            member_count: Number(d.memberCount || 0),
            max_member_count: Number(d.maxMember || d.maxMemberCount || 0),
            group_create_time: Number(d.createTime || 0),
            group_level: Number(d.groupLevel || 0),
            group_memo: String(d.richFingerMemo || d.groupMemo || ""),
            group_all_shut: allShut,
          };
        }
      } catch (_) {}
      const list = await this._dispatchAction("get_group_list", { no_cache: p.no_cache });
      return (
        list.find((g) => g.group_id === groupId) || {
          group_id: groupId,
          group_name: "",
          group_remark: "",
          member_count: 0,
          max_member_count: 0,
          group_create_time: 0,
          group_level: 0,
          group_memo: "",
          group_all_shut: 0,
        }
      );
    }

    case "get_group_share_link": {
      const groupCode = String(p.group_id || "").trim();
      if (!groupCode) throw new Error("group_id is required");
      try {
        const res = await this.invokeNt(
          "nodeIKernelGroupService/getGroupRecommendContactArkJson",
          { groupCode },
          [groupCode]
        );
        const rawArk = String(res?.arkJson || res?.arkMsg || (typeof res === "string" ? res : "") || "");
        if (rawArk) {
          try {
            const parsed = JSON.parse(rawArk);
            const jumpUrl =
              parsed?.meta?.contact?.jumpUrl ||
              parsed?.meta?.news?.jumpUrl ||
              parsed?.meta?.detail_1?.qqdocurl ||
              "";
            if (typeof jumpUrl === "string" && /^https?:\/\//i.test(jumpUrl)) {
              return { url: jumpUrl };
            }
          } catch (_) {
            const m = /https?:\/\/(?:qm\.qq\.com|qun\.qq\.com)\/[^\s"'\\]+/i.exec(rawArk);
            if (m) return { url: m[0] };
          }
        }
      } catch (_) {}
      return { url: `https://qun.qq.com/join.html?group_id=${encodeURIComponent(groupCode)}` };
    }

    case "get_group_at_all_remain": {
      const groupCode = String(p.group_id || "").trim();
      if (!groupCode) throw new Error("group_id is required");
      try {
        const res = await this.invokeNt(
          "nodeIKernelGroupService/getGroupRemainAtTimes",
          { groupCode },
          [groupCode]
        );
        const info = res?.atInfo || res || {};
        return {
          can_at_all: Boolean(info.canAtAll ?? true),
          remain_at_all_count_for_group: Number(info.RemainAtAllCountForGroup ?? info.remainAtAllCountForGroup ?? 10),
          remain_at_all_count_for_uin: Number(info.RemainAtAllCountForUin ?? info.remainAtAllCountForUin ?? 10),
        };
      } catch (_) {
        return {
          can_at_all: true,
          remain_at_all_count_for_group: 10,
          remain_at_all_count_for_uin: 10,
        };
      }
    }

    case "get_group_shut_list": {
      const groupId = Number(p.group_id || 0);
      const groupCode = String(groupId);
      const nowSec = Math.floor(Date.now() / 1000);
      let rawMembers = [];
      try {
        const allRes = await this.invokeNt(
          "nodeIKernelGroupService/getAllMemberList",
          { groupCode, force_fetch: true, forceFetch: true },
          [groupCode, true]
        );
        const infos = allRes?.result?.infos || allRes?.infos || allRes;
        rawMembers =
          infos instanceof Map
            ? [...infos.values()]
            : Array.isArray(infos)
            ? infos
            : infos && typeof infos === "object"
            ? Object.values(infos)
            : [];
      } catch (_) {}
      this.uinUidStore.rememberFromGroupMemberList(groupCode, rawMembers);
      return rawMembers
        .filter((m) => m && Number(m.shutUpTime || 0) > nowSec)
        .map((m) => {
          const uin =
            Number(m.uin || m.user_id || 0) ||
            Number((m.uid ? this.uinUidStore.getUinSync(m.uid) : 0) || 0);
          const roleNum = m.role ?? m.permission;
          const role =
            typeof roleNum === "string"
              ? roleNum
              : roleNum === 4 || roleNum === 1
              ? "owner"
              : roleNum === 3 || roleNum === 2
              ? "admin"
              : "member";
          return {
            group_id: groupId,
            user_id: uin,
            uid: String(m.uid || ""),
            nickname: String(m.nick ?? m.nickname ?? m.memberName ?? ""),
            card: String(m.cardName ?? m.card ?? m.memberCard?.memberCard ?? ""),
            role,
            shut_up_timestamp: Number(m.shutUpTime || 0),
          };
        });
    }

    case "set_group_remark": {
      const groupCode = String(p.group_id || "").trim();
      if (!groupCode) throw new Error("group_id is required");
      await this.invokeNt(
        "nodeIKernelGroupService/modifyGroupRemark",
        {
          groupCode,
          remarkName: String(p.remark ?? p.group_remark ?? ""),
        },
        [groupCode, String(p.remark ?? p.group_remark ?? "")]
      );
      return {};
    }

    case "get_group_member_list": {
      const groupId = Number(p.group_id || 0);
      const groupCode = String(groupId);
      const forceFetch = Boolean(p.no_cache);
      let infos = null;
      let sceneId = "";
      const hasMemberEntries = (val) => {
        if (!val) return false;
        if (val instanceof Map) return val.size > 0;
        if (Array.isArray(val)) return val.length > 0;
        if (typeof val === "object") return Object.keys(val).length > 0;
        return false;
      };
      try {
        const sceneRes = await this.invokeNt(
          "nodeIKernelGroupService/createMemberListScene",
          { groupCode, scene: "groupMemberList_MainWindow" },
          [groupCode, "groupMemberList_MainWindow"]
        );
        sceneId = typeof sceneRes === "string" ? sceneRes : sceneRes?.sceneId || "";
        if (sceneId) {
          const listRes = await this.invokeNt(
            "nodeIKernelGroupService/getNextMemberList",
            { sceneId, lastId: undefined, prevId: undefined, num: 3000 },
            [sceneId, undefined, 3000]
          );
          infos = listRes?.result?.infos || listRes?.infos || listRes;
        }
      } catch (_) {} finally {
        if (sceneId) {
          this.invokeNt(
            "nodeIKernelGroupService/destroyMemberListScene",
            { sceneId },
            [sceneId]
          ).catch(() => {});
        }
      }
      if (!hasMemberEntries(infos) || forceFetch) {
        try {
          const allRes = await this.invokeNt(
            "nodeIKernelGroupService/getAllMemberList",
            { groupCode, force_fetch: forceFetch, forceFetch },
            [groupCode, forceFetch]
          );
          const allInfos = allRes?.result?.infos || allRes?.infos || allRes;
          if (hasMemberEntries(allInfos)) {
            infos = allInfos;
          }
        } catch (_) {}
      }
      this.uinUidStore.rememberFromGroupMemberList(groupCode, infos);
      const rawMembers =
        infos instanceof Map
          ? [...infos.values()]
          : Array.isArray(infos)
          ? infos
          : infos && typeof infos === "object"
          ? Object.values(infos)
          : [];
      const missingUids = rawMembers
        .filter((m) => m && !(Number(m.uin || m.user_id || 0) > 0) && m.uid)
        .map((m) => String(m.uid));
      if (missingUids.length > 0) {
        try {
          const uinRes = await this.invokeNt(
            "nodeIKernelUixConvertService/getUin",
            { uids: missingUids },
            [missingUids]
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
      for (const m of rawMembers) {
        if (m && !(Number(m.uin || m.user_id || 0) > 0) && m.uid) {
          const resolvedUin = this.uinUidStore.getUinSync(m.uid);
          if (resolvedUin) {
            m.uin = String(resolvedUin);
          }
        }
      }
      this.uinUidStore.rememberFromGroupMemberList(groupCode, rawMembers);
      return rawMembers.map((m) => {
        const directUin = Number(m.uin || m.user_id || 0);
        const uin =
          directUin > 0
            ? directUin
            : Number((m.uid ? this.uinUidStore.getUinSync(m.uid) : 0) || 0);
        const roleNum = m.role ?? m.permission;
        const role =
          typeof roleNum === "string"
            ? roleNum
            : roleNum === 4 || roleNum === 1
            ? "owner"
            : roleNum === 3 || roleNum === 2
            ? "admin"
            : "member";
        return {
          group_id: groupId,
          user_id: uin,
          nickname: String(m.nick ?? m.nickname ?? m.memberName ?? ""),
          card: String(m.cardName ?? m.card ?? m.memberCard?.memberCard ?? ""),
          sex: "unknown",
          age: 0,
          area: "",
          join_time: Number(m.joinTime ?? m.joinTimestamp ?? 0),
          last_sent_time: Number(m.lastSpeakTime ?? m.lastMsgTimestamp ?? 0),
          level: String(m.memberLevel ?? m.level?.level ?? 0),
          role,
          unfriendly: false,
          title: String(m.memberSpecialTitle ?? m.specialTitle ?? m.title ?? ""),
          title_expire_time: 0,
          card_changeable: true,
        };
      });
    }

    case "get_group_member_info": {
      const groupId = Number(p.group_id || 0);
      const userId = Number(p.user_id || 0);
      const gKey = `${groupId}:${userId}`;
      if (!p.no_cache && this.uinUidStore.groupMemberMeta.has(gKey)) {
        const cached = this.uinUidStore.groupMemberMeta.get(gKey);
        // Only short-circuit cache when `cached.role` has been authoritatively populated
        if (cached && cached.role) {
          return {
            group_id: groupId,
            user_id: userId,
            nickname: cached.nickname || "",
            card: cached.card || "",
            sex: "unknown",
            age: 0,
            area: "",
            join_time: 0,
            last_sent_time: 0,
            level: "0",
            role: cached.role,
            unfriendly: false,
            title: cached.title || "",
            title_expire_time: 0,
            card_changeable: true,
          };
        }
      }

      // Try single-member query via nodeIKernelGroupService/getMemberInfo first
      try {
        const uid = await this.uinUidStore.resolveUid(userId, this.invokeNt.bind(this));
        if (uid) {
          const singleRes = await this.invokeNt(
            "nodeIKernelGroupService/getMemberInfo",
            {
              groupCode: String(groupId),
              uids: [uid],
              force_fetch: Boolean(p.no_cache),
              forceFetch: Boolean(p.no_cache),
            },
            [String(groupId), [uid], Boolean(p.no_cache)]
          );
          const infos = singleRes?.result?.infos || singleRes?.infos;
          if (infos) {
            this.uinUidStore.rememberFromGroupMemberList(String(groupId), infos);
            const refreshed = this.uinUidStore.groupMemberMeta.get(gKey);
            if (refreshed && refreshed.role) {
              return {
                group_id: groupId,
                user_id: userId,
                nickname: refreshed.nickname || "",
                card: refreshed.card || "",
                sex: "unknown",
                age: 0,
                area: "",
                join_time: 0,
                last_sent_time: 0,
                level: "0",
                role: refreshed.role,
                unfriendly: false,
                title: refreshed.title || "",
                title_expire_time: 0,
                card_changeable: true,
              };
            }
          }
        }
      } catch (_) {}

      const members = await this._dispatchAction("get_group_member_list", {
        group_id: groupId,
        no_cache: p.no_cache,
      });
      return (
        members.find((m) => Number(m.user_id) === userId) || {
          group_id: groupId,
          user_id: userId,
          nickname: "",
          card: "",
          sex: "unknown",
          age: 0,
          area: "",
          join_time: 0,
          last_sent_time: 0,
          level: "0",
          role: "member",
          unfriendly: false,
          title: "",
          title_expire_time: 0,
          card_changeable: true,
        }
      );
    }

    case "set_group_kick": {
      const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
      await this.invokeNt(
        "nodeIKernelGroupService/kickMember",
        {
          groupCode: String(p.group_id),
          kickUids: [uid],
          refuseForever: Boolean(p.reject_add_request),
          kickReason: "",
        },
        [String(p.group_id), [uid], Boolean(p.reject_add_request), ""]
      );
      return {};
    }

    case "set_group_ban": {
      const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
      const memList = [{ uid, timeStamp: Number(p.duration ?? 1800) }];
      await this.invokeNt(
        "nodeIKernelGroupService/banMember",
        { groupCode: String(p.group_id), memList },
        [String(p.group_id), memList]
      );
      return {};
    }

    case "set_group_whole_ban": {
      const enable = Boolean(p.enable ?? true);
      const groupInfo = {
        groupCode: String(p.group_id),
        shutUpAllMember: enable ? 1 : 0,
      };
      await this.invokeNt(
        "nodeIKernelGroupService/modifyGroupExtInfo",
        { groupInfo },
        [groupInfo]
      );
      return {};
    }

    case "set_group_admin": {
      const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
      const enable = Boolean(p.enable ?? true);
      const role = enable ? 3 : 2;
      await this.invokeNt(
        "nodeIKernelGroupService/modifyMemberRole",
        { groupCode: String(p.group_id), uid, role },
        [String(p.group_id), uid, role]
      );
      const gKey = `${Number(p.group_id || 0)}:${Number(p.user_id || 0)}`;
      if (this.uinUidStore.groupMemberMeta.has(gKey)) {
        const prev = this.uinUidStore.groupMemberMeta.get(gKey);
        this.uinUidStore.groupMemberMeta.set(gKey, {
          ...prev,
          role: enable ? "admin" : "member",
        });
      }
      return {};
    }

    case "set_group_card": {
      const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
      await this.invokeNt(
        "nodeIKernelGroupService/modifyMemberCardName",
        {
          groupCode: String(p.group_id),
          uid,
          cardName: String(p.card ?? ""),
        },
        [String(p.group_id), uid, String(p.card ?? "")]
      );
      return {};
    }

    case "set_group_special_title": {
      const uid = await this.uinUidStore.resolveUid(p.user_id, this.invokeNt.bind(this));
      const specialTitle = String(p.special_title ?? "");
      const expireTime = Number(p.duration ?? -1);
      try {
        await this.invokeNt(
          "nodeIKernelGroupService/setIdentityTitleInfo",
          {
            groupCode: String(p.group_id),
            uid,
            specialTitle,
            expireTime,
          },
          [String(p.group_id), uid, specialTitle, expireTime]
        );
      } catch (_) {
        await this.invokeNt("nodeIKernelGroupService/modifyMemberSpecialTitle", {
          groupCode: String(p.group_id),
          uid,
          specialTitle,
        });
      }
      return {};
    }

    case "set_group_name": {
      await this.invokeNt(
        "nodeIKernelGroupService/modifyGroupName",
        {
          groupCode: String(p.group_id),
          groupName: String(p.group_name ?? ""),
          isConf: false,
        },
        [String(p.group_id), String(p.group_name ?? ""), false]
      );
      return {};
    }

    case "set_group_leave": {
      await this.invokeNt(
        "nodeIKernelGroupService/quitGroup",
        { groupCode: String(p.group_id) },
        [String(p.group_id)]
      );
      return {};
    }

    case "set_group_add_request": {
      const flag = String(p.flag || "");
      const cached = this._groupNotifiesCache.get(flag);
      const parts = flag.split(":");
      const seq = cached?.seq || parts[0] || flag;
      const notifyType = Number(cached?.type || parts[1] || (p.sub_type === "invite" ? 2 : 1));
      const groupCode = String(cached?.group?.groupCode || parts[2] || p.group_id || "");
      const approve = Boolean(p.approve ?? true);
      await this.invokeNt("nodeIKernelGroupService/operateSysNotify", {
        doubt: false,
        operateMsg: {
          operateType: approve ? 1 : 2,
          targetMsg: {
            seq: String(seq),
            type: notifyType,
            groupCode,
            postscript: String(p.reason || ""),
          },
        },
      });
      return {};
    }

    case "get_group_system_msg":
    case "get_group_ignored_notifies":
    case "get_group_ignore_add_request": {
      const doubt = action !== "get_group_system_msg";
      const res = await this.invokeNt(
        "nodeIKernelGroupService/getSingleScreenNotifies",
        { doubt, startSeq: "", number: 50 },
        [doubt, "", 50]
      );
      const notifies = Array.isArray(res?.notifies) ? res.notifies : [];
      const invited_requests = [];
      const join_requests = [];
      for (const item of notifies) {
        const seq = String(item.seq || "");
        const nType = Number(item.type || 1);
        const gid = Number(item.group?.groupCode || 0);
        const flag = `${seq}:${nType}:${gid}`;
        this._setBoundedMap(this._groupNotifiesCache, flag, item);
        const entry = {
          request_id: Number(seq || 0),
          invitor_uin: Number(item.user2?.uin || this.uinUidStore.getUinSync(item.user2?.uid) || 0),
          invitor_nick: String(item.user2?.nickName || ""),
          group_id: gid,
          group_name: String(item.group?.groupName || ""),
          requester_uin: Number(item.user1?.uin || this.uinUidStore.getUinSync(item.user1?.uid) || 0),
          requester_nick: String(item.user1?.nickName || ""),
          message: String(item.postscript || ""),
          checked: Number(item.status) !== 1,
          actor: Number(item.actionUser?.uin || 0),
          flag,
        };
        if (nType === 2) invited_requests.push(entry);
        else join_requests.push(entry);
      }
      if (action === "get_group_system_msg") {
        return { invited_requests, join_requests };
      }
      return [...invited_requests, ...join_requests];
    }

    case "get_essence_msg_list": {
      const groupId = String(p.group_id || "");
      if (isWebCredentialApiEnabled(this.config) && this.config.allowExternalHttp !== false) {
        try {
          const cookies = await this._getCookiesObject("qun.qq.com");
          const bkn = computeBkn(cookies.p_skey || cookies.skey);
          const url = `https://qun.qq.com/cgi-bin/group_digest/digest_list?bkn=${bkn}&page_start=0&page_limit=50&group_code=${groupId}`;
          const text = await httpRequestText(url, "GET", "", {
            Cookie: cookieObjToString(cookies),
          });
          const parsed = parseJsonpOrJson(text);
          if (Array.isArray(parsed?.data?.msg_list)) {
            return parsed.data.msg_list;
          }
        } catch (_) {}
      }
      for (const essenceCmd of [
        "nodeIKernelGroupService/getGroupLatestEssenceList",
        "nodeIKernelGroupService/fetchGroupEssenceList",
        "nodeIKernelGroupService/getGroupEssenceList",
      ]) {
        try {
          const res = await this.invokeNt(essenceCmd, { groupCode: groupId }, [groupId]);
          if (res && (Array.isArray(res.msgList) || Array.isArray(res.list))) {
            return res.msgList || res.list;
          }
          if (res !== undefined) return res?.msgList || [];
        } catch (_) {}
      }
      return [];
    }

    case "set_essence_msg":
    case "delete_essence_msg": {
      const entry =
        this.messageIdStore.getByShortId(p.message_id) ||
        this.messageIdStore.getByMsgId(p.message_id);
      if (!entry) throw new Error("message not found");
      const cmd =
        action === "set_essence_msg"
          ? "nodeIKernelGroupService/addGroupEssence"
          : "nodeIKernelGroupService/removeGroupEssence";
      await this.invokeNt(cmd, {
        param: {
          groupCode: String(entry.peer?.peerUid || entry.groupId || p.group_id || ""),
          msgRandom: Number(entry.rawMsg?.msgRandom || 0),
          msgSeq: Number(entry.msgSeq || 0),
        },
      });
      return {};
    }

    case "_send_group_notice": {
      const groupCode = String(p.group_id || "");
      const content = String(p.content || "");
      if (isWebCredentialApiEnabled(this.config) && this.config.allowExternalHttp !== false) {
        try {
          const cookies = await this._getCookiesObject("qun.qq.com");
          if (cookies.skey || cookies.p_skey) {
            const bodyBkn = computeBkn(cookies.skey || cookies.p_skey);
            const urlBkn = computeBkn(cookies.p_skey || cookies.skey);
            const body = new URLSearchParams({
              qid: groupCode,
              bkn: String(bodyBkn),
              text: content,
              pinned: String(p.pinned ?? 0),
              type: String(p.type ?? 1),
              settings: JSON.stringify({
                is_show_edit_card: 1,
                tip_window_type: 1,
                confirm_required: Number(p.confirm_required ?? 1),
              }),
            }).toString();
            const url = `https://web.qun.qq.com/cgi-bin/announce/add_qun_notice?bkn=${urlBkn}`;
            const text = await httpRequestText(url, "POST", body, {
              Cookie: cookieObjToString(cookies),
              "Content-Type": "application/x-www-form-urlencoded",
            });
            const json = parseJsonpOrJson(text);
            if (json && json.ec === 0) return {};
          }
        } catch (_) {}
      }
      await this.invokeNt("nodeIKernelGroupService/publishGroupBulletin", {
        groupCode,
        pskey: "",
        data: {
          text: content,
          pinned: Number(p.pinned ?? 0),
          isShowEditCard: 1,
          tipWindowType: 1,
          confirmRequired: Number(p.confirm_required ?? 1),
        },
      });
      return {};
    }

    case "_get_group_notice": {
      const groupCode = String(p.group_id || "");
      try {
        const res = await this.invokeNt("nodeIKernelGroupService/getGroupBulletin", {
          groupCode,
        });
        if (Array.isArray(res?.feeds)) {
          return res.feeds;
        }
      } catch (_) {}
      if (isWebCredentialApiEnabled(this.config) && this.config.allowExternalHttp !== false) {
        try {
          const cookies = await this._getCookiesObject("qun.qq.com");
          if (cookies.skey || cookies.p_skey) {
            const bodyBkn = computeBkn(cookies.skey || cookies.p_skey);
            const urlBkn = computeBkn(cookies.p_skey || cookies.skey);
            const body = new URLSearchParams({
              qid: groupCode,
              bkn: String(bodyBkn),
              ft: "23",
              s: "-1",
              n: "20",
              i: "1",
              ni: "1",
            }).toString();
            const url = `https://web.qun.qq.com/cgi-bin/announce/list_announce?bkn=${urlBkn}`;
            const text = await httpRequestText(url, "POST", body, {
              Cookie: cookieObjToString(cookies),
              "Content-Type": "application/x-www-form-urlencoded",
              Referer: "https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148",
            });
            const ret = parseJsonpOrJson(text);
            if (ret && Array.isArray(ret.feeds)) {
              return ret.feeds.map((f) => ({
                notice_id: String(f.fid || ""),
                sender_id: Number(f.u || 0),
                publish_time: Number(f.pubt || 0),
                message: {
                  text: String(f.msg?.text || ""),
                  images: (f.msg?.pics || []).map((pic) => ({
                    id: pic.id,
                    width: pic.w,
                    height: pic.h,
                  })),
                },
              }));
            }
          }
        } catch (_) {}
      }
      return [];
    }

    case "get_group_honor_info": {
      const groupId = Number(p.group_id || 0);
      return {
        group_id: groupId,
        current_talkative: null,
        talkative_list: [],
        performer_list: [],
        legend_list: [],
        strong_newbie_list: [],
        emotion_list: [],
      };
    }

    default:
      throw new Error(`Unsupported action: ${action}`);
  }
}

module.exports = {
  HANDLED_ACTIONS,
  dispatch,
};
