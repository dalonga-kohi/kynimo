# Kynimo — working agreement for AI agents

Kynimo is an **agent-first, cloud-hosted motion graphics engine**. Any MCP client connects, builds motion videos from components and style guidelines, checks its own work (rendered frames + quality report), and exports a finished, still-editable video. It is a startup: we build **one core product**, feature by feature.

This file is the single source of truth for every coding agent (Claude Code, Codex, ChatGPT, Cursor, Copilot, …). Tool-specific notes live in separate files that import this one (`CLAUDE.md`).

Read as needed: [PRODUCT.md](PRODUCT.md) (what and for whom) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how) · [docs/CAPABILITIES.md](docs/CAPABILITIES.md) (engine + MCP surface) · [docs/ROADMAP.md](docs/ROADMAP.md) (order) · [docs/decisions/](docs/decisions/) (why) · [docs/REVIEW.md](docs/REVIEW.md) (review checklist).

## Quick start

```bash
pnpm install
pnpm check      # biome + build + typecheck + test — exactly what CI runs
```

| Command          | What it does                    |
| ---------------- | ------------------------------- |
| `pnpm build`     | Build all packages              |
| `pnpm lint`      | Biome lint + format check       |
| `pnpm format`    | Apply Biome formatting          |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm test`      | Vitest across the workspace     |
| `pnpm check`     | Everything CI runs — must pass  |

Node 24+, pnpm only (never npm/yarn for project deps). Run a single package with `pnpm --filter @kynimo/<name> <script>`.

## How we work with the user

- **Ask, often.** Before starting a feature and at every real fork (API shape, data model, library choice, UX behavior), ask the user. Use your structured question tool if you have one. Put your recommendation first and mark it "(Recommended)".
- **Be decisive.** Give one recommendation with a one-line reason, not a menu. Decide small things yourself and say what you decided.
- **Keep the user informed.** Short status lines as you go: what you're on, what you found, what's next. Report failures plainly with the output.
- **Stay in scope.** No drive-by refactors or bonus features. Note follow-ups instead of doing them.
- **Confirm before outward-facing or hard-to-reverse actions** (merging, force-pushing, deleting branches, publishing, sending content to external services).

## Feature loop (every feature, no exceptions)

1. **Shape.** Restate the feature in 2–3 lines, ask the open questions, agree a short plan. Check the roadmap and relevant ADRs first.
2. **Branch.** `git switch main`, make sure it's current, then `git switch -c feat/<short-slug>` (`fix/…`, `chore/…`, `docs/…` as fits). Never commit to `main` directly.
3. **Build in small steps.** Commit after each working step. Conventional Commits: `feat(scope): …`, `fix(scope): …`, `refactor`, `test`, `docs`, `chore`. Scope = package name (`scene`, `engine`, `mcp`, …). Tests land with the code they cover.
4. **Check.** `pnpm check` must pass.
5. **Review — automatic.** Review the branch diff against [docs/REVIEW.md](docs/REVIEW.md) using a fresh context — a dedicated reviewer subagent/session if your tool has one, otherwise a separate pass after re-reading the full diff. Fix every Blocking and Should-fix item; if you disagree with one, ask the user instead of silently skipping it. Re-review when fixes were substantial. Nits are optional.
6. **Ship the branch.** Commit, `git push -u origin <branch>`, open a PR (`gh pr create`) with: summary, reviewer verdict + what was fixed, how it was tested. **Ask before merging** — the user merges or says "merge".
7. **Record decisions.** If an architectural decision was made or changed, add an ADR in `docs/decisions/` (copy `0000-template.md`) in the same PR. Update `docs/ROADMAP.md` when a milestone item completes.

## Working alongside other agents

Several agents may work in this repo at the same time.

- One branch per task, one task per agent. Don't push to, rebase, or reset a branch you didn't create.
- Prefer a separate git worktree (`git worktree add ../kynimo-<slug> -b feat/<slug> main`) over sharing one checkout.
- Fetch and rebase on `main` before opening a PR. If another PR touched the same files, resolve conflicts yourself and re-run `pnpm check`.
- Don't edit shared config (`biome.json`, `tsconfig.base.json`, `turbo.json`, root `package.json`, CI) unless the task requires it, and say so in the PR.
- Never overwrite or delete uncommitted work you didn't make. If the tree is dirty with changes you don't recognize, stop and ask.

## Architecture invariants (reviewers block on these)

- **Scene graph is the single source of truth.** A versioned JSON document. The MCP server, web app and code all change it through the same typed operations. Never generate free-form code that the scene graph can't represent.
- **Deterministic rendering.** Same document + same frame → same pixels. No `Date.now()`, `Math.random()`, `performance.now()`, locale/timezone formatting, or network in evaluation/render paths. Randomness is seeded from the document.
- **Versioned schema.** Any scene format change bumps `SCENE_FORMAT_VERSION` and ships a migration + test.
- **Typed MCP contracts.** Every tool has schema-validated input and output and is backward compatible. Breaking change → new tool name/version.
- **Sandboxed custom components.** User-authored component code never gets host, filesystem, network or secret access.
- **Quality is enforced, not hoped for.** Guideline rules live in code and produce a machine-readable report agents can act on.

## Code conventions

- TypeScript strict, ESM only. No `any` without a comment explaining why. Prefer pure functions; isolate I/O at the edges.
- Validate external input with schemas at boundaries; trust types inside.
- Tests: Vitest, next to the code as `*.test.ts`. Test behavior, not internals.
- Lint/format: Biome (`pnpm format` to fix). Don't hand-format against it.
- Monorepo: pnpm workspaces + Turborepo. Packages are `@kynimo/<name>` under `packages/`, deployables under `apps/`. Create a new package only when a feature needs it (see the package map in ARCHITECTURE.md).
- Dependencies: justify each new runtime dependency in the PR description; prefer small, well-maintained ones.
- Line endings are LF (`.gitattributes`, `.editorconfig`). Keep scripts cross-platform: the maintainer develops on Windows 11 + PowerShell, CI runs Linux.

## Design work

- Design skills live in `.claude/skills/<name>/SKILL.md` (pinned in `skills-lock.json`). They are plain Markdown plus data files, so any agent can read them directly — open the `SKILL.md` and follow it:
  - **apple-design** — motion, springs, typography, gesture UI
  - **impeccable** — design direction, critique, polish (start at `reference/craft-floor.md`)
  - **ui-ux-pro-max** — searchable UI/UX rules and checklists
- Claude Code loads these natively. Codex-style agents can copy or link them into `.agents/skills/` locally; don't commit a second copy.
- The design language and tokens are created with the user in **Paper** (MCP) and captured in `DESIGN.md`. Until it exists, don't invent a visual identity — ask.
- Motion in Kynimo's _output_ (the videos) follows the guideline packs in `packages/guidelines`; motion in Kynimo's _own UI_ follows `DESIGN.md`.

## Secrets and environment

- Secrets live in `.env` files that are never committed; add an `.env.example` when a feature needs config. Never read, print, or paste `.env*` contents into logs, commits, PRs, or prompts.
- No network access in evaluation/render paths (see invariants).
