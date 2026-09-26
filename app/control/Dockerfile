# control 镜像（geek-bot-control）。构建上下文是仓库根：
#
#   docker build -f app/control/Dockerfile -t geek-bot-control:local .
#
# - 多阶段：deps 只装 control 的生产依赖；build 装编译所需的依赖并编译 protocol 与 control；
#   runtime 只拷生产依赖和编译产物，不带源码、测试、文档和开发依赖。
# - 基础镜像按 digest 钉死（SECURITY S-18）；NODE_IMAGE 可以用 --build-arg 换成同一 digest 的本机副本。
# - 镜像里没有环境身份、域名和密钥（ADR-0007）：实例角色、origin、端口等来自运行时 env，密钥来自 *_FILE 指向的文件
#   （默认 /run/secrets/master_key、/run/secrets/backup_key）。库默认在 /data/geek-bot.db，部署时 /data 挂命名卷。
# - 以非 root 的 node 用户运行，带 HEALTHCHECK（请求 /readyz）。
# - console 的构建产物打进本镜像、由 control 同源托管随 #7 加入。

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

FROM ${NODE_IMAGE} AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /src
# pnpm 的版本来自根 package.json 的 packageManager（corepack 按 npm 签名校验）。
RUN corepack enable
# 锁文件核对需要全部工作区包的清单；各包的源码只在用到的阶段再拷。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/control/package.json app/control/
COPY app/console/package.json app/console/
COPY app/node/package.json app/node/
COPY app/runner/package.json app/runner/
COPY packages/protocol/package.json packages/protocol/

# 生产依赖：只装 control 及其依赖的工作区包。--ignore-scripts：better-sqlite3 13 自带各平台的预编译二进制，
# 运行时直接加载，不需要 node-gyp、python 和编译器。
FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@geek-bot/control..."

# 编译：根项目（TypeScript）加 control 及其依赖。
FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts --filter geek_bot --filter "@geek-bot/control..."
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY app/control app/control
RUN pnpm --filter @geek-bot/protocol build && pnpm --filter @geek-bot/control build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# 目录结构与构建时一致，pnpm 的相对符号链接照常指向 node_modules/.pnpm。文件属 root，运行用户只读。
COPY --from=deps /src/node_modules ./node_modules
COPY --from=deps /src/app/control/node_modules ./app/control/node_modules
COPY --from=build /src/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /src/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /src/app/control/package.json ./app/control/package.json
COPY --from=build /src/app/control/dist ./app/control/dist
# geek-bot：运维命令入口（docker compose exec control geek-bot backup）；/data：库、备份与本地通道，只给运行用户。
RUN printf '#!/bin/sh\nexec node /app/app/control/dist/cli.js "$@"\n' > /usr/local/bin/geek-bot \
  && chmod 0755 /usr/local/bin/geek-bot \
  && mkdir -p /data \
  && chown node:node /data \
  && chmod 0700 /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 CMD ["node", "/app/app/control/dist/healthcheck.js"]
CMD ["node", "/app/app/control/dist/index.js"]
