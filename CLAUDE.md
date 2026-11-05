# Kynimo — working agreement

Kynimo is an **agent-first, cloud-hosted motion graphics engine**. Any MCP client connects, builds motion videos from components and style guidelines, checks its own work (rendered frames + quality report), and exports a finished, still-editable video. It is a startup: we build **one core product**, feature by feature.

Read as needed: [PRODUCT.md](PRODUCT.md) (what and for whom) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how) · [docs/ROADMAP.md](docs/ROADMAP.md) (order) · [docs/decisions/](docs/decisions/) (why).

## How we work together

- **Ask, often.** Before starting a feature and at every real fork (API shape, data model, library choice, UX behavior), ask with the question tool. Put your recommendation first and mark it "(Recommended)".
- **Be decisive.** Give one recommendation with a one-line reason, not a menu. Decide small things yourself and say what you decided.
- **Keep the user informed.** Short status lines as you go: what you're on, what you found, what's next. Report failures plainly with the output.
- **Stay in scope.** No drive-by refactors or bonus features. Note follow-ups instead of doing them.

## Feature loop (every feature, no exceptions)

1. **Shape.** Restate the feature in 2–3 lines, ask the open questions, agree a short plan. Check the roadmap and relevant ADRs first.
2. **Branch.** `git switch main`, make sure it's current, then `git switch -c feat/<short-slug>` (`fix/…`, `chore/…`, `docs/…` as fits).
3. **Build in small steps.** Commit after each working step. Conventional Commits: `feat(scope): …`, `fix(scope): …`, `refactor`, `test`, `docs`, `chore`. Scope = package name (`scene`, `engine`, `mcp`, …). Tests land with the code they cover.
4. **Check.** `pnpm check` (lint + typecheck + test) must pass.
5. **Review — automatic.** Run the **`reviewer`** subagent (Opus) on the branch diff. Fix every Blocking and Should-fix item; if you disagree with one, ask the user instead of silently skipping it. Re-run the reviewer when fixes were substantial. Nits are optional.
6. **Ship the branch.** Commit, `git push -u origin <branch>`, `gh pr create` with: summary, reviewer verdict + what was fixed, how it was tested. **Ask before merging** — the user merges or says "merge".
7. **Record decisions.** If an architectural decision was made or changed, add an ADR in `docs/decisions/` (copy `0000-template.md`) in the same PR. Update `docs/ROADMAP.md` when a milestone item completes.

## Architecture invariants (the reviewer blocks on these)

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

## Design work

- Use the project skills in `.claude/skills/`: **apple-design** (motion, springs, typography), **impeccable** (design direction, critique, polish), **ui-ux-pro-max** (searchable UI/UX rules and checklists).
- The design language and tokens will be created with the user in **Paper** (MCP) and captured in `DESIGN.md`. Until then, don't invent a visual identity — ask.
- Motion in Kynimo's _output_ (the videos) follows the guideline packs in `packages/guidelines`; motion in Kynimo's _own UI_ follows `DESIGN.md`.

## Environment

- Windows 11 + PowerShell; pnpm only (never npm/yarn for project deps). Node 24.
- Secrets live in `.env` files that are never committed; add an `.env.example` when a feature needs config.
- Main session runs on Sonnet (`.claude/settings.json`); the reviewer runs on Opus.
