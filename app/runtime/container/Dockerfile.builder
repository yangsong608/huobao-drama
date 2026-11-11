FROM --platform=linux/arm64 huobao-debian-base:arm64

ENV DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=22.16.0
ARG NODE_SHA256=eab80cb88f8fda1e65f5e8d0420c9809bdb320b03fd34976ab7161b6e703b910

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils zstd binutils dpkg \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt/* /var/log/dpkg.log

RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm /tmp/node.tar.xz \
 && npm install -g esbuild@0.28.2 --no-audit --no-fund \
 && rm -rf /root/.npm

ENV NODE_PATH=/usr/local/lib/node_modules
WORKDIR /work
