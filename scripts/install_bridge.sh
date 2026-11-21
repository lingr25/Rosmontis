#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Rosmontis Pure-JS Bridge Installer (`scripts/install_bridge.sh`)
#
# Installs `bridge_onebot.js`, `bridge_renderer.js`, `bridge_main.js`,
# `plugin_loader.js`, `types.js`, `core/*.js`, `onebot/*.js`, `actions/*.js`,
# and `app_launcher_index.js` into `/opt/QQ/resources/app/app_launcher/`,
# updates `/opt/QQ/resources/app/package.json` `"main"` -> `"./app_launcher/index.js"`,
# and verifies that no C++ `.so` memory hook (`LD_PRELOAD`) is active.
#
# Pass `--uninstall` to restore the original backed-up launcher files cleanly.
# Pass `--reload` inside the QQ container to sync files and trigger stateful
# hot-reload (`POST /_reload_bridge`, with safe `SIGUSR2` fallback only when the
# pre-existing in-memory bridge already registered a `SIGUSR2` handler).
# Pass `--docker-reload [container]` on the Docker host to sync local bridge
# sources into the running container and hot-reload in place without restarting QQ.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "${SCRIPT_DIR}/../src" ]]; then
  SRC_DIR="$(cd "${SCRIPT_DIR}/../src" && pwd)"
else
  SRC_DIR="${SCRIPT_DIR}"
fi

QQ_APP_DIR="${QQ_APP_DIR:-/opt/QQ/resources/app}"
LAUNCHER_DIR="${QQ_APP_DIR}/app_launcher"
PACKAGE_JSON="${QQ_APP_DIR}/package.json"
DO_HOT_RELOAD=0

if [[ "${1:-}" == "--docker-reload" ]]; then
  TARGET_CONTAINER="${2:-${ROSMONTIS_CONTAINER:-rosmontis-qq}}"
  STAGE_DIR="/tmp/rosmontis_hot_sync_$$"
  echo "[rosmontis] Syncing bridge files into running container '${TARGET_CONTAINER}' (zero restart)..."
  docker exec "${TARGET_CONTAINER}" rm -rf "${STAGE_DIR}"
  docker exec "${TARGET_CONTAINER}" mkdir -p "${STAGE_DIR}/scripts"
  docker cp "${SRC_DIR}" "${TARGET_CONTAINER}:${STAGE_DIR}/src"
  docker cp "${SCRIPT_DIR}/install_bridge.sh" "${TARGET_CONTAINER}:${STAGE_DIR}/scripts/install_bridge.sh"
  cleanup_stage() {
    docker exec "${TARGET_CONTAINER}" rm -rf "${STAGE_DIR}" >/dev/null 2>&1 || true
  }
  trap cleanup_stage EXIT
  docker exec "${TARGET_CONTAINER}" bash "${STAGE_DIR}/scripts/install_bridge.sh" --reload
  exit 0
fi

if [[ "${1:-}" == "--reload" ]]; then
  DO_HOT_RELOAD=1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  echo "[rosmontis] Restoring original Linux QQ launcher in ${QQ_APP_DIR}..."
  if [[ -f "${QQ_APP_DIR}/package.orig.json" ]]; then
    cp -f "${QQ_APP_DIR}/package.orig.json" "${PACKAGE_JSON}"
  fi
  if [[ -f "${LAUNCHER_DIR}/index.orig.js" ]]; then
    cp -f "${LAUNCHER_DIR}/index.orig.js" "${LAUNCHER_DIR}/index.js"
  fi
  rm -f \
    "${LAUNCHER_DIR}/bridge_onebot.js" \
    "${LAUNCHER_DIR}/bridge_renderer.js" \
    "${LAUNCHER_DIR}/bridge_main.js" \
    "${LAUNCHER_DIR}/plugin_loader.js" \
    "${LAUNCHER_DIR}/types.js"
  for subdir in core onebot actions; do
    rm -rf "${LAUNCHER_DIR}/${subdir}"
  done
  echo "[rosmontis] Uninstalled cleanly."
  exit 0
fi

echo "[rosmontis] Source dir : ${SRC_DIR}"
echo "[rosmontis] Target app : ${QQ_APP_DIR}"

# Record whether the previously installed bridge on disk already registered a
# SIGUSR2 hot-reload handler BEFORE overwriting files, so we never send SIGUSR2
# to an older pre-hot-reload NTQQ process (where SIGUSR2 default action terminates).
PREV_HAS_SIGUSR2_HANDLER=0
if [[ -f "${LAUNCHER_DIR}/bridge_main.js" ]] && grep -q "__rosmontisSigusr2Installed" "${LAUNCHER_DIR}/bridge_main.js" 2>/dev/null; then
  PREV_HAS_SIGUSR2_HANDLER=1
