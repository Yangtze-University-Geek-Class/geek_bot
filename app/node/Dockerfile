# 工作节点镜像（geek-bot-node，默认目标）与 sandbox 槽位镜像（--target sandbox）。构建上下文是仓库根，只支持 linux/amd64：
#
#   docker build --platform linux/amd64 -f app/node/Dockerfile -t geek-bot-node:local .
#   docker build --platform linux/amd64 -f app/node/Dockerfile --target sandbox -t geek-bot-sandbox:local .
#
# 钉死的构建输入（改任何一项都要同时改摘要）：
#   - 基础镜像按 digest（与 control 镜像同一个 node:22-bookworm-slim）；
#   - Debian 软件包取自 snapshot.debian.org 的固定时间点（apt 照常校验 Release 签名）；
#   - omp 18.4.4 的 linux-x64 发布二进制按 GitHub release 公布的 sha256 校验；
#   - VM 基础镜像是 Debian 12 genericcloud 的固定日期构建，按官方 SHA512SUMS 里的 sha512 校验；
#   - 来宾里的 Node 直接取基础镜像里的同一个 node 二进制（同为 Debian 12 glibc）。
# 镜像里没有任何令牌、域名或环境身份；节点令牌由 GEEK_BOT_NODE_TOKEN_FILE 指向的只读挂载文件提供。
# 节点容器：非 root（node，uid 1000）、不开端口、不挂 docker.sock，只挂 /dev/kvm（group_add 宿主 kvm 组）、cap_drop ALL、
# no-new-privileges。sandbox 容器：network none、根只读、/work 与 /tmp 用 tmpfs、cap_drop ALL、no-new-privileges，
# 只与本槽位的共享卷相连。

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG DEBIAN_SNAPSHOT=20260923T000000Z
ARG OMP_VERSION=18.4.4
ARG OMP_SHA256=24c830fceb0bd6884bf5bf2c7a2b7407bc23fafe655e924c695ef9be308e46f3
ARG VM_IMAGE_URL=https://cloud.debian.org/images/cloud/bookworm/20260923-2610/debian-12-genericcloud-amd64-20260923-2610.qcow2
ARG VM_IMAGE_SHA512=3d94c9dd66d8a283fde060b8810373b7ae04038b956ee00d553d1ae564f6fbdeaa2fd6e7404e87e53348b5a9509170f3ea7c0731ba737590c5c4cb8d559a47f8

# ---- 编译 protocol、runner（单文件 runner.mjs）与 node ----
FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/control/package.json app/control/
COPY app/console/package.json app/console/
COPY app/node/package.json app/node/
COPY app/runner/package.json app/runner/
COPY packages/protocol/package.json packages/protocol/

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@geek-bot/node..."

FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts --filter geek_bot --filter "@geek-bot/node..." --filter "@geek-bot/runner..."
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY app/runner app/runner
COPY app/node app/node
RUN pnpm --filter @geek-bot/protocol build \
 && pnpm --filter @geek-bot/runner build \
 && pnpm --filter @geek-bot/node build \
 && test -x app/runner/dist/runner.mjs

# ---- Debian 软件源钉在 snapshot 的固定时间点 ----
FROM ${NODE_IMAGE} AS apt-base
ARG DEBIAN_SNAPSHOT
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm-updates main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' \
      "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list

# ---- omp：校验发布二进制，并预先解出原生模块（运行时 XDG_DATA_HOME 指向只读的 /opt/geekbot/omp-data）----
FROM ${NODE_IMAGE} AS omp
ARG OMP_VERSION
ARG OMP_SHA256
COPY app/node/docker/fetch-verified.mjs /tmp/fetch-verified.mjs
RUN mkdir -p /opt/geekbot/omp /opt/geekbot/omp-data/omp \
 && node /tmp/fetch-verified.mjs "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-x64" sha256 "$OMP_SHA256" /opt/geekbot/omp/omp \
 && chmod 0755 /opt/geekbot/omp/omp \
 && test "$(HOME=/tmp/omp-home /opt/geekbot/omp/omp --version)" = "omp/${OMP_VERSION}" \
 && HOME=/tmp/omp-home XDG_DATA_HOME=/opt/geekbot/omp-data /opt/geekbot/omp/omp models --help > /dev/null \
 && test -n "$(ls /opt/geekbot/omp-data/omp/natives/${OMP_VERSION})" \
 && rm -rf /tmp/omp-home \
 && chmod -R a+rX,go-w /opt/geekbot

