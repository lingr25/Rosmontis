"use strict";

/**
 * Outbound & inbound voice (SILK v3 / AMR / WAV transcode) & NTQQ Ptt cache staging
 * Migrated from test/test_bridge.js sections: 22.
 */

const test = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { mainMod } = require("./_helpers");
// === Section 22: Testing Outbound Voice (SILK v3 / AMR / WAV Transcode) & Ptt Cache Staging ===

test("Outbound record stages to NTQQ Ptt cache, normalizes raw SILK v3, computes duration, correlates echo & supports ffmpeg transcoding", async () => {
  const os = require("os");
  const crypto = require("crypto");
  const tmpVoiceDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis_suite22_voice_"));
  const pttCacheDir = path.join(tmpVoiceDir, "nt_qq_mock", "nt_data", "Ptt");
  const tmpWorkDir = path.join(tmpVoiceDir, "tmp_media");
  fs.mkdirSync(pttCacheDir, { recursive: true });
  fs.mkdirSync(tmpWorkDir, { recursive: true });

  const prevTempEnv = process.env.ROSMONTIS_TEMP_DIR;
  process.env.ROSMONTIS_TEMP_DIR = tmpWorkDir;

  const ntCalls = [];
  let echoSeq = 0;
  let voiceBridge = null;

  try {
    voiceBridge = new mainMod.NtqqOneBotBridge({
      selfUin: "100010001",
      selfUid: "u_self_22",
      online: true,
      config: {
        httpServers: [],
        wsServers: [],
        wsClients: [],
        heartbeatIntervalMs: 0,
        humanSimulation: false,
        cleanupTempImmediately: true,
        sendEchoTimeoutMs: 200,
        richMediaEchoTimeoutMs: 250,
        quietLogs: true,
      },
      rendererExecute: async (cmd, args) => {
        const payload = Array.isArray(args) ? args[0] : args;
        ntCalls.push({ cmd, payload });

        if (cmd === "nodeIKernelMsgService/getRichMediaFilePathForGuild") {
          const pInfo = payload.path_info || payload;
          const target = path.join(
            pttCacheDir,
            String(pInfo.fileName || `${pInfo.md5HexStr}.amr`)
          );
          return { path: target };
        }

        if (cmd === "nodeIKernelMsgService/sendMsg") {
          const pttEl = payload.msgElements.find((e) => e.elementType === 4)?.pttElement;
          const seq = ++echoSeq;
          setTimeout(() => {
            voiceBridge.inboundPipeline._handleKernelEvent("nodeIKernelMsgListener", "onAddSendMsg", [
              {
                msgRecord: {
                  msgId: `790000000000000${seq}`,
                  msgSeq: String(500 + seq),
                  chatType: payload.peer.chatType,
                  peerUid: payload.peer.peerUid,
                  senderUid: "u_self_22",
                  senderUin: "100010001",
                  elements: pttEl
                    ? [
                        {
                          elementType: 4,
                          elementId: "el_sent_ptt",
                          pttElement: {
                            md5HexStr: pttEl.md5HexStr,
                            fileName: pttEl.fileName,
                            filePath: pttEl.filePath,
                            fileSize: pttEl.fileSize,
                            duration: pttEl.duration,
                          },
                        },
                      ]
                    : payload.msgElements,
                },
              },
            ]);
          }, 10);
          return { result: 0 };
        }

        if (cmd === "nodeIKernelMsgService/downloadRichMedia") {
          throw new Error("offline: testing Ptt cache lookup fallback");
        }

        return { result: 0 };
      },
    });
    voiceBridge.uinUidStore.record("100020002", "u_friend_22");

    // 22a. Outbound Tencent SILK v3 (300 frames = 6.0s) with magic=1 -> staged into Ptt cache & recallable echo
    const silkParts = [Buffer.from([0x02]), Buffer.from("#!SILK_V3", "ascii")];
    for (let i = 0; i < 300; i++) {
      const hdr = Buffer.alloc(2);
      hdr.writeInt16LE(14, 0);
      silkParts.push(hdr, Buffer.alloc(14, (i * 11) & 0xff));
    }
    const silkBuf = Buffer.concat(silkParts);
    const expectedSilkMd5 = crypto.createHash("md5").update(silkBuf).digest("hex");

    const resSilk = await voiceBridge.handleOneBotAction("send_private_msg", {
      user_id: 100020002,
      message: [
        {
          type: "record",
          data: {
            file: `base64://${silkBuf.toString("base64")}`,
            magic: 1,
          },
        },
      ],
    });
    assert.strictEqual(resSilk.status, "ok");
    assert.ok(resSilk.data.message_id > 0);
    assert.match(String(resSilk.data.real_id), /^790000000000000/);

    const pathCall = ntCalls.find(
      (c) =>
        c.cmd === "nodeIKernelMsgService/getRichMediaFilePathForGuild" &&
        c.payload?.path_info?.elementType === 4
    );
    assert.ok(pathCall, "Expected getRichMediaFilePathForGuild with elementType=4");
    assert.strictEqual(pathCall.payload.path_info.md5HexStr, expectedSilkMd5);

    const sendCall1 = ntCalls.find((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
    assert.ok(sendCall1);
    const sentPtt1 = sendCall1.payload.msgElements[0].pttElement;
    assert.strictEqual(sentPtt1.md5HexStr, expectedSilkMd5);
    assert.strictEqual(sentPtt1.duration, 6);
    assert.strictEqual(sentPtt1.voiceChangeType, 1);
    assert.strictEqual(sentPtt1.filePath, path.join(pttCacheDir, `${expectedSilkMd5}.amr`));
    assert.strictEqual(fs.existsSync(sentPtt1.filePath), true);

    // 22b. Raw SILK v3 (#!SILK_V3 without 0x02, 100 frames = 2.0s) -> auto-prefixed, staged, temp cleaned
    ntCalls.length = 0;
    const rawSilkParts = [Buffer.from("#!SILK_V3", "ascii")];
    for (let i = 0; i < 100; i++) {
      const hdr = Buffer.alloc(2);
      hdr.writeInt16LE(10, 0);
      rawSilkParts.push(hdr, Buffer.alloc(10, (i * 19) & 0xff));
    }
    const rawSilkBuf = Buffer.concat(rawSilkParts);
    const expectedPrefixedBuf = Buffer.concat([Buffer.from([0x02]), rawSilkBuf]);
    const expectedPrefixedMd5 = crypto
      .createHash("md5")
      .update(expectedPrefixedBuf)
      .digest("hex");

    const resRawSilk = await voiceBridge.handleOneBotAction("send_group_msg", {
      group_id: 888999000,
      message: `[CQ:record,file=base64://${rawSilkBuf.toString("base64")}]`,
    });
    assert.strictEqual(resRawSilk.status, "ok");
    const sendCall2 = ntCalls.find((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
    const sentPtt2 = sendCall2.payload.msgElements[0].pttElement;
    assert.strictEqual(sentPtt2.md5HexStr, expectedPrefixedMd5);
    assert.strictEqual(sentPtt2.fileSize, String(expectedPrefixedBuf.length));
    assert.strictEqual(sentPtt2.duration, 2);
    assert.strictEqual(fs.readFileSync(sentPtt2.filePath).equals(expectedPrefixedBuf), true);
    // Intermediate temp files in tmpWorkDir are cleaned up while Ptt cache copy stays intact
    assert.strictEqual(fs.readdirSync(tmpWorkDir).length, 0);

    // 22c. Inbound pathless pttElement resolves existing Ptt cache file via getRichMediaFilePathForGuild
    const cachedAmrFrames = [Buffer.from("#!AMR\n", "ascii")];
    for (let i = 0; i < 50; i++) {
      const frame = Buffer.alloc(32, 0x2a);
      frame[0] = (7 << 3) | 0x04;
      cachedAmrFrames.push(frame);
    }
    const cachedAmrBuf = Buffer.concat(cachedAmrFrames);
    const cachedAmrMd5 = crypto.createHash("md5").update(cachedAmrBuf).digest("hex");
    const cachedAmrPath = path.join(pttCacheDir, `${cachedAmrMd5}.amr`);
    fs.writeFileSync(cachedAmrPath, cachedAmrBuf);

    const inboundEvents = [];
    voiceBridge.broadcastOneBotEvent = (ev) => {
      if (ev.post_type === "message") inboundEvents.push(ev);
    };
    await voiceBridge.inboundPipeline._processIncomingNtMessage({
      msgId: "790000000000000999",
      msgSeq: "601",
      msgTime: String(Math.floor(Date.now() / 1000)),
      chatType: 1,
      peerUid: "u_friend_22",
      senderUid: "u_friend_22",
      senderUin: "100020002",
      elements: [
        {
          elementType: 4,
          elementId: "el_in_ptt_cached",
          pttElement: {
            md5HexStr: cachedAmrMd5,
            fileName: `${cachedAmrMd5}.amr`,
            filePath: "",
            fileSize: String(cachedAmrBuf.length),
          },
        },
      ],
    });
    assert.strictEqual(inboundEvents.length, 1);
    const inRecSeg = inboundEvents[0].message.find((s) => s.type === "record");
    assert.ok(inRecSeg);
    assert.strictEqual(inRecSeg.data.url, `base64://${cachedAmrBuf.toString("base64")}`);

    // 22d. Live ffmpeg WAV -> AMR-NB outbound + get_record out_format="wav" roundtrip (when ffmpeg AMR encoder is installed)
    const { execFileSync } = require("child_process");
    let ffmpegHasAmrNb = false;
    try {
      const encOut = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
      ffmpegHasAmrNb = /\blibopencore_amrnb\b/.test(encOut);
    } catch (_) {
      ffmpegHasAmrNb = false;
    }

    if (ffmpegHasAmrNb) {
      ntCalls.length = 0;
      const sr = 8000;
      const samples = sr * 2; // 2.0 seconds
      const wavBytes = Buffer.alloc(44 + samples * 2);
      wavBytes.write("RIFF", 0, "ascii");
      wavBytes.writeUInt32LE(36 + samples * 2, 4);
      wavBytes.write("WAVE", 8, "ascii");
      wavBytes.write("fmt ", 12, "ascii");
      wavBytes.writeUInt32LE(16, 16);
      wavBytes.writeUInt16LE(1, 20);
      wavBytes.writeUInt16LE(1, 22);
      wavBytes.writeUInt32LE(sr, 24);
      wavBytes.writeUInt32LE(sr * 2, 28);
      wavBytes.writeUInt16LE(2, 32);
      wavBytes.writeUInt16LE(16, 34);
      wavBytes.write("data", 36, "ascii");
      wavBytes.writeUInt32LE(samples * 2, 40);
      for (let i = 0; i < samples; i++) {
        wavBytes.writeInt16LE(
          Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 10000),
          44 + i * 2
        );
      }

      const wavSendRes = await voiceBridge.handleOneBotAction("send_private_msg", {
        user_id: 100020002,
        message: [{ type: "record", data: { file: `base64://${wavBytes.toString("base64")}` } }],
      });
      assert.strictEqual(wavSendRes.status, "ok");
      const wavSendCall = ntCalls.find((c) => c.cmd === "nodeIKernelMsgService/sendMsg");
      const transcodedPtt = wavSendCall.payload.msgElements[0].pttElement;
      const stagedBytes = fs.readFileSync(transcodedPtt.filePath);
      assert.strictEqual(stagedBytes.subarray(0, 6).toString("ascii"), "#!AMR\n");
      assert.strictEqual(transcodedPtt.duration, 2);

      const getRecWav = await voiceBridge.handleOneBotAction("get_record", {
        message_id: inboundEvents[0].message_id,
        out_format: "wav",
        base64: true,
      });
      assert.strictEqual(getRecWav.status, "ok");
      assert.ok(getRecWav.data.file_name.endsWith(".wav"));
      const outWavBuf = Buffer.from(getRecWav.data.base64, "base64");
      assert.strictEqual(outWavBuf.toString("ascii", 0, 4), "RIFF");
      assert.strictEqual(outWavBuf.toString("ascii", 8, 12), "WAVE");
    }
  } finally {
    if (prevTempEnv === undefined) delete process.env.ROSMONTIS_TEMP_DIR;
    else process.env.ROSMONTIS_TEMP_DIR = prevTempEnv;
    if (voiceBridge) voiceBridge.flushTempCleanup();
    fs.rmSync(tmpVoiceDir, { recursive: true, force: true });
  }
});
