"use strict";

const assert = require("assert");
const crypto = require("crypto");
const dns = require("dns");
const EventEmitter = require("events");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const onebot = require("../src/bridge_onebot.js");

const ONE_BY_ONE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const ONE_BY_ONE_PNG_BUF = Buffer.from(ONE_BY_ONE_PNG_B64, "base64");

async function runMediaSecurityTests() {
  let passed = 0;
  async function check(name, fn) {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  }

  console.log("=== Media Security, 256MiB Quota, LFI Boundary & Async Concurrency Tests ===");

  await check("DEFAULT_MAX_MEDIA_BYTES equals 256 MiB (268,435,456 bytes) and isPrivateOrReservedIp classifies IPv4/IPv6 accurately", () => {
    assert.strictEqual(onebot.DEFAULT_MAX_MEDIA_BYTES, 256 * 1024 * 1024);
    assert.strictEqual(onebot.DEFAULT_MAX_MEDIA_BYTES, 268435456);

    const blockedIps = [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.254",
      "100.64.0.1",
      "100.127.255.254",
      "127.0.0.1",
      "127.0.53.53",
      "169.254.169.254",
      "169.254.0.1",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.0.1",
      "192.168.255.254",
      "224.0.0.1",
      "239.255.255.250",
      "255.255.255.255",
      "::",
      "::1",
      "[::1]",
      "fe80::1",
      "febf::abcd",
      "fc00::1",
      "fd12:3456:789a::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "::ffff:10.0.0.8",
      "::ffff:192.168.1.10",
    ];
    for (const ip of blockedIps) {
      assert.strictEqual(
        onebot.isPrivateOrReservedIp(ip),
        true,
        `Expected ${ip} to be classified as private/reserved`
      );
    }

    const publicIps = [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "100.63.255.254",
      "100.128.0.1",
      "172.15.255.254",
      "172.32.0.1",
      "192.169.0.1",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "::ffff:0808:0808",
    ];
    for (const ip of publicIps) {
      assert.strictEqual(
        onebot.isPrivateOrReservedIp(ip),
        false,
        `Expected ${ip} to be classified as public`
      );
    }
  });

  await check("SSRF guard blocks loopback, metadata IP, IPv6 ::1, 302 redirect to 127.0.0.1, and DNS rebinding; allows opt-in allowPrivateUrls", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_ssrf_test_"));
    let okHits = 0;
    const srv = http.createServer((req, res) => {
      if (req.url === "/ok.png") {
        okHits += 1;
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(ONE_BY_ONE_PNG_BUF.length),
        });
        res.end(ONE_BY_ONE_PNG_BUF);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });

    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;

    try {
      // 1. Direct literal private/reserved IPs blocked before socket connection
      await assert.rejects(
        () => onebot.resolveMediaSource(`http://127.0.0.1:${port}/ok.png`, { tempDir: tmpDir }),
        (err) => err && (err.code === "ERR_SSRF_BLOCKED" || /Blocked private/i.test(err.message))
      );
      assert.strictEqual(okHits, 0, "Loopback HTTP server must not receive SSRF request");

      await assert.rejects(
        () => onebot.resolveMediaSource("http://169.254.169.254/latest/meta-data/", { tempDir: tmpDir }),
        (err) => err && (err.code === "ERR_SSRF_BLOCKED" || /Blocked private/i.test(err.message))
      );

      await assert.rejects(
        () => onebot.resolveMediaSource(`http://[::1]:${port}/ok.png`, { tempDir: tmpDir }),
        (err) => err && (err.code === "ERR_SSRF_BLOCKED" || /Blocked private/i.test(err.message))
      );

      await assert.rejects(
        () => onebot.resolveMediaSource(`http://[::ffff:127.0.0.1]:${port}/ok.png`, { tempDir: tmpDir }),
        (err) => err && (err.code === "ERR_SSRF_BLOCKED" || /Blocked private/i.test(err.message))
      );

      // 2. Public URL 302 redirecting to 127.0.0.1 is intercepted on redirect hop
      const origHttpGet = http.get;
      http.get = function mockedHttpGet(urlOrOpts, optsOrCb, maybeCb) {
        const urlStr = typeof urlOrOpts === "string" ? urlOrOpts : String(urlOrOpts?.href || "");
        const cb = typeof optsOrCb === "function" ? optsOrCb : maybeCb;
        if (urlStr.startsWith("http://public-cdn.example.com/redirect-ssrf")) {
          const fakeReq = new EventEmitter();
          fakeReq.destroy = () => {};
          process.nextTick(() => {
            const fakeRes = new EventEmitter();
            fakeRes.statusCode = 302;
            fakeRes.headers = { location: `http://127.0.0.1:${port}/ok.png` };
            fakeRes.resume = () => {};
            fakeRes.destroy = () => {};
            cb(fakeRes);
          });
          return fakeReq;
        }
        return origHttpGet.apply(this, arguments);
      };
      try {
        await assert.rejects(
          () =>
            onebot.resolveMediaSource("http://public-cdn.example.com/redirect-ssrf", {
              tempDir: tmpDir,
            }),
          (err) => err && (err.code === "ERR_SSRF_BLOCKED" || /Blocked private/i.test(err.message))
        );
        assert.strictEqual(okHits, 0, "302 redirect target on 127.0.0.1 must not be contacted");
      } finally {
        http.get = origHttpGet;
      }

      // 3. Domain name resolving to private IP (DNS Rebinding) is blocked in both single & { all: true } lookup modes
      const origDnsLookup = dns.lookup;
      dns.lookup = function mockedDnsLookup(hostname, opts, callback) {
        const cb = typeof opts === "function" ? opts : callback;
        const wantAll = Boolean(opts && typeof opts === "object" && opts.all === true);
        if (hostname === "rebind-loopback.example.com") {
          return process.nextTick(() =>
            wantAll ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)
          );
        }
        if (hostname === "rebind-meta.example.com") {
          return process.nextTick(() =>
            wantAll
              ? cb(null, [{ address: "169.254.169.254", family: 4 }])
              : cb(null, "169.254.169.254", 4)
          );
        }
        return origDnsLookup.apply(this, arguments);
      };
      try {
        await assert.rejects(
          () =>
            onebot.resolveMediaSource(`http://rebind-loopback.example.com:${port}/ok.png`, {
              tempDir: tmpDir,
            }),
          (err) => err && (err.code === "ERR_SSRF_BLOCKED" || /Blocked DNS resolution/i.test(err.message))
        );
        await assert.rejects(
          () =>
            onebot.resolveMediaSource("http://rebind-meta.example.com/latest/meta-data/", {
              tempDir: tmpDir,
            }),
          (err) => err && (err.code === "ERR_SSRF_BLOCKED" || /Blocked DNS resolution/i.test(err.message))
        );
        assert.strictEqual(okHits, 0, "DNS rebinding to 127.0.0.1 must be aborted before TCP connect");
      } finally {
        dns.lookup = origDnsLookup;
      }

      // 4. Explicit opt-in allowPrivateUrls: true downloads normally from local mock HTTP server
      const media = await onebot.resolveMediaSource(`http://127.0.0.1:${port}/ok.png`, {
        tempDir: tmpDir,
        allowPrivateUrls: true,
      });
      assert.strictEqual(okHits, 1);
      assert.strictEqual(media.fileSize, ONE_BY_ONE_PNG_BUF.length);
      assert.strictEqual(media.width, 1);
      assert.strictEqual(media.height, 1);
      assert.strictEqual(media.isTempFile, true);
      assert.ok(fs.existsSync(media.localPath));
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await check("256MiB quota enforcement aborts Content-Length, chunked stream, and oversized base64:// at maxMediaBytes: 1024", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_quota_test_"));
    let streamChunksSent = 0;

    const srv = http.createServer((req, res) => {
      if (req.url === "/oversize-header") {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": "4096",
        });
        res.end(Buffer.alloc(4096, 0x41));
        return;
      }
      if (req.url === "/oversize-chunked") {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Transfer-Encoding": "chunked",
        });
        const sendNext = () => {
          if (res.destroyed || streamChunksSent >= 20) {
            if (!res.destroyed) res.end();
            return;
          }
          streamChunksSent += 1;
          res.write(Buffer.alloc(512, 0x42), () => {
            setTimeout(sendNext, 10);
          });
        };
        sendNext();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = srv.address().port;

    try {
      // 1. Content-Length > 1024 rejected immediately
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(`http://127.0.0.1:${port}/oversize-header`, {
            tempDir: tmpDir,
            allowPrivateUrls: true,
            maxMediaBytes: 1024,
          }),
        (err) => err && (err.code === "ERR_MEDIA_TOO_LARGE" || /exceeds maximum limit/i.test(err.message))
      );

      // 2. Chunked stream without Content-Length aborted mid-stream once > 1024 bytes
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(`http://127.0.0.1:${port}/oversize-chunked`, {
            tempDir: tmpDir,
            allowPrivateUrls: true,
            maxMediaBytes: 1024,
          }),
        (err) => err && (err.code === "ERR_MEDIA_TOO_LARGE" || /exceeds maximum limit/i.test(err.message))
      );
      assert.ok(
        streamChunksSent >= 3 && streamChunksSent < 20,
        `Expected chunked stream to abort early after exceeding 1KB, sent ${streamChunksSent} chunks`
      );

      // 3. Oversized base64:// & data:...;base64, rejected pre-allocation; exact 1024-byte boundary succeeds
      const oversizeB64 = Buffer.alloc(2048, 0x5a).toString("base64");
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(`base64://${oversizeB64}`, {
            tempDir: tmpDir,
            maxMediaBytes: 1024,
          }),
        (err) => err && (err.code === "ERR_MEDIA_TOO_LARGE" || /exceeds maximum limit/i.test(err.message))
      );
      await assert.rejects(
        () =>
          onebot.resolveMediaSource(`data:application/octet-stream;base64,${oversizeB64}`, {
            tempDir: tmpDir,
            maxMediaBytes: 1024,
          }),
        (err) => err && (err.code === "ERR_MEDIA_TOO_LARGE" || /exceeds maximum limit/i.test(err.message))
      );

      const exact1KbBuf = Buffer.alloc(1024, 0x33);
      const exactMedia = await onebot.resolveMediaSource(`base64://${exact1KbBuf.toString("base64")}`, {
        tempDir: tmpDir,
        maxMediaBytes: 1024,
      });
      assert.strictEqual(exactMedia.fileSize, 1024);
    } finally {
      await new Promise((resolve) => srv.close(resolve));
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  await check("LFI path boundary allows tempDir & os.tmpdir(), and blocks outside paths, outside symlinks, and ROSMONTIS_CONFIG_DIR/onebot.json", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_lfi_tmp_"));
    const osTmpSubDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_lfi_ostmp_"));
    // Place config dir inside os.tmpdir() to prove explicit blacklist overrides parent whitelist
    const cfgDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_lfi_cfg_"));
    // Place an outside directory inside the project test folder (outside tempDir / os.tmpdir() / ~/.config/QQ)
    const outsideDir = await fs.promises.mkdtemp(path.join(__dirname, ".tmp_outside_lfi_"));

    const savedCfgEnv = process.env.ROSMONTIS_CONFIG_DIR;
    process.env.ROSMONTIS_CONFIG_DIR = cfgDir;

    try {
      const allowedInTemp = path.join(tmpDir, "valid_temp.png");
      const allowedInOsTmp = path.join(osTmpSubDir, "valid_ostmp.png");
      const secretCfgFile = path.join(cfgDir, "onebot.json");
      const outsideSecretFile = path.join(outsideDir, "outside_secret.png");

      await fs.promises.writeFile(allowedInTemp, ONE_BY_ONE_PNG_BUF);
      await fs.promises.writeFile(allowedInOsTmp, ONE_BY_ONE_PNG_BUF);
      await fs.promises.writeFile(secretCfgFile, '{"accessToken":"super_secret_token"}', "utf8");
      await fs.promises.writeFile(outsideSecretFile, ONE_BY_ONE_PNG_BUF);

      // 1. Reading from tempDir & os.tmpdir() succeeds (both direct path & file:// URL)
      const m1 = await onebot.resolveMediaSource(allowedInTemp, { tempDir: tmpDir });
      assert.strictEqual(m1.fileSize, ONE_BY_ONE_PNG_BUF.length);
      assert.strictEqual(m1.isTempFile, false);

      const m2 = await onebot.resolveMediaSource(pathToFileURL(allowedInOsTmp).toString(), {
        tempDir: tmpDir,
      });
      assert.strictEqual(m2.fileSize, ONE_BY_ONE_PNG_BUF.length);

      // 2. Reading outside whitelist is rejected
      await assert.rejects(
        () => onebot.resolveMediaSource(outsideSecretFile, { tempDir: tmpDir }),
        (err) => err && (err.code === "ERR_LFI_BLOCKED" || /outside allowed directories/i.test(err.message))
      );

      // 3. Symlink/junction inside whitelisted tempDir pointing outside whitelist is rejected via realpath
      const symlinkDir = path.join(tmpDir, "escaped_dir_link");
      await fs.promises.symlink(
        outsideDir,
        symlinkDir,
        process.platform === "win32" ? "junction" : "dir"
      );
      await assert.rejects(
        () => onebot.resolveMediaSource(path.join(symlinkDir, "outside_secret.png"), { tempDir: tmpDir }),
        (err) => err && (err.code === "ERR_LFI_BLOCKED" || /outside allowed directories/i.test(err.message))
      );

      // Also test direct file symlink if supported by host OS privileges
      const symlinkFile = path.join(tmpDir, "escaped_file_link.png");
      let fileSymlinkCreated = false;
      try {
        await fs.promises.symlink(outsideSecretFile, symlinkFile, "file");
        fileSymlinkCreated = true;
      } catch (_) {}
      if (fileSymlinkCreated) {
        await assert.rejects(
          () => onebot.resolveMediaSource(symlinkFile, { tempDir: tmpDir }),
          (err) => err && (err.code === "ERR_LFI_BLOCKED" || /outside allowed directories/i.test(err.message))
        );
      }

      // 4. Reading ROSMONTIS_CONFIG_DIR/onebot.json is strictly blocked even though parent is os.tmpdir()
      await assert.rejects(
        () => onebot.resolveMediaSource(secretCfgFile, { tempDir: tmpDir }),
        (err) => err && (err.code === "ERR_LFI_BLOCKED" || /restricted local path/i.test(err.message))
      );

      // 5. Reading /etc/passwd is strictly blocked
      await assert.rejects(
        () => onebot.resolveMediaSource("/etc/passwd", { tempDir: tmpDir }),
        (err) => err && (err.code === "ERR_LFI_BLOCKED" || /restricted local path/i.test(err.message))
      );
    } finally {
      if (savedCfgEnv === undefined) delete process.env.ROSMONTIS_CONFIG_DIR;
      else process.env.ROSMONTIS_CONFIG_DIR = savedCfgEnv;
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
      await fs.promises.rm(osTmpSubDir, { recursive: true, force: true });
      await fs.promises.rm(cfgDir, { recursive: true, force: true });
      await fs.promises.rm(outsideDir, { recursive: true, force: true });
    }
  });

  await check("20x Promise.all concurrent resolveMediaSource writes (identical + distinct base64://) complete intact without race corruption", async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "rosmontis_concurrency_test_"));
    try {
      const payloads = [];
      // 10 identical PNG payloads racing on the exact same target filename
      for (let i = 0; i < 10; i++) {
        payloads.push(ONE_BY_ONE_PNG_BUF);
      }
      // 10 distinct payloads with PNG header + unique trailing chunks
      for (let i = 0; i < 10; i++) {
        payloads.push(Buffer.concat([ONE_BY_ONE_PNG_BUF, Buffer.from(`unique-tail-${i}-${"x".repeat(256)}`)]));
      }

      const results = await Promise.all(
        payloads.map((buf) =>
          onebot.resolveMediaSource(`base64://${buf.toString("base64")}`, {
            tempDir: tmpDir,
          })
        )
      );

      assert.strictEqual(results.length, 20);
      for (let i = 0; i < 20; i++) {
        const expectedBuf = payloads[i];
        const expectedMd5 = crypto.createHash("md5").update(expectedBuf).digest("hex");
        const media = results[i];
        assert.strictEqual(media.md5HexStr, expectedMd5);
        assert.strictEqual(media.fileSize, expectedBuf.length);

        const diskBytes = await fs.promises.readFile(media.localPath);
        const diskMd5 = crypto.createHash("md5").update(diskBytes).digest("hex");
        assert.strictEqual(diskBytes.length, expectedBuf.length);
        assert.strictEqual(diskMd5, expectedMd5);
        assert.ok(diskBytes.equals(expectedBuf));
      }

      const remainingNames = await fs.promises.readdir(tmpDir);
      assert.strictEqual(
        remainingNames.filter((n) => n.endsWith(".part")).length,
        0,
        "No temporary .part files may remain after concurrent writes"
      );
      // 1 shared file + 10 distinct files = 11 unique files
      assert.strictEqual(remainingNames.length, 11);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  console.log(`\nALL ${passed} MEDIA SECURITY TEST SUITES PASSED SUCCESSFULLY!`);
}

runMediaSecurityTests().catch((err) => {
  console.error("Media security test suite failed:", err);
  process.exit(1);
});
