# Kynimo for Windows (private beta)

An Electron app that runs the local MCP server (ADR-0060) and shows what agents make: connection
state, the animations in your projects, playback and export. Decisions: [ADR-0061](../../docs/decisions/0061-desktop-app.md).

## Install

Run `Kynimo-Setup-<version>.exe`. It installs for the current user only (no administrator
prompt) into `%LOCALAPPDATA%\Programs\Kynimo`, with Start menu and desktop shortcuts. The
installer is **not code signed**, so Windows SmartScreen shows "Windows protected your PC": choose
"More info", then "Run anyway". Uninstalling keeps your projects.

## Connect a client

Open the Connect screen: it shows the local address (`http://127.0.0.1:8787/mcp`, or the next
free port up to 8797) and copyable setup for Claude Code, Codex, Cursor and Claude Desktop. Help > "Use stdio
instead" gives a config for clients that only start stdio servers; it runs a small bridge in this
app and starts the app if it is closed. The app has one data folder, so a client never starts a
second server.

## Where things live

- Projects, assets and exports: `%LOCALAPPDATA%\Kynimo` (Help > Open projects folder).
- The app's own files (window state, activity log, `endpoint.json` while it runs):
  `%LOCALAPPDATA%\Kynimo\desktop`.
- Licence notices: Help > Third-party notices.
- Feedback: Help > Send feedback opens a GitHub issue with the version and server state filled in.

## Develop

```bash
pnpm --filter @kynimo/desktop dev      # the app with hot reload (uses the PATH's FFmpeg and Playwright's Chromium)
pnpm --filter @kynimo/desktop dev:web  # the screens alone in a browser with mock data, http://localhost:5174
```

`dev:web` switches screens with `?screen=welcome|connect|animations|player|empty`. The stdio bridge
(`out/main/bridge.mjs`) is part of `pnpm --filter @kynimo/desktop build`, not of `dev`.

## Package and test the installer

```bash
pnpm desktop:package                    # dist/Kynimo-Setup-<version>.exe and dist/win-unpacked/
pnpm --filter @kynimo/desktop smoke     # launches dist/win-unpacked/Kynimo.exe and drives it
```

`desktop:package` builds, stages a flat production install, adds the pinned Chromium and the
SHA-verified FFmpeg (cached in `build/cache`), and runs electron-builder. `smoke` uses a fresh
data folder: HTTP endpoint, a rendered frame, an MP4 export, the stdio bridge, the activity log
and a clean close. Both are Windows only. The icon (`pnpm --filter @kynimo/desktop icon`) and
installer art (`installer-art`) are generated and committed.
