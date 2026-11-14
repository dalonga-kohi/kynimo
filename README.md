# Kynimo

**Motion graphics for your AI agent.**

Kynimo is a motion graphics engine that an AI agent drives over [MCP](https://modelcontextprotocol.io). It runs on your machine as a desktop app. The agent builds a video from layers, keyframes, components, TypeScript or GLSL, looks at the frames it rendered, and exports MP4, WebM or GIF. What you get back is a project you can keep changing, not a flat render.

Website: [kynimo.site](https://www.kynimo.site)

## Status

Private beta, Windows first (November 2026). The engine, the MCP server, frame rendering, video export and the desktop app are built. Style packs and the automated quality report are still in progress, and so are signed installers and macOS and Linux builds. See the [roadmap](docs/ROADMAP.md).

## Try the beta

1. Download `Kynimo-Setup-<version>.exe` from the [latest release](https://github.com/dalonga-kohi/kynimo/releases/latest) and run it. It installs for the current user, with no administrator prompt. The installer is not code signed yet, so Windows SmartScreen asks first: choose "More info", then "Run anyway".
2. Open Kynimo and go to the Connect screen. It shows the local MCP address and copyable setup for Claude Code, Codex, Cursor and Claude Desktop.
3. Ask your agent for a video. Projects, playback and exports show up in the app.

More detail, including where your files live: [apps/desktop/README.md](apps/desktop/README.md).

## What an agent can do with it

- **Build a scene.** Shapes, text, images, video and audio layers, with bezier and spring keyframes, parenting and precomps.
- **Go deep.** Text animators, shape operators, masks and mattes, effects, 2.5D layers with cameras, motion blur and puppet pins.
- **Write code that stays editable.** Scripts, custom components and GLSL shaders enter the scene as typed nodes.
- **See its own work.** Rendered frames and contact sheets come back as images, with a readable summary of the motion.
- **Export.** MP4, WebM or GIF, rendered locally, with a fidelity report.

The full list is in [docs/CAPABILITIES.md](docs/CAPABILITIES.md).

## Run the server without the desktop app

Extract the native bundle for your system and run `kynimo.cmd` on Windows or `./kynimo` on macOS or Linux. Point your MCP client to `http://127.0.0.1:8787/mcp`. See the [local server guide](scripts/local/README.md) for stdio setup and data locations.

To build a bundle from this checkout, run `pnpm install --frozen-lockfile` and `pnpm local:package` on the target platform. The archive is written to `build/local/`.

## Development

Requirements: Node 24+, pnpm 12+.

```bash
pnpm install
pnpm --filter @kynimo/renderer exec playwright install chromium   # once
pnpm check      # lint + build + typecheck + test
```

| Script           | What it does                    |
| ---------------- | ------------------------------- |
| `pnpm build`     | Build all packages              |
| `pnpm lint`      | Biome lint + format check       |
| `pnpm format`    | Apply Biome formatting          |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm test`      | Vitest across the workspace     |
| `pnpm check`     | Everything CI runs              |

## Docs

- Product: [PRODUCT.md](PRODUCT.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Capabilities (engine and MCP surface): [docs/CAPABILITIES.md](docs/CAPABILITIES.md)
- Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md) · plans for the next items: [docs/PLAN.md](docs/PLAN.md)
- Decisions: [docs/decisions/](docs/decisions/)
- Working agreement for AI agents: [AGENTS.md](AGENTS.md) · review checklist: [docs/REVIEW.md](docs/REVIEW.md)

## License

[Apache-2.0](LICENSE). Bundled third-party software (Chromium, FFmpeg and npm packages) keeps its own licenses; the desktop app lists them under Help > Third-party notices.
