#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Rosmontis Headless Linux QQ Container Entrypoint (`scripts/entrypoint.sh`)
#
# Boots official Linux QQ (`/opt/QQ/qq`) with Rosmontis pure-JS Renderer/Main
# OneBot v11 bridge and ZERO native C++ `.so` / `LD_PRELOAD` / `ptrace` hooks:
# - Persistent `/etc/machine-id` -> `/app/data/config/machine-id`
# - System D-Bus, Xvfb (:99), Fluxbox WM, optional x11vnc + noVNC (:6081)
# - Drop-in compatibility when mounted into legacy headless QQ containers
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. Strictly clear LD_PRELOAD / NODE_OPTIONS
unset LD_PRELOAD || true
export LD_PRELOAD=""
unset NODE_OPTIONS || true

# 2. Neutralize legacy native hook binaries if migrating an existing container
if [[ -d /app/runtime/native ]]; then
  for hook_bin in /app/runtime/native/*.so /app/runtime/native/*.node; do
    if [[ -f "${hook_bin}" ]]; then
      mv -f "${hook_bin}" "${hook_bin}.disabled" 2>/dev/null || true
    fi
  done
fi

# 3. Install Rosmontis pure-JS bridge into /opt/QQ/resources/app/app_launcher/
bash "${SCRIPT_DIR}/install_bridge.sh"

# 4. Legacy container migration path: if /root/start.sh + /etc/supervisord.conf exist,
#    strip any third-party native injector program and delegate cleanly.
if [[ "${ROSMONTIS_DIRECT_EXEC:-0}" != "1" ]] && [[ -f /root/start.sh ]] && [[ -f /etc/supervisord.conf ]]; then
  if [[ ! -f /etc/supervisord.orig.conf ]]; then
    cp -f /etc/supervisord.conf /etc/supervisord.orig.conf 2>/dev/null || true
  fi
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const p = "/etc/supervisord.conf";
      const src = fs.readFileSync(p, "utf8");
      let out = src.replace(/\[program:(?!qq\b|xvfb\b|fluxbox\b|x11vnc\b|novnc\b|dbus\b)[a-zA-Z0-9_-]+\][\s\S]*?(?=\n\[|$)/g, "");
      out = out.replace(/[A-Z0-9_]*HOOK_RUNTIME_DIR="[^"]*"/g, "ROSMONTIS_CONFIG_DIR=\"/app/data/config\"");
      out = out.replace(/\n{3,}/g, "\n\n");
      if (out !== src) {
        fs.writeFileSync(p, out.trimEnd() + "\n", "utf8");
        console.log("[rosmontis] Cleaned native injector entries from /etc/supervisord.conf");
      }
    '
  fi
  echo "[rosmontis] Delegating display & supervisor initialization to /root/start.sh..."
  exec /root/start.sh "$@"
fi

# ==============================================================================
# Standalone Pure Linux QQ Execution Mode
# ==============================================================================

NOFILE_SOFT="$(ulimit -Sn || echo 65536)"
if [[ "${NOFILE_SOFT}" == "unlimited" ]] || [[ "${NOFILE_SOFT}" -gt 65536 ]] 2>/dev/null; then
  ulimit -Sn 65536 || true
fi

DATA_DIR="${ROSMONTIS_DATA_DIR:-/app/data}"
mkdir -p "${DATA_DIR}/config"
if [[ ! -s "${DATA_DIR}/config/machine-id" ]]; then
  if [[ -s /etc/machine-id ]]; then
    cp -f /etc/machine-id "${DATA_DIR}/config/machine-id"
  else
    cat /proc/sys/kernel/random/uuid | tr -d '-' > "${DATA_DIR}/config/machine-id"
  fi
fi
ln -sf "${DATA_DIR}/config/machine-id" /etc/machine-id 2>/dev/null || true

if [[ "${ROSMONTIS_BLOCK_HOT_UPDATE:-1}" == "1" ]]; then
  if ! grep -q 'qqpatch\.gtimg\.cn' /etc/hosts 2>/dev/null; then
    printf '0.0.0.0 qqpatch.gtimg.cn\n' >> /etc/hosts 2>/dev/null || true
  fi
fi

# Start D-Bus system daemon
mkdir -p /var/run/dbus
if [[ ! -e /var/run/dbus/system_bus_socket ]] && [[ ! -e /run/dbus/system_bus_socket ]]; then
  dbus-daemon --system --fork 2>/dev/null || true
fi

# Start Xvfb and Fluxbox WM
export DISPLAY="${DISPLAY:-:99}"
DISPLAY_NUM="${DISPLAY#:}"
DISPLAY_NUM="${DISPLAY_NUM%%.*}"
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" || true

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb "${DISPLAY}" -screen 0 "${ROSMONTIS_SCREEN:-1280x800x24}" -ac +extension GLX +render -noreset >/dev/null 2>&1 &
  sleep 1
fi

if command -v fluxbox >/dev/null 2>&1 && ! pgrep -x fluxbox >/dev/null 2>&1; then
  fluxbox >/dev/null 2>&1 &
fi

# Optional x11vnc + noVNC (:6081) for visual QR login / debugging
if [[ -n "${VNC_PASSWD:-}" ]] && command -v x11vnc >/dev/null 2>&1; then
  mkdir -p /tmp/.vnc
  x11vnc -storepasswd "${VNC_PASSWD}" /tmp/.vnc/passwd >/dev/null 2>&1 || true
  x11vnc -display "${DISPLAY}" -rfbauth /tmp/.vnc/passwd -rfbport 5900 -forever -shared >/dev/null 2>&1 &
  if command -v websockify >/dev/null 2>&1 && [[ -d /usr/share/novnc ]]; then
    websockify --web=/usr/share/novnc "${NOVNC_PORT:-6081}" 127.0.0.1:5900 >/dev/null 2>&1 &
    echo "[rosmontis] noVNC desktop available on port ${NOVNC_PORT:-6081}"
  fi
fi

TARGET_UID="${QQ_UID:-1000}"
TARGET_GID="${QQ_GID:-1000}"
if [[ -d /app ]]; then
  USER_HOME="/app"
else
  USER_HOME="$(getent passwd "${TARGET_UID}" | cut -d: -f6 || echo /tmp)"
fi

export HOME="${USER_HOME}"
export XDG_CONFIG_HOME="${HOME}/.config"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-${TARGET_UID}}"
export ROSMONTIS_TEMP_DIR="${ROSMONTIS_TEMP_DIR:-/tmp/rosmontis_tmp}"
export ROSMONTIS_CONFIG_DIR="${ROSMONTIS_CONFIG_DIR:-${DATA_DIR}/config}"

mkdir -p "${HOME}/.config/QQ" "${HOME}/.local/share" "${XDG_RUNTIME_DIR}" "${ROSMONTIS_TEMP_DIR}"
find "${XDG_RUNTIME_DIR}" -maxdepth 1 -type s -name 'mojo.*.*.sock' -delete 2>/dev/null || true

if [[ "$(id -u)" == "0" ]]; then
  chown -R "${TARGET_UID}:${TARGET_GID}" "${HOME}/.config" "${HOME}/.local" "${DATA_DIR}" "${XDG_RUNTIME_DIR}" "${ROSMONTIS_TEMP_DIR}" 2>/dev/null || true
fi

QQ_BIN="${QQ_BIN:-/opt/QQ/qq}"
QQ_ARGS=(
  "--no-sandbox"
  "--disable-gpu"
  "--disable-software-rasterizer"
  "--disable-gpu-compositing"
  "--disable-dev-shm-usage"
)

echo "[rosmontis] Starting official ${QQ_BIN} under UID:GID ${TARGET_UID}:${TARGET_GID} (zero native hooks)..."

if [[ "$(id -u)" == "0" ]]; then
  if command -v gosu >/dev/null 2>&1; then
    exec env -u LD_PRELOAD HOME="${HOME}" gosu "${TARGET_UID}:${TARGET_GID}" "${QQ_BIN}" "${QQ_ARGS[@]}" "$@"
  elif command -v setpriv >/dev/null 2>&1; then
    exec env -u LD_PRELOAD HOME="${HOME}" setpriv --reuid="${TARGET_UID}" --regid="${TARGET_GID}" --init-groups "${QQ_BIN}" "${QQ_ARGS[@]}" "$@"
  else
    TARGET_USER="$(getent passwd "${TARGET_UID}" | cut -d: -f1 || echo ubuntu)"
    exec su -s /bin/bash "${TARGET_USER}" -c "export HOME='${HOME}'; unset LD_PRELOAD; exec '${QQ_BIN}' ${QQ_ARGS[*]} $*"
  fi
else
  unset LD_PRELOAD
  exec "${QQ_BIN}" "${QQ_ARGS[@]}" "$@"
fi
