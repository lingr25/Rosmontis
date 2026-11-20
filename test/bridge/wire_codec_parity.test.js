"use strict";

/**
 * Cross-process wire codec parity tests (`src/core/primitives.js` <-> `src/bridge_renderer.js`)
 * and decomposed module / facade verification (`image_probe.js`, `ntqq_meta.js`,
 * `media_downloader.js`, `media_security.js`, `stores.js`, `segment_converter.js`, `bridge_onebot.js`).
 */

const test = require("node:test");
const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const primitives = require("../../src/core/primitives");
const renderer = require("../../src/bridge_renderer");
const imageProbe = require("../../src/core/image_probe");
const ntqqMeta = require("../../src/core/ntqq_meta");
const mediaDownloader = require("../../src/core/media_downloader");
const mediaSecurity = require("../../src/core/media_security");
const storesMod = require("../../src/onebot/stores");
const segmentConverter = require("../../src/onebot/segment_converter");
const onebotFacade = require("../../src/bridge_onebot");

// ============================================================================
// 1. Wire Codec Parity: primitives.js <-> bridge_renderer.js
// ============================================================================

test("Wire codec parity: nested Maps (numeric & string keys), Uint8Array, Buffer, BigInt, Date, undefined", () => {
  const isoDate = "2026-11-20T19:20:45.123Z";
  const dateVal = new Date(isoDate);

  const deepMap = new Map([
    [0, "/tmp/thumb_0.jpg"],
    [720, "/tmp/thumb_720.jpg"],
    ["nested", new Map([[1, "one"], ["bytes", new Uint8Array([0, 127, 255])]])],
    ["empty", new Map()],
  ]);

  // --- Direction A: Main -> Renderer -> Main ---
  const mainPayload = {
    msgId: 7299999999999999999n,
    negBig: -9007199254740993n,
    createdAt: dateVal,
    u8: new Uint8Array([1, 2, 3, 254, 255]),
    buf: Buffer.from([10, 20, 30, 40]),
    maps: deepMap,
    xss: "</script><img src=x>&\u2028\u2029",
    voidMarker: { __rosmontisVoid__: true },
    arr: [1, { __rosmontisVoid__: true }, "tail"],
  };

  const mainWire = primitives.serializeBridgePayload(mainPayload);
  assert.ok(!mainWire.includes("</script>"), "serializeBridgePayload must escape < and >");
  assert.ok(!mainWire.includes("\u2028") && !mainWire.includes("\u2029"), "must escape JS line terminators");

  const inRenderer = renderer.reviveBridgePayload(JSON.parse(mainWire));
  assert.strictEqual(inRenderer.msgId, "7299999999999999999");
  assert.strictEqual(inRenderer.negBig, "-9007199254740993");
  assert.strictEqual(inRenderer.createdAt, isoDate);
  assert.ok(inRenderer.u8 instanceof Uint8Array);
  assert.deepStrictEqual(Array.from(inRenderer.u8), [1, 2, 3, 254, 255]);
  // Buffer.prototype.toJSON() yields { type: "Buffer", data: [...] } which renderer revives to Uint8Array
  assert.ok(inRenderer.buf instanceof Uint8Array);
  assert.deepStrictEqual(Array.from(inRenderer.buf), [10, 20, 30, 40]);
  assert.strictEqual(inRenderer.xss, "</script><img src=x>&\u2028\u2029");
  assert.strictEqual(inRenderer.voidMarker, undefined);
  assert.strictEqual(inRenderer.arr[1], undefined);
  assert.strictEqual(inRenderer.arr[2], "tail");
  assert.ok(inRenderer.maps instanceof Map);
  assert.strictEqual(inRenderer.maps.get(0), "/tmp/thumb_0.jpg");
  assert.strictEqual(inRenderer.maps.get(720), "/tmp/thumb_720.jpg");
  assert.ok(inRenderer.maps.get("nested") instanceof Map);
  assert.strictEqual(inRenderer.maps.get("nested").get(1), "one");
  assert.deepStrictEqual(Array.from(inRenderer.maps.get("nested").get("bytes")), [0, 127, 255]);
  assert.ok(inRenderer.maps.get("empty") instanceof Map);
  assert.strictEqual(inRenderer.maps.get("empty").size, 0);

  // Send back Renderer -> Main
  const rendererWire = renderer.serializeBridgeResult(inRenderer);
  const backInMain = primitives.reviveBridgePayload(JSON.parse(rendererWire));
  assert.strictEqual(backInMain.msgId, "7299999999999999999");
  assert.strictEqual(backInMain.negBig, "-9007199254740993");
  assert.strictEqual(backInMain.createdAt, isoDate);
  assert.ok(backInMain.u8 instanceof Uint8Array);
  assert.deepStrictEqual(Array.from(backInMain.u8), [1, 2, 3, 254, 255]);
  assert.ok(backInMain.buf instanceof Uint8Array);
  assert.deepStrictEqual(Array.from(backInMain.buf), [10, 20, 30, 40]);
  assert.strictEqual(backInMain.voidMarker, undefined);
  assert.strictEqual(backInMain.arr[1], undefined);
  assert.ok(backInMain.maps instanceof Map);
  assert.strictEqual(backInMain.maps.get(0), "/tmp/thumb_0.jpg");
  assert.strictEqual(backInMain.maps.get("nested").get(1), "one");
  assert.deepStrictEqual(Array.from(backInMain.maps.get("nested").get("bytes")), [0, 127, 255]);
});

