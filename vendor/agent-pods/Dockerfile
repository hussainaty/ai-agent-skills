FROM debian:bookworm-slim

# Which browser to bake in: "chromium" (default) or "brave".
# Both are Chromium-family and speak CDP identically.
#   docker build --build-arg BROWSER=brave -t agent-pod:latest .
ARG BROWSER=chromium

# Virtual display + VNC + noVNC web viewer + CDP bridge
# + xdotool (real X cursor control for humanized UI testing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation \
    fonts-noto-color-emoji \
    xvfb \
    x11-utils \
    x11vnc \
    novnc \
    websockify \
    socat \
    xdotool \
    curl \
    gnupg \
    ca-certificates \
    && if [ "$BROWSER" = "brave" ]; then \
         curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
           https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg && \
         echo "deb [arch=amd64 signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" \
           > /etc/apt/sources.list.d/brave-browser-release.list && \
         apt-get update && apt-get install -y --no-install-recommends brave-browser && \
         echo "brave-browser" > /etc/pod-browser ; \
       else \
         apt-get install -y --no-install-recommends chromium && \
         echo "chromium" > /etc/pod-browser ; \
       fi \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
COPY glide-click /usr/local/bin/glide-click
RUN chmod +x /entrypoint.sh /usr/local/bin/glide-click

# 9222 = CDP (bridged via socat), 7900 = noVNC web viewer
EXPOSE 9222 7900

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=5 \
  CMD curl -sf http://127.0.0.1:9221/json/version > /dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
