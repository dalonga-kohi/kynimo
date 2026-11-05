# 0005 — TypeScript monorepo: pnpm + Turborepo + Biome + Vitest

- Status: accepted
- Date: 2026-11-05

## Context

The scene format, engine, renderer, MCP server, workers and web app share types and logic and must evolve together. Development is AI-assisted feature by feature, so fast, uniform checks matter.

## Decision

One TypeScript (strict, ESM) monorepo: pnpm workspaces, Turborepo for task orchestration and caching, Biome for lint and format, Vitest for tests. Libraries live in `packages/` as `@kynimo/<name>`, deployables in `apps/`. Packages are created only when a feature needs them. `pnpm check` is the single gate for CI and for the feature loop.

## Consequences

- Shared types across the whole stack with no publishing step.
- One command checks everything; Turborepo caching keeps it fast as the repo grows.
- Biome replaces ESLint + Prettier; some ESLint-only plugins aren't available.
