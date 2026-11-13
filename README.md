# Kynimo

**Motion graphics that agents create and humans finish.**

Kynimo is an agent-first motion engine that runs on your machine. An assistant connects over MCP to build editable motion videos from components, keyframes, TypeScript or GLSL, check rendered frames, and export a finished video.

**Status (November 2026):** pre-beta. The engine, MCP server, frame rendering and video export are built. The automated quality rules and interactive player are on the [roadmap](docs/ROADMAP.md).

- Product: [PRODUCT.md](PRODUCT.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Capabilities (engine + MCP surface): [docs/CAPABILITIES.md](docs/CAPABILITIES.md)
- Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md) · plans for the next items: [docs/PLAN.md](docs/PLAN.md)
- Decisions: [docs/decisions/](docs/decisions/)
- Working agreement for AI agents (any tool): [AGENTS.md](AGENTS.md) · review checklist: [docs/REVIEW.md](docs/REVIEW.md)

## Run Kynimo locally

Extract the native bundle for your system and run `kynimo.cmd` on Windows or `./kynimo`
on macOS or Linux. Point your local MCP client to `http://127.0.0.1:8787/mcp`.
See the [local server guide](scripts/local/README.md) for stdio setup and data locations.

To build a bundle from this checkout, run `pnpm install --frozen-lockfile` and
`pnpm local:package` on the target platform. The archive is written to `build/local/`.

## Development

Requirements: Node 24+, pnpm 12+.

```bash
pnpm install
pnpm check      # lint + typecheck + test
```

| Script           | What it does                    |
| ---------------- | ------------------------------- |
| `pnpm build`     | Build all packages              |
| `pnpm lint`      | Biome lint + format check       |
| `pnpm format`    | Apply Biome formatting          |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm test`      | Vitest across the workspace     |
| `pnpm check`     | Everything CI runs              |
