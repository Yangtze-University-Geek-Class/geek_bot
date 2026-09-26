# task/3/control_foundation · crosery · 2026-09-26

负责人：crosery

## 11:23:13 +08:00 · 开工 · #3 · 从 origin/stage 400917d090a0 建 task/3/control_foundation

- 执行者：agent-claude-geek-bot-821e（Claude Code，claude-opus-5-5）
- 做了什么：node scripts/task.mjs start 3 control_foundation：从 origin/stage 400917d090a08843376296014fdf38d3ce9ac3aa 建分支与 worktree .claude/worktrees/task-3，在 issue 上留开工记录
- 结果：worktree 已建好，issue 上已留开工记录

## 11:33:49 +08:00 · 方案 · #3 · 读完规范与 #3 相关契约，定下实现方案

- 执行者：agent-claude-geek-bot-821e-control3（Claude Code，claude-opus-5-5）
- 做了什么：按 AGENTS §0 读完九篇规范与 TESTING、MODULAR-DEVELOPMENT、COMMITS、DOCUMENTATION、control 契约、data-model、behavior、SECURITY、ARCHITECTURE、API、ADR-0003/0007/0008、STACK、LOCAL-DEV、CICD 与 issue #3 正文；方案：config.ts 扩展部署配置（密钥只读 *_FILE）；0001 迁移建 schema_migrations、settings、revisions、idempotency_keys、alerts、audit_logs（只追加触发器）、backups；迁移器按 user_version 加 compat_version 判定；control 进程以 locking_mode=EXCLUSIVE 独占库，CLI 经容器内 unix socket 交给运行中的 control；备份 AES-256-GCM 流式加密加 sha256，每日备份后恢复校验，保留 7 日加 4 周；/healthz、/readyz；自带 JSON 日志加密钥形态打码；SIGTERM 后 checkpoint；多阶段 Dockerfile 与 CI docker job
- 结果：方案已定；A-55 /api/release 与 console 静态托管不在 #3 做（发布 tag 规则只在 scripts/release-tags.mjs 实现，展示值留给 #7）

## 12:20:01 +08:00 · 开发 · #3 · control 骨架、镜像与 CI docker job 开发完成，本机验证通过

- 执行者：agent-claude-geek-bot-821e-control3（Claude Code，claude-opus-5-5）
- 做了什么：新增 fastify ^5.12.5、better-sqlite3 ^13.0.3、@types/better-sqlite3 ^9.6.0（所有者已批准）；写 config、密钥文件、迁移器与 0001、审计与告警、日志打码、加密备份与每日恢复校验、本地通道与 CLI、/healthz 与 /readyz、优雅停机、dev:control、Dockerfile、CI docker job；密钥门禁把 BACKUP_KEY 当作密钥名；同步 control 契约、data-model、behavior、STACK、TESTING、LOCAL-DEV、CICD、ADR-0002/0003/0007/0008/0009 等文档；本机 docker build 与 docker run 实测（Docker Hub 直连不通，基础镜像按钉死的 digest 经代理下载、逐个 blob 核对 sha256 后载入本机，--build-arg NODE_IMAGE 指向它）
- 结果：pnpm verify 退出码 0（Test Files 29 passed，Tests 389 passed）；pnpm test:e2e 42 passed；actionlint 1.7.12 退出码 0；docker run 后 curl /readyz 为 200，docker inspect 显示 Config.User=node、uid 1000、Healthcheck 为 CMD node dist/healthcheck.js 且状态 healthy；docker stop 后退出码 0、库目录里没有 -wal；不挂 master key 再起，退出码 1，输出只有变量名和路径，两把密钥原文出现次数都是 0

## 12:22:45 +08:00 · 提交 · #3 · 密钥门禁把 BACKUP_KEY 当作密钥名

- 执行者：agent-claude-geek-bot-821e-control3（Claude Code，claude-opus-5-5）
- 做了什么：feat(tooling): 密钥门禁把 BACKUP_KEY 当作密钥名（scripts/check-secrets.mjs 的 SECRET_KEY_RE 加 BACKUP_KEY，tests/tooling/secrets.test.ts 加反例，TESTING 同步）；同一提交并入 task.mjs start 带进来的 #4 收尾暂存记录；提交前在完整改动上跑 pnpm verify 与 pnpm exec vitest run tests/tooling/secrets.test.ts
- 结果：tests/tooling/secrets.test.ts 20 passed；完整改动上 pnpm verify 退出码 0（Tests 389 passed）；这个提交单独的树另在临时 worktree 里核对
