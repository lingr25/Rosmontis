// @ts-check
"use strict";

/**
 * NTQQ 3.2.32 PTT `otherBusinessInfo` & Isolated SILK v3 Worker Codec Tests
 */

const test = require("node:test");
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { REPO_ROOT, onebot } = require("./_helpers");

const audioCodecMod = require(path.join(REPO_ROOT, "src", "core", "audio_codec.js"));
const envMod = require(path.join(REPO_ROOT, "src", "core", "env.js"));
const { loadBridgeConfig } = require(path.join(REPO_ROOT, "src", "core", "config.js"));

function buildTestWavBuffer(durationSec = 2, sampleRate = 24000) {
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
  const pcm = Buffer.alloc(numSamples * 2);
  for (let i = 0; i < numSamples; i++) {
    const val = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000);
    pcm.writeInt16LE(val, i * 2);
  }
  return audioCodecMod.wrapPcmS16leToWavBuffer(pcm, sampleRate, 1);
}

function buildTestSilkV3Buffer(frameCount = 100) {
  const chunks = [Buffer.from(audioCodecMod.TENCENT_SILK_MAGIC)];
  for (let i = 0; i < frameCount; i++) {
    const frame = Buffer.alloc(12, 0x2a);
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16LE(frame.length, 0);
    chunks.push(lenBuf, frame);
  }
  chunks.push(Buffer.from([0xff, 0xff]));
  return Buffer.concat(chunks);
}

function buildTestAmrNbBuffer(frameCount = 50) {
  const chunks = [Buffer.from(audioCodecMod.AMR_NB_MAGIC)];
  for (let i = 0; i < frameCount; i++) {
    // Mode 0 (13 bytes per frame including TOC byte 0x04)
    const frame = Buffer.alloc(13, 0x11);
    frame[0] = 0x04;
    chunks.push(frame);
  }
  return Buffer.concat(chunks);
}

