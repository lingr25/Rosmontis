"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const { resolveTempDirFromEnv, resolveFfmpegPathFromEnv } = require("./env");
const {
  resolveMaxMediaBytes,
  pruneTempDirAsync,
  writeTempMediaAtomically,
} = require("./media_security");

const TENCENT_SILK_MAGIC = Buffer.from([
  0x02, 0x23, 0x21, 0x53, 0x49, 0x4c, 0x4b, 0x5f, 0x56, 0x33,
]);
const RAW_SILK_MAGIC = Buffer.from("#!SILK_V3", "ascii");
const AMR_NB_MAGIC = Buffer.from("#!AMR\n", "ascii");
const AMR_WB_MAGIC = Buffer.from("#!AMR-WB\n", "ascii");

const AMR_NB_FRAME_SIZES = Object.freeze([
  13, 14, 16, 18, 20, 21, 27, 32, 6, 6, 6, 6, 1, 1, 1, 1,
]);
const AMR_WB_FRAME_SIZES = Object.freeze([
  18, 24, 33, 37, 41, 47, 51, 59, 61, 6, 1, 1, 1, 1, 1, 1,
]);

const DEFAULT_WAVE_AMPLITUDES = Object.freeze([18, 42, 65, 51, 33, 72, 48, 25]);

const OUT_FORMAT_SPECS = Object.freeze({
  mp3: Object.freeze({ ext: ".mp3", args: ["-vn", "-f", "mp3"] }),
  wav: Object.freeze({ ext: ".wav", args: ["-vn", "-acodec", "pcm_s16le", "-f", "wav"] }),
  ogg: Object.freeze({ ext: ".ogg", args: ["-vn", "-f", "ogg"] }),
  spx: Object.freeze({ ext: ".ogg", args: ["-vn", "-f", "ogg"] }),
  flac: Object.freeze({ ext: ".flac", args: ["-vn", "-f", "flac"] }),
  m4a: Object.freeze({ ext: ".m4a", args: ["-vn", "-c:a", "aac", "-f", "ipod"] }),
  wma: Object.freeze({ ext: ".asf", args: ["-vn", "-c:a", "wmav2", "-f", "asf"] }),
  amr: Object.freeze({
    ext: ".amr",
    args: ["-vn", "-ar", "8000", "-ac", "1", "-ab", "12.2k", "-f", "amr"],
  }),
});

function _startsWithBytes(buf, prefix) {
  if (!Buffer.isBuffer(buf) || buf.length < prefix.length) return false;
  return buf.subarray(0, prefix.length).equals(prefix);
}

function _payloadEnergy(buf, start, len) {
  if (len <= 0 || start >= buf.length) return 0;
  const end = Math.min(buf.length, start + len);
  const step = len > 32 ? Math.max(1, Math.floor(len / 16)) : 1;
  let sum = 0;
  let count = 0;
  for (let i = start; i < end; i += step) {
    sum += buf[i];
    count += 1;
  }
  if (count === 0) return len;
  const mean = sum / count;
  let mad = 0;
  for (let i = start; i < end; i += step) {
    mad += Math.abs(buf[i] - mean);
  }
  return len * 1.5 + mad / count;
}

function _normalizeWaveAmplitudes(samples, bucketCount = 16) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return [...DEFAULT_WAVE_AMPLITUDES];
  }
  const targetLen = Math.min(24, Math.max(8, Math.min(bucketCount, samples.length)));
  const buckets = new Array(targetLen).fill(0);
  for (let b = 0; b < targetLen; b++) {
    const from = Math.floor((b * samples.length) / targetLen);
    const to = Math.max(from + 1, Math.floor(((b + 1) * samples.length) / targetLen));
    let acc = 0;
    let n = 0;
    for (let i = from; i < to && i < samples.length; i++) {
      acc += samples[i];
      n += 1;
    }
    buckets[b] = n > 0 ? acc / n : 0;
  }

  let minVal = Infinity;
  let maxVal = -Infinity;
  for (const v of buckets) {
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }
  const span = maxVal - minVal;
  if (!Number.isFinite(span) || span < 1e-6) {
    return DEFAULT_WAVE_AMPLITUDES.slice(0, Math.min(DEFAULT_WAVE_AMPLITUDES.length, targetLen));
  }
  return buckets.map((v) => Math.max(12, Math.min(95, Math.round(16 + ((v - minVal) / span) * 76))));
}