test("Wire codec parity: Renderer -> Main -> Renderer roundtrip with undefined, Set, Buffer, Int16Array, Date", () => {
  const dt = new Date("2026-05-01T00:00:00.000Z");
  const subBytes = new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4); // [8, 7, 6]
  const rendererResult = {
    undefProp: undefined,
    fnProp: () => "ignored",
    symProp: Symbol("s"),
    arrWithUndef: [undefined, "x", undefined],
    mapWithUndef: new Map([
      ["k", undefined],
      [42, new Map([[99, Buffer.from([0xaa, 0xbb])]])],
    ]),
    setVal: new Set(["a", "b"]),
    sub: subBytes,
    big: 123456789012345678901234567890n,
    dt,
  };

  // Top-level undefined roundtrip
  const topVoidJson = renderer.serializeBridgeResult(undefined);
  assert.strictEqual(topVoidJson, '{"__rosmontisVoid__":true}');
  assert.strictEqual(primitives.reviveBridgePayload(JSON.parse(topVoidJson)), undefined);
  assert.strictEqual(renderer.reviveBridgePayload(JSON.parse(topVoidJson)), undefined);
  assert.strictEqual(primitives.serializeBridgePayload(undefined), "undefined");

  // Renderer -> Main
  const rJson = renderer.serializeBridgeResult(rendererResult);
  const inMain = primitives.reviveBridgePayload(JSON.parse(rJson));
  assert.strictEqual(inMain.undefProp, undefined);
  assert.strictEqual(inMain.fnProp, undefined);
  assert.strictEqual(inMain.symProp, undefined);
  assert.deepStrictEqual(inMain.arrWithUndef, [undefined, "x", undefined]);
  assert.ok(inMain.mapWithUndef instanceof Map);
  assert.strictEqual(inMain.mapWithUndef.has("k"), true);
  assert.strictEqual(inMain.mapWithUndef.get("k"), undefined);
  assert.ok(inMain.mapWithUndef.get(42) instanceof Map);
  assert.deepStrictEqual(Array.from(inMain.mapWithUndef.get(42).get(99)), [0xaa, 0xbb]);
  assert.deepStrictEqual(inMain.setVal, ["a", "b"]);
  assert.deepStrictEqual(Array.from(inMain.sub), [8, 7, 6]);
  assert.strictEqual(inMain.big, "123456789012345678901234567890");
  assert.strictEqual(inMain.dt, "2026-05-01T00:00:00.000Z");

  // Main -> Renderer
  const mJson = primitives.serializeBridgePayload(inMain);
  const backInRenderer = renderer.reviveBridgePayload(JSON.parse(mJson));
  assert.ok(backInRenderer.mapWithUndef instanceof Map);
  assert.deepStrictEqual(Array.from(backInRenderer.mapWithUndef.get(42).get(99)), [0xaa, 0xbb]);
  assert.deepStrictEqual(Array.from(backInRenderer.sub), [8, 7, 6]);
  assert.strictEqual(backInRenderer.big, "123456789012345678901234567890");
  assert.strictEqual(backInRenderer.dt, "2026-05-01T00:00:00.000Z");

  // Non-JSON structured-clone mode (`encodeBridgeMaps`) preserves Date and Uint8Array directly
  const structured = renderer.encodeBridgeMaps({
    dt,
    u8: new Uint8Array([3, 4]),
    m: new Map([[1, "v"]]),
    undef: undefined,
  });
  assert.ok(structured.dt instanceof Date);
  assert.strictEqual(structured.dt.toISOString(), dt.toISOString());
  assert.ok(structured.u8 instanceof Uint8Array);
  assert.deepStrictEqual(structured.m, { __rosmontisMap__: [[1, "v"]] });
  assert.strictEqual(structured.undef, undefined);

  // Legacy `__rosmontisBytes__` tag revived by renderer
  const legacyBytes = renderer.reviveBridgePayload({ __rosmontisBytes__: [7, 8, 9] });
  assert.ok(legacyBytes instanceof Uint8Array);
  assert.deepStrictEqual(Array.from(legacyBytes), [7, 8, 9]);
});

