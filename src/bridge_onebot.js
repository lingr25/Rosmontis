// @ts-check
"use strict";

/**
 * Pure Node.js OneBot v11 Protocol & NTQQ Kernel Data Converter (`src/bridge_onebot.js`)
 *
 * Barrel facade re-exporting decomposed protocol modules (`src/onebot/*`) and
 * media/image/metadata utilities (`src/core/image_probe.js`, `src/core/ntqq_meta.js`,
 * `src/core/media_downloader.js`, `src/core/media_security.js`, `src/core/audio_codec.js`)
 * for backward compatibility.
 */

const { inspectImageDimensions } = require("./core/image_probe");

const { getNtqqVersionMetadata, buildNtqqUserAgent } = require("./core/ntqq_meta");

const {
  DEFAULT_MAX_MEDIA_BYTES,
  resolveMaxMediaBytes,
  pruneTempDir,
  pruneTempDirAsync,
  downloadBufferFromUrl,
  downloadMediaStreamToTempDir,
} = require("./core/media_downloader");

const {
  isPrivateOrReservedIp,
  createSsrfSafeLookup,
  resolveMediaSource,
} = require("./core/media_security");

const {
  inspectAudioBuffer,
  inspectAudioFile,
  prepareVoiceMedia,
  transcodeRecordOutFormat,
} = require("./core/audio_codec");

const {
  MessageIdStore,
  UinUidStore,
  pickPositiveUin,
} = require("./onebot/stores");

const {
  escapeCqText,
  unescapeCqText,
  escapeCqParam,
  segmentsToCqCode,
  parseCqCodeToSegments,
  normalizeOneBotMessage,
} = require("./onebot/cq_codec");

const {
  buildNtPicUrl,
  buildNtMarketFaceUrl,
  buildNtRecordUri,
  stripTransientNtMedia,
  ntMsgToOneBotSegments,
  oneBotSegmentsToNtElements,
} = require("./onebot/segment_converter");

const {
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
  formatMetaEvent,
} = require("./onebot/event_formatter");

module.exports = {
  DEFAULT_MAX_MEDIA_BYTES,
  MessageIdStore,
  UinUidStore,
  pickPositiveUin,
  stripTransientNtMedia,
  escapeCqText,
  unescapeCqText,
  escapeCqParam,
  segmentsToCqCode,
  parseCqCodeToSegments,
  normalizeOneBotMessage,
  inspectImageDimensions,
  inspectAudioBuffer,
  inspectAudioFile,
  prepareVoiceMedia,
  transcodeRecordOutFormat,
  getNtqqVersionMetadata,
  buildNtqqUserAgent,
  resolveMaxMediaBytes,
  isPrivateOrReservedIp,
  createSsrfSafeLookup,
  pruneTempDir,
  pruneTempDirAsync,
  downloadBufferFromUrl,
  downloadMediaStreamToTempDir,
  resolveMediaSource,
  buildNtPicUrl,
  buildNtMarketFaceUrl,
  buildNtRecordUri,
  ntMsgToOneBotSegments,
  oneBotSegmentsToNtElements,
  formatNtMsgToOneBotEvent,
  formatGroupUploadNotice,
  formatNoticeEvent,
  formatRequestEvent,
  formatMetaEvent,
};
