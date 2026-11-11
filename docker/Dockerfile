FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
# Optional override URL; when empty, automatically resolves & signs the latest official Tencent Linux QQ .deb for the build architecture
ARG QQ_DEB_URL=""

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    dbus \
    dbus-x11 \
    fluxbox \
    fonts-noto-cjk \
    gosu \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0t64 \
    libnotify4 \
    libnss3 \
    libpango-1.0-0 \
    libsecret-1-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    nodejs \
    novnc \
    procps \
    websockify \
    x11vnc \
    xdg-utils \
    xvfb \
  && DEB_ARCH="$(dpkg --print-architecture)" \
  && RAW_QQ_URL="${QQ_DEB_URL}" \
  && if [ -z "${RAW_QQ_URL}" ]; then \
       PC_CFG="$(curl -fsSL https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json || curl -fsSL https://im.qq.com/proxy/domain/qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json)" \
       && RAW_QQ_URL="$(printf '%s' "${PC_CFG}" | DEB_ARCH="${DEB_ARCH}" node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")).Linux||{}; const a=process.env.DEB_ARCH; const u=a==="arm64"?c.armDownloadUrl?.deb:a==="loongarch64"?(c.loongarchDownloadUrl?.deb||c.loongarchDownloadUrl):a==="mips64el"?(c.mipsDownloadUrl?.deb||c.mipsDownloadUrl):c.x64DownloadUrl?.deb; if(!u)process.exit(1); process.stdout.write(u);')"; \
     fi \
  && RESOLVED_QQ_URL="${RAW_QQ_URL}" \
  && case "${RAW_QQ_URL}" in \
       https://qqdl.gtimg.cn/*) \
         case "${RAW_QQ_URL}" in \
           *sign=*) ;; \
           *) \
             SIGN_BODY="$(RAW_QQ_URL="${RAW_QQ_URL}" node -e 'process.stdout.write(JSON.stringify({url:process.env.RAW_QQ_URL}))')" \
             && SIGN_RESP="$(curl -fsSL -X POST https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign -H 'Content-Type: application/json' -H 'x-oidb: {"uint32_command":"0x9b8e","uint32_service_type":1}' -d "${SIGN_BODY}")" \
             && RESOLVED_QQ_URL="$(printf '%s' "${SIGN_RESP}" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); if(r.retcode!==0||!r.data?.url)process.exit(1); process.stdout.write(r.data.url);')" \
             ;; \
         esac \
         ;; \
     esac \
  && curl -fsSL "${RESOLVED_QQ_URL}" -o /tmp/linuxqq.deb \
  && apt-get install -y --no-install-recommends /tmp/linuxqq.deb \
  && rm -f /tmp/linuxqq.deb \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/.config /app/.local/share /app/data/config /opt/rosmontis \
  && chown -R 1000:1000 /app

COPY src /opt/rosmontis/src
COPY scripts /opt/rosmontis/scripts
RUN chmod +x /opt/rosmontis/scripts/*.sh

WORKDIR /app
EXPOSE 3000 3001 6081

ENTRYPOINT ["bash", "/opt/rosmontis/scripts/entrypoint.sh"]