test("Wire codec parity: circular references, __proto__ pollution defense, and KNOWN_MAP_FIELDS", () => {
  // 1. Circular references
  const cyclic = { name: "root", child: {} };
  cyclic.child.back = cyclic;
  cyclic.self = cyclic;

  const encodedCyclic = renderer.encodeBridgeMaps(cyclic);
  assert.strictEqual(encodedCyclic.name, "root");
  assert.strictEqual(encodedCyclic.self, null);
  assert.strictEqual(encodedCyclic.child.back, null);

  const cyclicJson = renderer.serializeBridgeResult(cyclic);
  const revivedCyclicMain = primitives.reviveBridgePayload(JSON.parse(cyclicJson));
  assert.strictEqual(revivedCyclicMain.name, "root");
  assert.strictEqual(revivedCyclicMain.self, null);
  assert.strictEqual(revivedCyclicMain.child.back, null);

  // Renderer reviveBridgePayload also handles in-memory cyclic objects without stack overflow
  const inMemCyclic = { tag: "loop" };
  inMemCyclic.self = inMemCyclic;
  const revivedInMem = renderer.reviveBridgePayload(inMemCyclic);
  assert.strictEqual(revivedInMem.tag, "loop");
  assert.strictEqual(revivedInMem.self, inMemCyclic);

  // primitives.serializeBridgePayload delegates to JSON.stringify and rejects cycles cleanly
  assert.throws(() => primitives.serializeBridgePayload(cyclic), TypeError);

  // 2. __proto__ own-property pollution defense
  const maliciousJson = '{"safe":1,"__proto__":{"polluted":"yes","nested":{"__rosmontisMap__":[[1,"ok"]]}}}';
  const parsedMalicious = JSON.parse(maliciousJson);

  const mainSafe = primitives.reviveBridgePayload(parsedMalicious);
  assert.strictEqual(({}).polluted, undefined, "Object.prototype must never be polluted by primitives.reviveBridgePayload");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(mainSafe, "__proto__"), true);
  assert.strictEqual(mainSafe.__proto__.polluted, "yes");
  assert.ok(mainSafe.__proto__.nested instanceof Map);
  assert.strictEqual(mainSafe.__proto__.nested.get(1), "ok");

  const rendererSafe = renderer.reviveBridgePayload(parsedMalicious);
  assert.strictEqual(({}).polluted, undefined, "Object.prototype must never be polluted by renderer.reviveBridgePayload");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(rendererSafe, "__proto__"), true);
  assert.strictEqual(rendererSafe.__proto__.polluted, "yes");
  assert.ok(rendererSafe.__proto__.nested instanceof Map);
  assert.strictEqual(rendererSafe.__proto__.nested.get(1), "ok");

  const encodedProto = renderer.encodeBridgeMaps(rendererSafe);
  assert.strictEqual(({}).polluted, undefined, "Object.prototype must never be polluted by renderer.encodeBridgeMaps");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(encodedProto, "__proto__"), true);

  // 3. KNOWN_MAP_FIELDS (`msgAttributeInfos`, `thumbPath`, `picThumbPath`)
  assert.deepStrictEqual(
    Array.from(renderer.KNOWN_MAP_FIELDS).sort(),
    ["msgAttributeInfos", "picThumbPath", "thumbPath"]
  );

  const ntRaw = {
    msgAttributeInfos: { "100": { attr: "keep-string-key" }, custom: { attr: "str" } },
    picElement: {
      thumbPath: { "0": "/cache/thumb0.jpg", "720": "/cache/thumb720.jpg", orig: "/cache/orig.jpg" },
    },
    fileElement: {
      picThumbPath: { "1": "/cache/file_thumb.jpg" },
    },
  };
  const revivedKnown = renderer.reviveBridgePayload(ntRaw);
  assert.ok(revivedKnown.msgAttributeInfos instanceof Map);
  assert.strictEqual(revivedKnown.msgAttributeInfos.has("100"), true);
  assert.strictEqual(revivedKnown.msgAttributeInfos.has(100), false, "msgAttributeInfos must preserve string keys");
  assert.deepStrictEqual(revivedKnown.msgAttributeInfos.get("100"), { attr: "keep-string-key" });

  assert.ok(revivedKnown.picElement.thumbPath instanceof Map);
  assert.strictEqual(revivedKnown.picElement.thumbPath.get(0), "/cache/thumb0.jpg");
  assert.strictEqual(revivedKnown.picElement.thumbPath.get(720), "/cache/thumb720.jpg");
  assert.strictEqual(revivedKnown.picElement.thumbPath.get("orig"), "/cache/orig.jpg");

  assert.ok(revivedKnown.fileElement.picThumbPath instanceof Map);
  assert.strictEqual(revivedKnown.fileElement.picThumbPath.get(1), "/cache/file_thumb.jpg");
});