function _parseSilkFrames(buf, headerLen) {
  let offset = headerLen;
  let frameCount = 0;
  const energies = [];
  while (offset + 2 <= buf.length) {
    const blockBytes = buf.readInt16LE(offset);
    if (blockBytes < 0) break;
    if (blockBytes === 0 || offset + 2 + blockBytes > buf.length) break;
    frameCount += 1;
    if (energies.length < 512) {
      energies.push(_payloadEnergy(buf, offset + 2, blockBytes));
    }
    offset += 2 + blockBytes;
  }
  const durationSec = frameCount * 0.02;
  return {
    frameCount,
    durationSec,
    duration: durationSec > 0 ? Math.max(1, Math.round(durationSec)) : 0,
    waveAmplitudes: _normalizeWaveAmplitudes(energies),
  };
}

function _parseAmrFrames(buf, headerLen, frameTable) {
  let offset = headerLen;
  let frameCount = 0;
  const energies = [];
  while (offset < buf.length) {
    const toc = buf[offset];
    const mode = (toc >> 3) & 0x0f;
    const frameLen = frameTable[mode] || 0;
    if (frameLen <= 0 || offset + frameLen > buf.length) break;
    frameCount += 1;
    if (energies.length < 512) {
      energies.push(frameLen > 1 ? _payloadEnergy(buf, offset + 1, frameLen - 1) : 1);
    }
    offset += frameLen;
  }
  const durationSec = frameCount * 0.02;
  return {
    frameCount,
    durationSec,
    duration: durationSec > 0 ? Math.max(1, Math.round(durationSec)) : 0,
    waveAmplitudes: _normalizeWaveAmplitudes(energies),
  };
}

function _parseWavBuffer(buf) {
  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataBytes = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = Math.min(buf.length, bodyStart + chunkSize);

    if (chunkId === "fmt " && bodyEnd - bodyStart >= 16) {
      audioFormat = buf.readUInt16LE(bodyStart);
      channels = buf.readUInt16LE(bodyStart + 2);
      sampleRate = buf.readUInt32LE(bodyStart + 4);
      byteRate = buf.readUInt32LE(bodyStart + 8);
      bitsPerSample = buf.readUInt16LE(bodyStart + 14);
    } else if (chunkId === "data") {
      dataOffset = bodyStart;
      dataBytes = bodyEnd - bodyStart;
      break;
    }

    const nextOffset = bodyStart + chunkSize + (chunkSize % 2);
    if (nextOffset <= offset) break;
    offset = nextOffset;
  }

  const effectiveByteRate =
    byteRate > 0
      ? byteRate
      : sampleRate > 0 && channels > 0 && bitsPerSample > 0
      ? Math.floor((sampleRate * channels * bitsPerSample) / 8)
      : 0;
  const durationSec = effectiveByteRate > 0 && dataBytes > 0 ? dataBytes / effectiveByteRate : 0;

  const energies = [];
  if (dataBytes > 0 && dataOffset > 0) {
    const sliceCount = 24;
    const sliceLen = Math.max(2, Math.floor(dataBytes / sliceCount));
    for (let s = 0; s < sliceCount; s++) {
      const start = dataOffset + s * sliceLen;
      if (start >= dataOffset + dataBytes) break;
      const len = Math.min(sliceLen, dataOffset + dataBytes - start, 256);
      if (audioFormat === 1 && bitsPerSample === 16 && len >= 2) {
        let sumAbs = 0;
        let samples = 0;
        for (let i = start; i + 1 < start + len; i += 2) {
          sumAbs += Math.abs(buf.readInt16LE(i));
          samples += 1;
        }
        energies.push(samples > 0 ? sumAbs / samples : 0);
      } else {
        energies.push(_payloadEnergy(buf, start, len));
      }
    }
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    durationSec,
    duration: durationSec > 0 ? Math.max(1, Math.round(durationSec)) : 0,
    waveAmplitudes: _normalizeWaveAmplitudes(energies),
  };
}

function _looksLikeMp3(buf) {
  if (buf.length < 4) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    const layer = (buf[1] >> 1) & 0x03;
    const bitrateIdx = (buf[2] >> 4) & 0x0f;
    const srIdx = (buf[2] >> 2) & 0x03;
    return layer !== 0 && bitrateIdx !== 0x0f && srIdx !== 0x03;
  }
  return false;
}

function inspectAudioBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return {
      format: "empty",
      isNtNativeVoice: false,
      needsTencentPrefix: false,
      durationSec: 0,
      duration: 0,
      waveAmplitudes: [...DEFAULT_WAVE_AMPLITUDES],
    };
  }

  if (_startsWithBytes(buf, TENCENT_SILK_MAGIC)) {
    const parsed = _parseSilkFrames(buf, TENCENT_SILK_MAGIC.length);
    return {
      format: "silk_tencent",
      isNtNativeVoice: true,
      needsTencentPrefix: false,
      ...parsed,
    };
  }

  if (_startsWithBytes(buf, RAW_SILK_MAGIC)) {
    const parsed = _parseSilkFrames(buf, RAW_SILK_MAGIC.length);
    return {
      format: "silk_raw",
      isNtNativeVoice: false,
      needsTencentPrefix: true,
      ...parsed,
    };
  }

  if (_startsWithBytes(buf, AMR_WB_MAGIC)) {
    const parsed = _parseAmrFrames(buf, AMR_WB_MAGIC.length, AMR_WB_FRAME_SIZES);
    return {
      format: "amr_wb",
      isNtNativeVoice: false,
      needsTencentPrefix: false,
      ...parsed,
    };
  }

  if (_startsWithBytes(buf, AMR_NB_MAGIC)) {
    const parsed = _parseAmrFrames(buf, AMR_NB_MAGIC.length, AMR_NB_FRAME_SIZES);
    return {
      format: "amr_nb",
      isNtNativeVoice: true,
      needsTencentPrefix: false,
      ...parsed,
    };
  }

  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE"
  ) {
    const parsed = _parseWavBuffer(buf);
    return {
      format: "wav",
      isNtNativeVoice: false,
      needsTencentPrefix: false,
      ...parsed,
    };
  }

  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "OggS") {
    return {
      format: "ogg",
      isNtNativeVoice: false,
      needsTencentPrefix: false,
      durationSec: 0,
      duration: 0,
      waveAmplitudes: [...DEFAULT_WAVE_AMPLITUDES],
    };
  }

  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "fLaC") {
    return {
      format: "flac",
      isNtNativeVoice: false,
      needsTencentPrefix: false,
      durationSec: 0,
      duration: 0,
      waveAmplitudes: [...DEFAULT_WAVE_AMPLITUDES],
    };
  }

  if (buf.length >= 8 && buf.toString("ascii", 4, 8) === "ftyp") {
    return {
      format: "m4a",
      isNtNativeVoice: false,
      needsTencentPrefix: false,
      durationSec: 0,
      duration: 0,
      waveAmplitudes: [...DEFAULT_WAVE_AMPLITUDES],
    };
  }

  if (
    buf.length >= 4 &&
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  ) {
    return {
      format: "webm",
      isNtNativeVoice: false,
      needsTencentPrefix: false,
      durationSec: 0,
      duration: 0,
      waveAmplitudes: [...DEFAULT_WAVE_AMPLITUDES],
    };
  }

  if (_looksLikeMp3(buf)) {
    return {
      format: "mp3",
      isNtNativeVoice: false,
      needsTencentPrefix: false,
      durationSec: 0,
      duration: 0,
      waveAmplitudes: [...DEFAULT_WAVE_AMPLITUDES],
    };
  }

  return {
    format: "unknown",
    isNtNativeVoice: false,
    needsTencentPrefix: false,
    durationSec: 0,
    duration: 0,
    waveAmplitudes: [...DEFAULT_WAVE_AMPLITUDES],
  };
}

async function inspectAudioFile(filePath) {
  const buf = await fs.promises.readFile(filePath);
  return { buf, info: inspectAudioBuffer(buf) };
}