test("oneBotSegmentsToNtElements populates NTQQ 3.2.32 pttElement.otherBusinessInfo and playback fields", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis-ptt-meta-"));
  try {
    const silkBuf = buildTestSilkV3Buffer(150);
    const silkPath = path.join(tmpDir, "voice.amr");
    fs.writeFileSync(silkPath, silkBuf);

    const { elements } = await onebot.oneBotSegmentsToNtElements(
      [{ type: "record", data: { file: silkPath } }],
      {
        tempDir: tmpDir,
        allowArbitraryLocalFiles: true,
        silkAddonPath: false,
      }
    );

    assert.strictEqual(elements.length, 1);
    assert.strictEqual(elements[0].elementType, 4);
    const ptt = elements[0].pttElement;
    assert.ok(ptt);
    assert.strictEqual(ptt.formatType, 1);
    assert.strictEqual(ptt.voiceType, 1);
    assert.strictEqual(ptt.canConvert2Text, true);
    assert.strictEqual(ptt.playState, 0);
    assert.strictEqual(ptt.autoConvertText, 0);
    assert.strictEqual(ptt.waveform, "");
    assert.strictEqual(ptt.translateStatus, 0);
    assert.strictEqual(ptt.transferStatus, 0);
    assert.strictEqual(ptt.progress, 0);
    assert.strictEqual(ptt.invalidState, 0);
    assert.strictEqual(ptt.pttFlag, 0);
    assert.strictEqual(ptt.fileSubId, "");
    assert.strictEqual(ptt.fileBizId, null);
    assert.strictEqual(ptt.import_rich_media_context, "");
    assert.strictEqual(ptt.storeID, 0);
    assert.strictEqual(ptt.storeId, "0");
    assert.deepStrictEqual(ptt.otherBusinessInfo, { aiVoiceType: 0, aiVoiceInfo: 0 });
    assert.strictEqual(ptt.isAIVoiceType, 0);
    assert.strictEqual(ptt.isInApplicationPath, null);
    for (const [k, v] of Object.entries(ptt)) {
      assert.notStrictEqual(v, undefined, `pttElement.${k} must never be undefined`);
    }
    assert.strictEqual(ptt.duration, 3);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Isolated SILK v3 worker encodes WAV/AMR to Tencent SILK v3 and decodes back to WAV/MP3", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis-silk-worker-"));
  try {
    const stubAddonPath = path.join(tmpDir, "mock_silk_addon.cjs");
    const sampleSilkHex = buildTestSilkV3Buffer(100).toString("hex");
    const sampleWavHex = buildTestWavBuffer(2).toString("hex");
    // Minimal ID3 + MP3 frame header recognizable by inspectAudioBuffer
    const sampleMp3Hex = Buffer.concat([
      Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x00", "binary"),
      Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x00, 0x00]),
    ]).toString("hex");

    fs.writeFileSync(
      stubAddonPath,
      [
        '"use strict";',
        'const fs = require("fs");',
        `const SILK_BUF = Buffer.from("${sampleSilkHex}", "hex");`,
        `const WAV_BUF = Buffer.from("${sampleWavHex}", "hex");`,
        `const MP3_BUF = Buffer.from("${sampleMp3Hex}", "hex");`,
        "module.exports = {",
        "  async convertToNTSilkTct(_inputPath, outputPath) {",
        "    fs.writeFileSync(outputPath, SILK_BUF);",
        "  },",
        "  async getDuration() {",
        "    return 2.0;",
        "  },",
        "  async decodeAudioToFmt(_inputPath, outputPath, fmt) {",
        '    fs.writeFileSync(outputPath, fmt === "mp3" ? MP3_BUF : WAV_BUF);',
        "  },",
        "};",
      ].join("\n"),
      "utf8"
    );

    const wavBuf = buildTestWavBuffer(2);
    const wavPath = path.join(tmpDir, "tone.wav");
    fs.writeFileSync(wavPath, wavBuf);
    const wavMd5 = crypto.createHash("md5").update(wavBuf).digest("hex");

    // 1. WAV -> Tencent SILK v3 via isolated worker
    const silkFromWav = await audioCodecMod.prepareVoiceMedia(
      {
        localPath: wavPath,
        fileName: "tone.wav",
        fileSize: wavBuf.length,
        md5HexStr: wavMd5,
      },
      {
        tempDir: tmpDir,
        silkAddonPath: stubAddonPath,
        nodeBinPath: process.execPath,
      }
    );
    assert.strictEqual(silkFromWav.format, "silk_tencent");
    assert.strictEqual(silkFromWav.duration, 2);
    assert.ok(silkFromWav.extraTempMedia && silkFromWav.extraTempMedia.isTempFile);
    const encodedBytes = fs.readFileSync(silkFromWav.localPath);
    assert.strictEqual(
      encodedBytes.subarray(0, 10).equals(audioCodecMod.TENCENT_SILK_MAGIC),
      true
    );

    // 2. AMR-NB -> Tencent SILK v3 when isolated worker is configured
    const amrBuf = buildTestAmrNbBuffer(50);
    const amrPath = path.join(tmpDir, "legacy.amr");
    fs.writeFileSync(amrPath, amrBuf);
    const amrMd5 = crypto.createHash("md5").update(amrBuf).digest("hex");
    const silkFromAmr = await audioCodecMod.prepareVoiceMedia(
      {
        localPath: amrPath,
        fileName: "legacy.amr",
        fileSize: amrBuf.length,
        md5HexStr: amrMd5,
      },
      {
        tempDir: tmpDir,
        silkAddonPath: stubAddonPath,
        nodeBinPath: process.execPath,
      }
    );
    assert.strictEqual(silkFromAmr.format, "silk_tencent");
    assert.ok(silkFromAmr.extraTempMedia && silkFromAmr.extraTempMedia.isTempFile);

    // 3. AMR-NB passthrough when silkAddonPath is explicitly disabled
    const passthroughAmr = await audioCodecMod.prepareVoiceMedia(
      {
        localPath: amrPath,
        fileName: "legacy.amr",
        fileSize: amrBuf.length,
        md5HexStr: amrMd5,
      },
      {
        tempDir: tmpDir,
        silkAddonPath: false,
        ffmpegPath: path.join(tmpDir, "nonexistent_ffmpeg_bin"),
      }
    );
    assert.strictEqual(passthroughAmr.format, "amr_nb");
    assert.strictEqual(passthroughAmr.localPath, amrPath);
    assert.strictEqual(passthroughAmr.extraTempMedia, null);

    // 4. Decode Tencent SILK v3 -> WAV and MP3 via isolated worker
    const decodedWav = await audioCodecMod.transcodeRecordOutFormat(
      silkFromWav.localPath,
      "wav",
      {
        tempDir: tmpDir,
        silkAddonPath: stubAddonPath,
        nodeBinPath: process.execPath,
      }
    );
    assert.ok(decodedWav && decodedWav.fileName.endsWith(".wav"));
    const decodedWavBytes = fs.readFileSync(decodedWav.localPath);
    assert.strictEqual(decodedWavBytes.toString("ascii", 0, 4), "RIFF");
    assert.strictEqual(decodedWavBytes.toString("ascii", 8, 12), "WAVE");

    const decodedMp3 = await audioCodecMod.transcodeRecordOutFormat(
      silkFromWav.localPath,
      "mp3",
      {
        tempDir: tmpDir,
        silkAddonPath: stubAddonPath,
        nodeBinPath: process.execPath,
      }
    );
    assert.ok(decodedMp3 && decodedMp3.fileName.endsWith(".mp3"));
    assert.strictEqual(
      audioCodecMod.inspectAudioBuffer(fs.readFileSync(decodedMp3.localPath)).format,
      "mp3"
    );

    // 5. Env & config resolution for SILK_ADDON_PATH and NODE_BIN
    assert.strictEqual(envMod.resolveSilkAddonPathFromEnv("none"), "");
    assert.strictEqual(envMod.resolveSilkAddonPathFromEnv(false), "");
    assert.strictEqual(envMod.resolveSilkAddonPathFromEnv(stubAddonPath), stubAddonPath);

    const prevAddon = process.env.ROSMONTIS_SILK_ADDON_PATH;
    const prevNode = process.env.ROSMONTIS_NODE_BIN;
    try {
      process.env.ROSMONTIS_SILK_ADDON_PATH = stubAddonPath;
      process.env.ROSMONTIS_NODE_BIN = process.execPath;
      const cfg = loadBridgeConfig(path.join(tmpDir, "empty_cfg"));
      assert.strictEqual(cfg.silkAddonPath, stubAddonPath);
      assert.strictEqual(cfg.nodeBinPath, process.execPath);
    } finally {
      if (prevAddon === undefined) delete process.env.ROSMONTIS_SILK_ADDON_PATH;
      else process.env.ROSMONTIS_SILK_ADDON_PATH = prevAddon;
      if (prevNode === undefined) delete process.env.ROSMONTIS_NODE_BIN;
      else process.env.ROSMONTIS_NODE_BIN = prevNode;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
