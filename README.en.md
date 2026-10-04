# geek_bot

> A self-hosted cross-platform project-maintenance and demand-execution system: GitHub, GitLab and messaging adapters share projects, demands, tasks and a machine pool. Approving and merging stay with humans.

状态：`current` · 更新：2026-10-03 · 适用：anyone opening this repository for the first time

[中文](README.md) | English

This English page is an overview. The Chinese documents are canonical; when they disagree, follow [README.md](README.md) and [docs/README.md](docs/README.md).

## What it is

One instance owns a shared workspace. Administrators configure channel accounts, project permissions and execution resources. The control plane assigns tasks within capability, label, trust, slot, CPU and memory limits. There are no tenants, team spaces or user-private machine pools.

- GitHub and GitLab adapters discover participating projects and read issues and PRs/MRs. Explicit per-project switches authorize review, triage, repair and rework.
- Feishu events and signed webhooks intake demands. A demand must be linked to a project before dispatch; progress and results use the controlled publisher.
- Read-only tasks use network-less sandboxes; writable tasks use disposable QEMU/KVM VMs. Nodes make outbound connections only.

Console identity and channel credentials are separate. Administrators use GitHub device flow for numeric identity; temporary login tokens are revoked. Channel accounts are independently bound, and credentials are encrypted only in control. Repository content and model output cannot widen capabilities. The bot never approves, merges or pushes protected branches or tags.

## Packages

| Directory | Package | Role | Contract |
|---|---|---|---|
| `app/control` | `@geek-bot/control` | Fastify 5 and SQLite single writer; identity, connectors, demands, tasks, resource leases, model relay, durable publisher outbox and same-origin console hosting | [control](docs/services/control/README.md) |
| `app/console` | `@geek-bot/console` | Vue 3.5 and Tuffex 0.6.0 pages for projects, demands, machines, tasks, connections, model pools and administrators | [console](docs/services/console/README.md) |
| `app/node` | `@geek-bot/node` | Outbound worker, self-checks, resource bounds, sandbox/VM execution, local model relay, disk spool and cancellation | [node](docs/services/node/README.md) |
| `app/runner` | `@geek-bot/runner` | Standard-library-only single-file omp driver with isolated discovery, explicit tools, structured results and patches | [runner](docs/services/runner/README.md) |
| `packages/protocol` | `@geek-bot/protocol` | Shared DTOs and JSON Schema; no app imports or I/O | [protocol](docs/services/protocol/README.md) |

## Status

- #34 implements the persisted shared-platform API, production console, connectors, worker and runner source. Service contracts and code are the implementation source of truth.
- Real local HTTP/SQLite smoke exercised discovery, sync, demand dispatch, lease fences, secret replay refusal, role enforcement and restart persistence. External APIs were isolated protocol fixtures, not live account acceptance.
- Ego exercised the production-mode console at desktop and 390px widths: project lists, demand creation/linking/dispatch and cancellation. Its login session came from an isolated authorization fixture, not real GitHub OAuth acceptance. Sample mode remains development-only and refuses writes with HTTP 405.
- Real GitHub OAuth, GitLab and Feishu account writes, node/sandbox image builds and Linux/KVM execution require separate authorization and hardware acceptance; they are not marked passed.
- Control and node/sandbox Dockerfiles exist. Release tags and target-host deployment remain governed by [RELEASES](docs/conventions/RELEASES.md); this change does not automatically commit, push, tag or deploy.

## Contributing

1. Read [AGENTS.md](AGENTS.md) first and finish the reading list in its §0 before changing anything.
2. Install Node 22 (`.nvmrc`, at least 22.13) and pnpm 9.15.9; see [LOCAL-DEV](docs/ops/LOCAL-DEV.md).
3. Install, verify and enable the Git hook:

   ```bash
   pnpm install --frozen-lockfile
   pnpm verify          # runtime, package boundaries, docs, execution records, secrets, public safety, typecheck, then tests and build
   pnpm hooks:enable    # pre-push checks branch invariants and release tag rules
   pnpm dev:console     # open the console locally in sample-data mode (all data is fictional)
   pnpm dev:control     # run the control plane locally (throwaway local keys, database in ./data/)
   pnpm dev:node        # outbound node; first register a machine and configure its token file and executor assets
   PLAYWRIGHT_BROWSERS_PATH=/tmp/geek-bot-playwright pnpm test:e2e # install Chromium with the same path first
   ```

4. One change = one issue = one `task/<issue>/<slug>` branch = one worktree = one pull request into `stage`; see [CONTRIBUTING](docs/conventions/CONTRIBUTING.en.md) and [BRANCHING](docs/conventions/BRANCHING.md).

Type checks, successful builds, mock previews, browser checks and acceptance on a live instance are different kinds of evidence and never substitute for each other ([TESTING](docs/conventions/TESTING.md)).

## Documentation

- [AGENTS.md](AGENTS.md): the single agent entry and its hard gates.
- [docs/README.md](docs/README.md): documentation hub and the directory ↔ service contract ↔ convention map.
- [Decisions](docs/decisions/README.md): why this is a standalone general-purpose product ([ADR-0001](docs/decisions/0001-standalone-product.md)) and more.

## License

Not chosen yet. Before the repository goes public, the owner picks a license, adds `SECURITY.md`, and meets the other preconditions in [ADR-0001](docs/decisions/0001-standalone-product.md) (repository files, commit history, and GitHub content such as issues, pull requests and comments all checked clean).