function _execFfmpeg(ffmpegBin, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegBin,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr ? String(stderr).trim() : "";
          err.stdout = stdout ? String(stdout).trim() : "";
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function transcodeAudioToAmrNb(inputPath, options = {}) {
  const maxMediaBytes = resolveMaxMediaBytes(options);
  const tempDir = resolveTempDirFromEnv(options.tempDir);
  await fs.promises.mkdir(tempDir, { recursive: true, mode: 0o700 });
  const maxTempFiles = Math.max(8, Number(options.maxTempFiles || 128));
  const ffmpegBin = resolveFfmpegPathFromEnv(options.ffmpegPath);
  const timeoutMs = Math.max(2000, Number(options.transcodeTimeoutMs || 30000));

  const resolvedInput = path.resolve(inputPath);
  const tmpOut = path.join(
    tempDir,
    `ptt_${process.pid}_${crypto.randomBytes(6).toString("hex")}.part.amr`
  );

  try {
    await _execFfmpeg(
      ffmpegBin,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        resolvedInput,
        "-vn",
        "-ar",
        "8000",
        "-ac",
        "1",
        "-ab",
        "12.2k",
        "-f",
        "amr",
        tmpOut,
      ],
      timeoutMs
    );

    const outBuf = await fs.promises.readFile(tmpOut);
    await fs.promises.unlink(tmpOut).catch(() => {});

    if (outBuf.length === 0) {
      throw new Error("ffmpeg produced an empty AMR output file");
    }
    if (outBuf.length > maxMediaBytes) {
      const err = new Error(
        `Transcoded AMR voice (${outBuf.length} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`
      );
      err.code = "ERR_MEDIA_TOO_LARGE";
      throw err;
    }

    const md5HexStr = crypto.createHash("md5").update(outBuf).digest("hex");
    const fileName = `${md5HexStr}.amr`;
    const finalPath = path.join(tempDir, fileName);
    await writeTempMediaAtomically(finalPath, outBuf, false);
    await pruneTempDirAsync(tempDir, maxTempFiles);

    const info = inspectAudioBuffer(outBuf);
    return {
      localPath: finalPath,
      fileName,
      fileSize: outBuf.length,
      md5HexStr,
      format: info.format,
      formatType: 1,
      duration: info.duration || 3,
      durationSec: info.durationSec,
      waveAmplitudes: info.waveAmplitudes,
      isTempFile: true,
    };
  } catch (err) {
    await fs.promises.unlink(tmpOut).catch(() => {});
    if (err && err.code === "ERR_MEDIA_TOO_LARGE") {
      throw err;
    }
    const detected = options.detectedFormat
      ? String(options.detectedFormat).toUpperCase()
      : "non-SILK/AMR";
    const detail =
      err && err.code === "ENOENT"
        ? `ffmpeg binary not found (${ffmpegBin})`
        : String(err?.stderr || err?.message || "unknown ffmpeg error");
    const wrapped = new Error(
      `Failed to transcode ${detected} audio to NTQQ voice (AMR-NB): ${detail}. ` +
        `Install ffmpeg (with libavcodec-extra on Debian/Ubuntu) or supply SILK v3 / AMR-NB audio.`
    );
    wrapped.code = "ERR_VOICE_TRANSCODE_FAILED";
    throw wrapped;
  }
}

async function prepareVoiceMedia(media, options = {}) {
  const maxMediaBytes = resolveMaxMediaBytes(options);
  const { buf, info } = await inspectAudioFile(media.localPath);

  if (info.isNtNativeVoice) {
    return {
      localPath: media.localPath,
      fileName: media.fileName || `${media.md5HexStr}.amr`,
      fileSize: media.fileSize || buf.length,
      md5HexStr: media.md5HexStr,
      format: info.format,
      formatType: 1,
      duration: info.duration || 3,
      durationSec: info.durationSec,
      waveAmplitudes: info.waveAmplitudes,
      extraTempMedia: null,
    };
  }

  if (info.needsTencentPrefix) {
    const prefixed = Buffer.concat([Buffer.from([0x02]), buf]);
    if (prefixed.length > maxMediaBytes) {
      const err = new Error(
        `Normalized SILK voice (${prefixed.length} bytes) exceeds maximum limit (${maxMediaBytes} bytes)`
      );
      err.code = "ERR_MEDIA_TOO_LARGE";
      throw err;
    }
    const tempDir = resolveTempDirFromEnv(options.tempDir);
    await fs.promises.mkdir(tempDir, { recursive: true, mode: 0o700 });
    const maxTempFiles = Math.max(8, Number(options.maxTempFiles || 128));
    const md5HexStr = crypto.createHash("md5").update(prefixed).digest("hex");
    const fileName = `${md5HexStr}.amr`;
    const localPath = path.join(tempDir, fileName);
    await writeTempMediaAtomically(localPath, prefixed, false);
    await pruneTempDirAsync(tempDir, maxTempFiles);
    return {
      localPath,
      fileName,
      fileSize: prefixed.length,
      md5HexStr,
      format: "silk_tencent",
      formatType: 1,
      duration: info.duration || 3,
      durationSec: info.durationSec,
      waveAmplitudes: info.waveAmplitudes,
      extraTempMedia: { localPath, isTempFile: true },
    };
  }

  const transcoded = await transcodeAudioToAmrNb(media.localPath, {
    ...options,
    detectedFormat: info.format,
  });
  return {
    localPath: transcoded.localPath,
    fileName: transcoded.fileName,
    fileSize: transcoded.fileSize,
    md5HexStr: transcoded.md5HexStr,
    format: transcoded.format,
    formatType: transcoded.formatType,
    duration: transcoded.duration,
    durationSec: transcoded.durationSec,
    waveAmplitudes: transcoded.waveAmplitudes,
    extraTempMedia: { localPath: transcoded.localPath, isTempFile: true },
  };
}

