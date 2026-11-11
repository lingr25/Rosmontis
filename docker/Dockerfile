FROM ubuntu:24.04

ARG DEBIAN_FRONTEND=noninteractive
# Supply the official Tencent Linux QQ .deb download URL for your architecture (amd64 / arm64)
ARG QQ_DEB_URL="https://dldir1.qq.com/qqfile/qq/QQNT/Linux/QQ_3.2.32_260508_amd64_01.deb"

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
  && curl -fsSL "${QQ_DEB_URL}" -o /tmp/linuxqq.deb \
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