# ---- VM 资产：校验基础镜像，打工具盘（squashfs）与 cloud-init 种子 ----
FROM apt-base AS vmassets
ARG VM_IMAGE_URL
ARG VM_IMAGE_SHA512
RUN apt-get update \
 && apt-get install -y --no-install-recommends squashfs-tools genisoimage \
 && rm -rf /var/lib/apt/lists/*
COPY app/node/docker/fetch-verified.mjs /tmp/fetch-verified.mjs
RUN mkdir -p /out \
 && node /tmp/fetch-verified.mjs "$VM_IMAGE_URL" sha512 "$VM_IMAGE_SHA512" /out/base.qcow2
COPY --from=omp /opt/geekbot /stage/tools
COPY --from=build /src/app/runner/dist/runner.mjs /stage/tools/runner.mjs
COPY app/node/vm/guest-init.sh /stage/tools/guest-init.sh
COPY app/node/vm/user-data app/node/vm/meta-data /stage/seed/
RUN mkdir -p /stage/tools/node/bin \
 && cp /usr/local/bin/node /stage/tools/node/bin/node \
 && chmod 0755 /stage/tools/guest-init.sh /stage/tools/runner.mjs \
 && mksquashfs /stage/tools /out/tools.img -noappend -all-root -comp gzip -quiet \
 && genisoimage -quiet -output /out/seed.iso -volid cidata -joliet -rock /stage/seed/user-data /stage/seed/meta-data \
 && chmod 0444 /out/*

# ---- sandbox 槽位镜像：只有 runner、omp 与 Node，没有网络工具 ----
FROM ${NODE_IMAGE} AS sandbox
ENV NODE_ENV=production
COPY --from=omp /opt/geekbot /opt/geekbot
COPY --from=build /src/app/runner/dist/runner.mjs /opt/geekbot/runner.mjs
RUN mkdir -p /run/geek-bot /work \
 && chown node:node /run/geek-bot /work \
 && chmod 0700 /work
USER node
WORKDIR /work
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["test", "-S", "/run/geek-bot/node.sock"]
ENTRYPOINT ["node", "/opt/geekbot/runner.mjs", "slot", "--socket", "/run/geek-bot/node.sock", "--work", "/work", "--omp", "/opt/geekbot/omp/omp", "--omp-data", "/opt/geekbot/omp-data"]

# ---- 节点镜像（默认目标）----
FROM apt-base AS node
ARG OMP_VERSION
ENV NODE_ENV=production GEEK_BOT_NODE_DATA_DIR=/var/lib/geek-bot GEEK_BOT_NODE_OMP_VERSION=${OMP_VERSION}
RUN apt-get update \
 && apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /src/node_modules ./node_modules
COPY --from=deps /src/app/node/node_modules ./app/node/node_modules
COPY --from=build /src/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /src/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /src/app/node/package.json ./app/node/package.json
COPY --from=build /src/app/node/dist ./app/node/dist
COPY --from=vmassets /out/base.qcow2 /out/tools.img /out/seed.iso /opt/geekbot/vm/
RUN mkdir -p /var/lib/geek-bot/slots \
 && chown -R node:node /var/lib/geek-bot \
 && chmod 0700 /var/lib/geek-bot
USER node
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 CMD ["node", "/app/app/node/dist/healthcheck.js"]
CMD ["node", "/app/app/node/dist/main.js"]