// ============================================================================
// 2. Decomposed Modules & Facade Compatibility Verification
// ============================================================================

test("Split core modules (image_probe, ntqq_meta, media_downloader, media_security) preserve exact API & facade parity", async () => {
  // Facade identity parity across media_security.js, bridge_onebot.js, and leaf modules
  assert.strictEqual(mediaSecurity.inspectImageDimensions, imageProbe.inspectImageDimensions);
  assert.strictEqual(onebotFacade.inspectImageDimensions, imageProbe.inspectImageDimensions);

  assert.strictEqual(mediaSecurity.getNtqqVersionMetadata, ntqqMeta.getNtqqVersionMetadata);
  assert.strictEqual(mediaSecurity.buildNtqqUserAgent, ntqqMeta.buildNtqqUserAgent);
  assert.strictEqual(onebotFacade.getNtqqVersionMetadata, ntqqMeta.getNtqqVersionMetadata);
  assert.strictEqual(onebotFacade.buildNtqqUserAgent, ntqqMeta.buildNtqqUserAgent);

  assert.strictEqual(mediaSecurity.DEFAULT_MAX_MEDIA_BYTES, mediaDownloader.DEFAULT_MAX_MEDIA_BYTES);
  assert.strictEqual(mediaSecurity.resolveMaxMediaBytes, mediaDownloader.resolveMaxMediaBytes);
  assert.strictEqual(mediaSecurity.pruneTempDir, mediaDownloader.pruneTempDir);
  assert.strictEqual(mediaSecurity.pruneTempDirAsync, mediaDownloader.pruneTempDirAsync);
  assert.strictEqual(mediaSecurity.writeTempMediaAtomically, mediaDownloader.writeTempMediaAtomically);
  assert.strictEqual(mediaSecurity.downloadBufferFromUrl, mediaDownloader.downloadBufferFromUrl);
  assert.strictEqual(mediaSecurity.downloadMediaStreamToTempDir, mediaDownloader.downloadMediaStreamToTempDir);

  assert.strictEqual(onebotFacade.DEFAULT_MAX_MEDIA_BYTES, mediaDownloader.DEFAULT_MAX_MEDIA_BYTES);
  assert.strictEqual(onebotFacade.resolveMaxMediaBytes, mediaDownloader.resolveMaxMediaBytes);
  assert.strictEqual(onebotFacade.pruneTempDir, mediaDownloader.pruneTempDir);
  assert.strictEqual(onebotFacade.pruneTempDirAsync, mediaDownloader.pruneTempDirAsync);
  assert.strictEqual(onebotFacade.downloadBufferFromUrl, mediaDownloader.downloadBufferFromUrl);
  assert.strictEqual(onebotFacade.downloadMediaStreamToTempDir, mediaDownloader.downloadMediaStreamToTempDir);
  assert.strictEqual(onebotFacade.isPrivateOrReservedIp, mediaSecurity.isPrivateOrReservedIp);
  assert.strictEqual(onebotFacade.createSsrfSafeLookup, mediaSecurity.createSsrfSafeLookup);
  assert.strictEqual(onebotFacade.resolveMediaSource, mediaSecurity.resolveMediaSource);

  // image_probe.js format checks (PNG, GIF, WebP VP8L/VP8X, JPEG SOF0, fallback)
  const pngBuf = Buffer.alloc(24);
  pngBuf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  pngBuf.writeUInt32BE(320, 16);
  pngBuf.writeUInt32BE(240, 20);
  assert.deepStrictEqual(imageProbe.inspectImageDimensions(pngBuf), {
    width: 320,
    height: 240,
    isGif: false,
    ext: ".png",
  });

  const gifBuf = Buffer.alloc(24);
  gifBuf.write("GIF89a", 0, "ascii");
  gifBuf.writeUInt16LE(128, 6);
  gifBuf.writeUInt16LE(96, 8);
  assert.deepStrictEqual(imageProbe.inspectImageDimensions(gifBuf), {
    width: 128,
    height: 96,
    isGif: true,
    ext: ".gif",
  });

  const webpVp8x = Buffer.alloc(30);
  webpVp8x.write("RIFF", 0, "ascii");
  webpVp8x.write("WEBP", 8, "ascii");
  webpVp8x.write("VP8X", 12, "ascii");
  webpVp8x.writeUIntLE(640 - 1, 24, 3);
  webpVp8x.writeUIntLE(480 - 1, 27, 3);
  assert.deepStrictEqual(imageProbe.inspectImageDimensions(webpVp8x), {
    width: 640,
    height: 480,
    isGif: false,
    ext: ".webp",
  });

  const jpegBuf = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 len=4
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, // SOF0 height=480, width=640
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  assert.deepStrictEqual(imageProbe.inspectImageDimensions(jpegBuf), {
    width: 640,
    height: 480,
    isGif: false,
    ext: ".jpg",
  });

  assert.deepStrictEqual(imageProbe.inspectImageDimensions(Buffer.from("tiny")), {
    width: 512,
    height: 512,
    isGif: false,
    ext: ".jpg",
  });

  // ntqq_meta.js checks
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rosmontis-split-test-"));
  try {
    const fakePkg = path.join(tmpDir, "package.json");
    fs.writeFileSync(fakePkg, JSON.stringify({ version: "3.2.99-77777", buildVersion: "77777" }));
    const meta = ntqqMeta.getNtqqVersionMetadata({
      packagePaths: [fakePkg],
      chromeVersion: "140.0.1.2",
    });
    assert.strictEqual(meta.qqVersion, "3.2.99-77777");
    assert.strictEqual(meta.buildVersion, "77777");
    assert.strictEqual(meta.chromeVersion, "140.0.1.2");
    assert.ok(meta.userAgent.includes("Chrome/140.0.1.2"));
    assert.ok(meta.userAgent.includes("QQ/3.2.99-77777"));
    assert.strictEqual(
      ntqqMeta.buildNtqqUserAgent({ packagePaths: [fakePkg], chromeVersion: "140.0.1.2" }),
      meta.userAgent
    );

    // media_downloader.js: atomic write, pruning, and SSRF-checked local HTTP download
    const atomicTarget = path.join(tmpDir, "atomic.png");
    await mediaDownloader.writeTempMediaAtomically(atomicTarget, pngBuf, true);
    assert.deepStrictEqual(fs.readFileSync(atomicTarget), pngBuf);

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(pngBuf.length) });
      res.end(pngBuf);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/sample.png`;

    try {
      await assert.rejects(
        () => mediaDownloader.downloadBufferFromUrl(url, { allowPrivateUrls: false }),
        (err) => err && err.code === "ERR_SSRF_BLOCKED"
      );
      const downloadedBuf = await mediaDownloader.downloadBufferFromUrl(url, { allowPrivateUrls: true });
      assert.deepStrictEqual(downloadedBuf, pngBuf);

      const streamed = await mediaDownloader.downloadMediaStreamToTempDir(url, tmpDir, {
        allowPrivateUrls: true,
      });
      assert.strictEqual(streamed.width, 320);
      assert.strictEqual(streamed.height, 240);
      assert.strictEqual(streamed.fileSize, pngBuf.length);
      assert.ok(fs.existsSync(streamed.localPath));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Load-order independence: requiring media_downloader.js BEFORE media_security.js has zero circular require bugs", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const script = `
    const assert = require("assert");
    const dl = require("./src/core/media_downloader");
    const sec = require("./src/core/media_security");
    assert.strictEqual(typeof dl.downloadBufferFromUrl, "function");
    assert.strictEqual(typeof dl.downloadMediaStreamToTempDir, "function");
    assert.strictEqual(typeof sec.isPrivateOrReservedIp, "function");
    assert.strictEqual(typeof sec.createSsrfSafeLookup, "function");
    assert.strictEqual(sec.downloadBufferFromUrl, dl.downloadBufferFromUrl);
    assert.strictEqual(sec.DEFAULT_MAX_MEDIA_BYTES, dl.DEFAULT_MAX_MEDIA_BYTES);
    assert.strictEqual(sec.isPrivateOrReservedIp("127.0.0.1"), true);
    dl.downloadBufferFromUrl("http://127.0.0.1:1/test", { allowPrivateUrls: false }).then(
      () => process.exit(2),
      (err) => {
        assert.strictEqual(err.code, "ERR_SSRF_BLOCKED");
        process.exit(0);
      }
    );
  `;
  const res = spawnSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.strictEqual(res.status, 0, `Load-order check failed: ${res.stderr || res.stdout}`);
});

test("Domain cleanup: buildNtMarketFaceUrl & stripTransientNtMedia live in segment_converter.js (not stores.js) and bridge_onebot.js preserves parity", () => {
  // Ownership in segment_converter.js
  assert.strictEqual(typeof segmentConverter.buildNtMarketFaceUrl, "function");
  assert.strictEqual(typeof segmentConverter.stripTransientNtMedia, "function");

  // Facade parity in bridge_onebot.js
  assert.strictEqual(onebotFacade.buildNtMarketFaceUrl, segmentConverter.buildNtMarketFaceUrl);
  assert.strictEqual(onebotFacade.stripTransientNtMedia, segmentConverter.stripTransientNtMedia);

  // stores.js no longer owns or exports these media-converter helpers
  assert.strictEqual(Object.prototype.hasOwnProperty.call(storesMod, "buildNtMarketFaceUrl"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(storesMod, "stripTransientNtMedia"), false);

  // Functional checks on buildNtMarketFaceUrl & stripTransientNtMedia
  assert.strictEqual(
    segmentConverter.buildNtMarketFaceUrl("abcdef0123456789"),
    "https://gxh.vip.qq.com/club/item/parcel/item/ab/abcdef0123456789/raw300.gif"
  );
  assert.strictEqual(
    segmentConverter.buildNtMarketFaceUrl({ emojiId: "12345678" }),
    "https://gxh.vip.qq.com/club/item/parcel/item/12/12345678/raw300.gif"
  );

  const rawMsg = {
    msgId: "777001",
    chatType: 2,
    peerUid: "123456",
    elements: [
      {
        elementType: 2,
        picElement: { md5HexStr: "aaa", __base64Uri: "base64://Zm9v" },
      },
      {
        elementType: 4,
        pttElement: { md5HexStr: "bbb", __base64Uri: "base64://YmFy" },
      },
      {
        elementType: 11,
        marketFaceElement: { emojiId: "deadbeef1234" },
      },
    ],
  };
  segmentConverter.stripTransientNtMedia(rawMsg);
  assert.strictEqual(rawMsg.elements[0].picElement.__base64Uri, undefined);
  assert.strictEqual(rawMsg.elements[1].pttElement.__base64Uri, undefined);

  // MessageIdStore.indexMsgMedia still resolves marketFaceElement URLs cleanly via segment_converter.js
  const store = new storesMod.MessageIdStore(32);
  store.indexMsgMedia(rawMsg, 42);
  const indexedMf = store.lookupMedia("deadbeef1234");
  assert.ok(indexedMf);
  assert.strictEqual(
    indexedMf.url,
    "https://gxh.vip.qq.com/club/item/parcel/item/de/deadbeef1234/raw300.gif"
  );
});