fi

# 1. Verify no LD_PRELOAD C++ .so hook is active
if [[ -n "${LD_PRELOAD:-}" ]]; then
  echo "[rosmontis] WARNING: LD_PRELOAD was set (${LD_PRELOAD}); unsetting for pure JS mode."
  unset LD_PRELOAD
fi

if [[ -f /etc/ld.so.preload ]] && [[ -s /etc/ld.so.preload ]]; then
  if grep -qiE "hook|preload|inject" /etc/ld.so.preload 2>/dev/null; then
    echo "[rosmontis] ERROR: Native preload hook detected in /etc/ld.so.preload" >&2
    exit 1
  fi
fi

# 2. Ensure target launcher directory exists
mkdir -p "${LAUNCHER_DIR}"
chmod 755 "${LAUNCHER_DIR}"

# 3. Backup original launcher index.js and package.json once
if [[ -f "${LAUNCHER_DIR}/index.js" ]] && [[ ! -f "${LAUNCHER_DIR}/index.orig.js" ]]; then
  if ! grep -q "bridge_main.js" "${LAUNCHER_DIR}/index.js" 2>/dev/null; then
    cp -f "${LAUNCHER_DIR}/index.js" "${LAUNCHER_DIR}/index.orig.js"
    echo "[rosmontis] Backed up original app_launcher/index.js -> index.orig.js"
  fi
fi

if [[ -f "${PACKAGE_JSON}" ]] && [[ ! -f "${QQ_APP_DIR}/package.orig.json" ]]; then
  cp -f "${PACKAGE_JSON}" "${QQ_APP_DIR}/package.orig.json"
  echo "[rosmontis] Backed up original package.json -> package.orig.json"
fi

# 4. Copy pure-JS bridge files and core/*.js + onebot/*.js + actions/*.js modules into app_launcher/
cp -f "${SRC_DIR}/bridge_onebot.js" "${LAUNCHER_DIR}/bridge_onebot.js"
cp -f "${SRC_DIR}/bridge_renderer.js" "${LAUNCHER_DIR}/bridge_renderer.js"
cp -f "${SRC_DIR}/bridge_main.js" "${LAUNCHER_DIR}/bridge_main.js"
cp -f "${SRC_DIR}/app_launcher_index.js" "${LAUNCHER_DIR}/index.js"

chmod 644 \
  "${LAUNCHER_DIR}/bridge_onebot.js" \
  "${LAUNCHER_DIR}/bridge_renderer.js" \
  "${LAUNCHER_DIR}/bridge_main.js" \
  "${LAUNCHER_DIR}/index.js"

if [[ -f "${SRC_DIR}/plugin_loader.js" ]]; then
  cp -f "${SRC_DIR}/plugin_loader.js" "${LAUNCHER_DIR}/plugin_loader.js"
  chmod 644 "${LAUNCHER_DIR}/plugin_loader.js"
fi

if [[ -f "${SRC_DIR}/types.js" ]]; then
  cp -f "${SRC_DIR}/types.js" "${LAUNCHER_DIR}/types.js"
  chmod 644 "${LAUNCHER_DIR}/types.js"
fi

