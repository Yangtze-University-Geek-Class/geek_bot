# geek_bot

> A self-hosted GitHub maintenance bot: one GitHub account acts as the bot, reviews pull requests, triages and follows up on issues, and fixes small changes in a disposable VM before opening a pull request. Approving and merging always stay with humans.

状态：`current` · 更新：2026-09-26 · 适用：anyone opening this repository for the first time

[中文](README.md) | English

This English page is an overview. The Chinese documents are canonical; when they disagree, follow [README.md](README.md) and [docs/README.md](docs/README.md).

## What it is

geek_bot is a general-purpose product you deploy yourself. The deployer signs in to the web console with a GitHub account (usually a secondary account), and that account becomes the bot. It discovers every repository the account can access and acts within its actual permission on each one:

- reviews pull requests with `COMMENT` reviews only, never approvals;
- triages and follows up on issues;
- fixes small changes in a disposable VM, opens a pull request, and reworks it after review.

Approving and merging always stay with humans. Each repository is handled by its own conventions; when it has none, geek_bot uses built-in defaults that can be edited in the console. The control plane can drive several worker nodes; nodes only make outbound connections to the control plane and open no inbound ports.

## Packages

| Directory | Package | Role | Contract |
|---|---|---|---|
| `app/control` | `@geek-bot/control` | Control plane (Fastify 5 + better-sqlite3, planned): sign-in, encrypted token storage, repository discovery, polling, scheduling, model relay; the only SQLite writer and the only GitHub writer (write allowlist + outbox); serves the console build from the same origin | [control](docs/services/control/README.md) |
| `app/console` | `@geek-bot/console` | Admin console (Vue 3.5 + vue-router 4 + Tuffex 0.6.0 + Vite, added in #4); no native selects or checkboxes, no emoji | [console](docs/services/console/README.md) |
| `app/node` | `@geek-bot/node` | Worker node agent: outbound-only link to control; runs network-less read-only sandbox containers for issues and disposable QEMU/KVM VMs for pull requests | [node](docs/services/node/README.md) |
| `app/runner` | `@geek-bot/runner` | Single-file program that drives omp inside the sandbox or VM, Node standard library only | [runner](docs/services/runner/README.md) |
| `packages/protocol` | `@geek-bot/protocol` | Types and JSON Schema only: node protocol, tasks, results, repository profiles, model catalog, console API; any package may import it, it imports none | [protocol](docs/services/protocol/README.md) |

## Status

- **Skeleton stage (#1)**: pnpm workspace, conventions, gate scripts, CI and issue / pull request templates. The five packages contain minimal source and tests only; there is no product feature and no production dependency yet.
- Architecture, security model, console API, node protocol, write whitelist and default behavior are written as design documents ([ARCHITECTURE](docs/architecture/ARCHITECTURE.md), [SECURITY](docs/architecture/SECURITY.md), [API](docs/architecture/API.md), status `proposed` until implemented); the decisions are ADR-0002 to ADR-0009, accepted by the owner on 2026-09-26.
- Features land issue by issue following the roadmap in #22: control plane (#3), console shell (#4), bot account sign-in (#5), repository discovery (#6), preview stack and deployment (#7), nodes (#11). The first visible milestone is a pull request receiving a comment-only review from the bot (#15); production launch is #20 and public readiness is #21.
- **Deployment**: deployment files and docs arrive with #7. Nothing in the repository can be deployed yet.

## Contributing

1. Read [AGENTS.md](AGENTS.md) first and finish the reading list in its §0 before changing anything.
2. Install Node 22 (`.nvmrc`, at least 22.13) and pnpm 9.15.9; see [LOCAL-DEV](docs/ops/LOCAL-DEV.md).
3. Install, verify and enable the Git hook:

   ```bash
   pnpm install --frozen-lockfile
   pnpm verify          # runtime, package boundaries, docs, execution records, secrets, public safety, typecheck, then tests and build
   pnpm hooks:enable    # pre-push checks branch invariants and release tag rules
   ```

4. One change = one issue = one `task/<issue>/<slug>` branch = one worktree = one pull request into `stage`; see [CONTRIBUTING](docs/conventions/CONTRIBUTING.en.md) and [BRANCHING](docs/conventions/BRANCHING.md).

Type checks, successful builds, mock previews, browser checks and acceptance on a live instance are different kinds of evidence and never substitute for each other ([TESTING](docs/conventions/TESTING.md)).

## Documentation

- [AGENTS.md](AGENTS.md): the single agent entry and its hard gates.
- [docs/README.md](docs/README.md): documentation hub and the directory ↔ service contract ↔ convention map.
- [Decisions](docs/decisions/README.md): why this is a standalone general-purpose product ([ADR-0001](docs/decisions/0001-standalone-product.md)) and more.

## License

Not chosen yet. Before the repository goes public, the owner picks a license, adds `SECURITY.md`, and meets the other preconditions in [ADR-0001](docs/decisions/0001-standalone-product.md) (repository files, commit history, and GitHub content such as issues, pull requests and comments all checked clean).
