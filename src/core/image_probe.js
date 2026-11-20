// @ts-check
"use strict";

/**
 * Pure Image Header Dimension Inspector (`src/core/image_probe.js`)
 *
 * Zero-dependency binary header parser for PNG, GIF, WebP (VP8/VP8L/VP8X),
 * and JPEG images. Used by both media resolution and streaming HTTP downloads.
 */

/**
 * @typedef {object} ImageDimensions
 * @property {number} width
 * @property {number} height
 * @property {boolean} isGif
 * @property {string} ext
 */

/**
 * Inspects image header bytes to extract dimensions, animation flag, and
 * canonical file extension. Falls back to `{ width: 512, height: 512, isGif: false, ext: ".jpg" }`.
 *
 * @param {Buffer | Uint8Array | null | undefined} buf
 * @returns {ImageDimensions}
 */
function inspectImageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) {
    return { width: 512, height: 512, isGif: false, ext: ".jpg" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16) || 512;
    const height = buf.readUInt32BE(20) || 512;
    return { width, height, isGif: false, ext: ".png" };
  }
  // GIF: "GIF87a" or "GIF89a"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    const width = buf.readUInt16LE(6) || 256;
    const height = buf.readUInt16LE(8) || 256;
    return { width, height, isGif: true, ext: ".gif" };
  }
  // WEBP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    let width = 512;
    let height = 512;
    const chunkHeader = buf.subarray(12, 16).toString("ascii");
    if (chunkHeader === "VP8 " && buf.length >= 30) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunkHeader === "VP8L" && buf.length >= 25) {
      const b0 = buf[21];
      const b1 = buf[22];
      const b2 = buf[23];
      const b3 = buf[24];
      width = 1 + (((b1 & 0x3f) << 8) | b0);
      height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    } else if (chunkHeader === "VP8X" && buf.length >= 30) {
      width = 1 + buf.readUIntLE(24, 3);
      height = 1 + buf.readUIntLE(27, 3);
    }
    return { width: width || 512, height: height || 512, isGif: false, ext: ".webp" };
  }
  // JPEG: FF D8
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1];
      if (marker === 0xff) {
        offset++;
        continue;
      }
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        const height = buf.readUInt16BE(offset + 5) || 512;
        const width = buf.readUInt16BE(offset + 7) || 512;
        return { width, height, isGif: false, ext: ".jpg" };
      }
      const segLen = buf.readUInt16BE(offset + 2);
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
    return { width: 512, height: 512, isGif: false, ext: ".jpg" };
  }
  return { width: 512, height: 512, isGif: false, ext: ".jpg" };
}

module.exports = {
  inspectImageDimensions,
};
