"use strict";

const { execFileSync } = require("child_process");

const container = process.env.CONTAINER_NAME || "rosmontis-canary";
const token = process.env.CANARY_TOKEN || "";
const baseUrl = `http://127.0.0.1:${process.env.HTTP_PORT || "3000"}`;

if (!token) {
  throw new Error("CANARY_TOKEN is not set");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sanitize(text) {
  return String(text).split(token).join("[REDACTED]");
}

function assertContainerRunning() {
  const running = execFileSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", container],
    { encoding: "utf8" }
  ).trim();
  if (running !== "true") {
    throw new Error(`Container ${container} is not running (State.Running=${running})`);
  }
}

async function requestJson(method, reqPath, body = undefined) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${reqPath}`, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}
  return { status: res.status, text, json };
}

(async () => {
  // 1. Poll /health up to 90s
  const healthDeadline = Date.now() + 90_000;
  let healthOk = false;
  let lastHealthErr = "";
  while (Date.now() < healthDeadline) {
    assertContainerRunning();
    try {
      const res = await requestJson("GET", "/health");
      if (res.status === 200 && res.json && res.json.retcode === 0 && res.json.status === "ok") {
        console.log("Health check passed:", sanitize(JSON.stringify(res.json)));
        healthOk = true;
        break;
      }
      lastHealthErr = `HTTP ${res.status}: ${sanitize(res.text)}`;
    } catch (err) {
      lastHealthErr = err.message || String(err);
    }
    await sleep(2000);
  }
  if (!healthOk) {
    throw new Error(`Timed out waiting for /health after 90s (last error: ${lastHealthErr})`);
  }

  // 2. Verify pure-JS bridge invariants inside container
  const containerCheck = execFileSync(
    "docker",
    [
      "exec",
      container,
      "bash",
      "-euo",
      "pipefail",
      "-c",
      [
        'if [ -n "${LD_PRELOAD:-}" ]; then echo "LD_PRELOAD set in container env: ${LD_PRELOAD}" >&2; exit 1; fi',
        'qq_pid="$(pgrep -f "/opt/QQ/qq" | head -n 1 || true)"',
        'if [ -z "${qq_pid}" ]; then echo "QQ process (/opt/QQ/qq) not found" >&2; exit 1; fi',
        'proc_preload="$(tr "\\0" "\\n" < "/proc/${qq_pid}/environ" | grep "^LD_PRELOAD=" || true)"',
        'if [ -n "${proc_preload#LD_PRELOAD=}" ]; then echo "LD_PRELOAD active on QQ PID ${qq_pid}: ${proc_preload}" >&2; exit 1; fi',
        "test -f /opt/QQ/resources/app/app_launcher/bridge_main.js",
        'grep -q "bridge_main.js" /opt/QQ/resources/app/app_launcher/index.js',
        'node -e \'const p=require("/opt/QQ/resources/app/package.json"); if(p.main!=="./app_launcher/index.js") process.exit(1);\'',
        "test -d /app/data/state",
        'owner="$(stat -c "%u:%g" /app/data/state)"',
        'if [ "${owner}" != "1000:1000" ]; then echo "Unexpected /app/data/state owner: ${owner}" >&2; exit 1; fi',
        'qq_ver="$(node -e \'console.log(require("/opt/QQ/resources/app/package.json").version || "unknown")\' 2>/dev/null || echo unknown)"',
        'echo "Verified pure-JS invariants: QQ version=${qq_ver}, PID=${qq_pid}, LD_PRELOAD unset/empty, bridge_main.js active, /app/data/state owner=${owner}"',
      ].join("; "),
    ],
    { encoding: "utf8" }
  );
  console.log(sanitize(containerCheck.trim()));

  // 3. Query POST /get_status and assert telemetry structure
  const initialStatus = await requestJson("POST", "/get_status", {});
  if (initialStatus.status !== 200 || !initialStatus.json || initialStatus.json.retcode !== 0) {
    throw new Error(`Initial /get_status failed: HTTP ${initialStatus.status} ${sanitize(initialStatus.text)}`);
  }
  const initialBridge = initialStatus.json.data && initialStatus.json.data.bridge;
  if (!initialBridge || typeof initialBridge !== "object") {
    throw new Error(`Missing data.bridge telemetry in /get_status: ${sanitize(initialStatus.text)}`);
  }
  if (!Array.isArray(initialBridge.listenErrors) || initialBridge.listenErrors.length > 0) {
    throw new Error(`Non-empty listenErrors in /get_status: ${sanitize(JSON.stringify(initialBridge.listenErrors))}`);
  }
  if (typeof initialBridge.map_hook_active !== "boolean") {
    throw new Error(`Invalid bridge.map_hook_active: ${sanitize(JSON.stringify(initialBridge))}`);
  }
  console.log("Initial /get_status telemetry:", sanitize(JSON.stringify(initialStatus.json, null, 2)));

  // 4. Query POST /get_login_qrcode with {"refresh":true} (retry while Electron login UI initializes)
  const qrDeadline = Date.now() + 45_000;
  let qrFetched = false;
  let lastQrSummary = "";
  while (Date.now() < qrDeadline) {
    assertContainerRunning();
    const qrRes = await requestJson("POST", "/get_login_qrcode", { refresh: true });
    if (qrRes.status !== 200 || !qrRes.json || qrRes.json.retcode !== 0) {
      lastQrSummary = `HTTP ${qrRes.status} retcode=${qrRes.json?.retcode} msg=${sanitize(qrRes.json?.message || qrRes.text)}`;
    } else {
      const qrB64 = String(qrRes.json.data?.qrcode_base64 || "");
      const online = Boolean(qrRes.json.data?.online);
      lastQrSummary = `retcode=0 online=${online} qrcode_base64_populated=${qrB64.length > 0} length=${qrB64.length}`;
      if (qrB64.length > 0) {
        console.log(`/get_login_qrcode succeeded: ${lastQrSummary}`);
        qrFetched = true;
        break;
      }
    }
    await sleep(3000);
  }
  if (!qrFetched) {
    throw new Error(`Failed to fetch login QR code within 45s (${lastQrSummary})`);
  }

  // 5. Re-check /get_status & /get_capabilities after brief settle and log full sanitized telemetry
  await sleep(5000);
  assertContainerRunning();
  const finalStatus = await requestJson("POST", "/get_status", {});
  if (finalStatus.status !== 200 || !finalStatus.json || finalStatus.json.retcode !== 0) {
    throw new Error(`Post-QR /get_status failed: HTTP ${finalStatus.status} ${sanitize(finalStatus.text)}`);
  }
  const finalBridge = finalStatus.json.data && finalStatus.json.data.bridge;
  if (!finalBridge || typeof finalBridge !== "object") {
    throw new Error(`Missing data.bridge in post-QR /get_status: ${sanitize(finalStatus.text)}`);
  }
  if (!Array.isArray(finalBridge.listenErrors) || finalBridge.listenErrors.length > 0) {
    throw new Error(`Non-empty listenErrors in post-QR /get_status: ${sanitize(JSON.stringify(finalBridge.listenErrors))}`);
  }
  console.log(
    `Capture telemetry summary: map_hook_active=${finalBridge.map_hook_active}, map_hook_release=${JSON.stringify(finalBridge.map_hook_release)}`
  );
  console.log("Final sanitized /get_status:", sanitize(JSON.stringify(finalStatus.json, null, 2)));

  const capRes = await requestJson("POST", "/get_capabilities", { refresh: true });
  if (capRes.status === 200 && capRes.json) {
    console.log("Final sanitized /get_capabilities:", sanitize(JSON.stringify(capRes.json, null, 2)));
  }

  console.log("Canary smoke check PASSED.");
})().catch((err) => {
  console.error("Canary smoke check failed:", sanitize(err && err.stack ? err.stack : String(err)));
  process.exit(1);
});