for subdir in core onebot actions; do
  if [[ -d "${SRC_DIR}/${subdir}" ]]; then
    rm -rf "${LAUNCHER_DIR}/${subdir}"
    mkdir -p "${LAUNCHER_DIR}/${subdir}"
    chmod 755 "${LAUNCHER_DIR}/${subdir}"
    shopt -s nullglob
    SUBDIR_JS_FILES=("${SRC_DIR}/${subdir}/"*.js)
    shopt -u nullglob
    if (( ${#SUBDIR_JS_FILES[@]} > 0 )); then
      cp -f "${SUBDIR_JS_FILES[@]}" "${LAUNCHER_DIR}/${subdir}/"
      chmod 644 "${LAUNCHER_DIR}/${subdir}/"*.js
    fi
  fi
done

# 5. Update /opt/QQ/resources/app/package.json "main" -> "./app_launcher/index.js" in-place
#    preserving version, buildVersion, appid, and all existing fields.
if [[ -f "${PACKAGE_JSON}" ]]; then
  if node -e '
      const fs = require("fs");
      const pkgPath = process.argv[1];
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (!pkg.original_main && pkg.main && pkg.main !== "./app_launcher/index.js") {
        pkg.original_main = pkg.main;
      }
      pkg.main = "./app_launcher/index.js";
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    ' "${PACKAGE_JSON}" 2>/dev/null; then
    :
  elif python3 -c '
import json, sys
p = sys.argv[1]
with open(p, "r", encoding="utf-8") as f:
    pkg = json.load(f)
if not pkg.get("original_main") and pkg.get("main") and pkg.get("main") != "./app_launcher/index.js":
    pkg["original_main"] = pkg["main"]
pkg["main"] = "./app_launcher/index.js"
with open(p, "w", encoding="utf-8") as f:
    json.dump(pkg, f, indent=2)
    f.write("\n")
' "${PACKAGE_JSON}" 2>/dev/null; then
    :
  else
    sed -i 's|"main"[[:space:]]*:[[:space:]]*"[^"]*"|"main": "./app_launcher/index.js"|g' "${PACKAGE_JSON}"
  fi
else
  cp -f "${SRC_DIR}/package_patch.json" "${PACKAGE_JSON}"
fi

chmod 644 "${PACKAGE_JSON}"

# 6. Verify installation
if ! grep -q '"./app_launcher/index.js"' "${PACKAGE_JSON}"; then
  echo "[rosmontis] ERROR: Failed to update ${PACKAGE_JSON} main field" >&2
  exit 1
fi

echo "[rosmontis] Installed Rosmontis Pure-JS Bridge into ${LAUNCHER_DIR}"

if [[ "${DO_HOT_RELOAD}" == "1" ]]; then
  echo "[rosmontis] Triggering stateful hot-reload in running NTQQ process..."
  HTTP_RC=3
  if command -v node >/dev/null 2>&1; then
    set +e
    node -e '
      const http = require("http");
      const path = require("path");

      const cfgMod = require(path.join(process.argv[1], "core", "config.js"));
      const cfg = cfgMod.loadBridgeConfig(process.env.ROSMONTIS_CONFIG_DIR || process.env.ONEBOT_CONFIG_DIR);
      const srv = (cfg.httpServers && cfg.httpServers[0]) || { port: 3000, accessToken: "" };
      const port = Number(process.env.ROSMONTIS_HTTP_PORT || srv.port || 3000);
      const token = String(
        process.env.ROSMONTIS_ACCESS_TOKEN ||
        process.env.XIAO_ONEBOT_HTTP_TOKEN ||
        srv.accessToken ||
        ""
      );

      const body = JSON.stringify({ reload_config: true, reload_renderer: true });
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/_reload_bridge",
          method: "POST",
          timeout: 10000,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(raw);
              if (res.statusCode === 200 && parsed.status === "ok" && parsed.retcode === 0) {
                console.log("[rosmontis] Hot-reload OK:", JSON.stringify(parsed.data));
                process.exit(0);
              }
              const errMsg = String(parsed.message || parsed.wording || raw);
              if (/Unsupported OneBot action:\s*_?reload_bridge/i.test(errMsg)) {
                console.error("[rosmontis] Running NTQQ bridge predates hot-reload support; files staged on disk, one-time QQ restart required.");
                process.exit(10);
              }
              console.error("[rosmontis] Hot-reload HTTP action rejected:", raw);
              process.exit(11);
            } catch (_) {
              console.error("[rosmontis] Non-JSON hot-reload response:", raw);
              process.exit(11);
            }
          });
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.on("error", (err) => {
        console.error("[rosmontis] Hot-reload HTTP request failed:", err.message);
        process.exit(3);
      });
      req.write(body);
      req.end();
    ' "${LAUNCHER_DIR}"
    HTTP_RC=$?
    set -e
    if [[ "${HTTP_RC}" == "0" ]]; then
      exit 0
    fi
    if [[ "${HTTP_RC}" == "10" ]] || [[ "${HTTP_RC}" == "11" ]]; then
      exit "${HTTP_RC}"
    fi
  fi

  if [[ "${PREV_HAS_SIGUSR2_HANDLER}" != "1" ]]; then
    echo "[rosmontis] ERROR: HTTP /_reload_bridge unreachable and pre-existing bridge_main.js had no SIGUSR2 handler; refusing to send SIGUSR2 to avoid terminating QQ." >&2
    exit 1
  fi

  QQ_MAIN_PID="$(ps -eo pid=,args= | awk '$2 ~ /^(qq|\/opt\/QQ\/qq)$/ && $0 !~ /--type=/ { print $1; exit }')"
  if [[ -n "${QQ_MAIN_PID}" ]]; then
    kill -USR2 "${QQ_MAIN_PID}"
    echo "[rosmontis] Sent SIGUSR2 hot-reload signal to NTQQ main process (PID ${QQ_MAIN_PID})."
    exit 0
  fi
  echo "[rosmontis] ERROR: Could not reach /_reload_bridge HTTP endpoint or find running NTQQ main process" >&2
  exit 1
fi
