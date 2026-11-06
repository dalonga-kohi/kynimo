# Kynimo

**Motion graphics that agents create and humans finish.**

Kynimo is an agent-first, cloud-hosted motion engine. Any MCP-compatible assistant (Claude, ChatGPT, coding agents) connects to Kynimo, builds motion videos from components, keyframes or code (custom components and GLSL shaders) on top of style guidelines, using your own photos, video, vectors and fonts, checks its own work against rendered frames and an automatic quality report, and exports a finished, still-editable video.

- Product: [PRODUCT.md](PRODUCT.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Capabilities (engine + MCP surface): [docs/CAPABILITIES.md](docs/CAPABILITIES.md)
- Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md)
- Decisions: [docs/decisions/](docs/decisions/)
- Working agreement for AI agents (any tool): [AGENTS.md](AGENTS.md) · review checklist: [docs/REVIEW.md](docs/REVIEW.md)

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