async function transcodeRecordOutFormat(inputPath, rawOutFormat, options = {}) {
  const normFmt = String(rawOutFormat || "")
    .trim()
    .replace(/^\.+/, "")
    .toLowerCase();
  if (!normFmt || !Object.prototype.hasOwnProperty.call(OUT_FORMAT_SPECS, normFmt)) {
    return null;
  }

  const spec = OUT_FORMAT_SPECS[normFmt];
  let info;
  try {
    ({ info } = await inspectAudioFile(inputPath));
  } catch (_) {
    return null;
  }

  if (
    (normFmt === "amr" && (info.format === "amr_nb" || info.format === "silk_tencent")) ||
    (normFmt === "wav" && info.format === "wav") ||
    (normFmt === "mp3" && info.format === "mp3") ||
    (normFmt === "ogg" && info.format === "ogg") ||
    (normFmt === "flac" && info.format === "flac") ||
    (normFmt === "m4a" && info.format === "m4a")
  ) {
    return null;
  }

  // Standard ffmpeg lacks a Tencent SILK v3 decoder; return null so get_record falls back cleanly
  if (info.format === "silk_tencent" || info.format === "silk_raw") {
    return null;
  }

  const maxMediaBytes = resolveMaxMediaBytes(options);
  const tempDir = resolveTempDirFromEnv(options.tempDir);
  await fs.promises.mkdir(tempDir, { recursive: true, mode: 0o700 });
  const maxTempFiles = Math.max(8, Number(options.maxTempFiles || 128));
  const ffmpegBin = resolveFfmpegPathFromEnv(options.ffmpegPath);
  const timeoutMs = Math.max(2000, Number(options.transcodeTimeoutMs || 30000));

  const tmpOut = path.join(
    tempDir,
    `rec_out_${process.pid}_${crypto.randomBytes(6).toString("hex")}${spec.ext}`
  );

  try {
    await _execFfmpeg(
      ffmpegBin,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path.resolve(inputPath),
        ...spec.args,
        tmpOut,
      ],
      timeoutMs
    );
    const outBuf = await fs.promises.readFile(tmpOut);
    await fs.promises.unlink(tmpOut).catch(() => {});
    if (outBuf.length === 0 || outBuf.length > maxMediaBytes) {
      return null;
    }
    const md5HexStr = crypto.createHash("md5").update(outBuf).digest("hex");
    const fileName = `${md5HexStr}${spec.ext}`;
    const finalPath = path.join(tempDir, fileName);
    await writeTempMediaAtomically(finalPath, outBuf, false);
    await pruneTempDirAsync(tempDir, maxTempFiles);
    return {
      localPath: finalPath,
      fileName,
      fileSize: outBuf.length,
      md5HexStr,
      isTempFile: true,
    };
  } catch (_) {
    await fs.promises.unlink(tmpOut).catch(() => {});
    return null;
  }
}

module.exports = {
  TENCENT_SILK_MAGIC,
  RAW_SILK_MAGIC,
  AMR_NB_MAGIC,
  AMR_WB_MAGIC,
  DEFAULT_WAVE_AMPLITUDES,
  inspectAudioBuffer,
  inspectAudioFile,
  transcodeAudioToAmrNb,
  prepareVoiceMedia,
  transcodeRecordOutFormat,
};
