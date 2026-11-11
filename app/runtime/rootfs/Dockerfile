FROM --platform=linux/arm64 huobao-debian-base:arm64

ENV DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=22.16.0
ARG NODE_SHA256=eab80cb88f8fda1e65f5e8d0420c9809bdb320b03fd34976ab7161b6e703b910

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 tzdata xz-utils \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt/* /var/log/dpkg.log

RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm /tmp/node.tar.xz

WORKDIR /opt/huobao
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --cache /tmp/npm-cache \
 && rm -rf /tmp/npm-cache /root/.npm \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/include/node /usr/local/share/doc /usr/local/share/man /usr/local/share/systemtap

COPY backend.mjs ./
COPY web ./web
COPY workspace ./workspace

RUN dpkg-query -W -f='${Package}=${Version}\n' | sort > system-packages.txt \
 && /usr/local/bin/node -v > node-version.txt \
 && rm -f /etc/resolv.conf && : > /etc/resolv.conf

ENV HOST=127.0.0.1 \
    PORT=5679 \
    FRONTEND_DIST=/opt/huobao/web \
    WORKSPACE_PATH=/opt/huobao/workspace
CMD ["/usr/local/bin/node", "/opt/huobao/backend.mjs"]
