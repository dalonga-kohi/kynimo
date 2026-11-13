# 0061 — Desktop app for the private beta

- Status: accepted
- Date: 2026-11-13

## Context

ADR-0060 ships the local server as a portable archive. Beta testers need something they can
install on Windows, run without a terminal, and use to see what their agent makes: a window
that shows whether the server is up, how to connect a client, and the animations made so far.
It must run the same server and the same pinned Chromium capture as the archive, so a frame
is the same frame (ADR-0059, ADR-0060).

## Decision

- **Electron is the shell** (`apps/desktop`, Electron 45.3.2, which embeds Node 24.22). The
  renderer is React in a sandboxed window with a strict CSP and no Node access; it talks to main
  through a small typed `window.kynimo` API over IPC.
- **The server runs in a `utilityProcess`** that main forks, started from code with
  `startServer` (`@kynimo/mcp/local`). It binds loopback `8787` to `8797`, then any free port,
  and writes `<dataDir>/desktop/endpoint.json` while it runs. Main passes the packaged FFmpeg
  and Chromium paths in the process environment, so they win over the launching environment.
- **The studio API** (animation list, detail, thumbnails, previews, export, status) is served by
  the host from the same project store the server writes. The renderer loads thumbnails and
  previews through a `kynimo-media:` protocol that main answers by asking the host for a file;
  no path ever comes from a URL.
- **Activity log in `<dataDir>/desktop/`**, outside the project store, so the scene format does
  not change. It records which client made each project and when it last checked a frame. A
  client is labelled by its MCP `clientInfo` name (Claude Code, Codex, Cursor and Claude Desktop
  get their familiar names, anything else its own name up to 40 characters); a missing name
  shows as "An agent" (`client-label.ts`).
- **A stdio bridge, not a second server.** A data directory has one writer (ADR-0060). A client
  that only starts stdio servers runs `Kynimo.exe bridge.mjs` with `ELECTRON_RUN_AS_NODE=1`; the
  bridge forwards JSON-RPC to the running app's HTTP endpoint and starts the app when it is not
  running. `bridge.mjs` is one self-contained file in `resources/`, outside the asar archive.
- **Capture keeps the pinned Playwright Chromium**, separate from Electron's Chromium, in
  `resources/browsers`. Electron is never the capture browser: Electron's Chromium moves with
  Electron releases, and determinism needs the revision the golden files were made with.
- **Packaging.** electron-builder 26.18.0 builds an NSIS installer, `Kynimo-Setup-<version>.exe`,
  from a flat production install (`pnpm deploy`) staged in `apps/desktop/build/stage`. It is an
  assisted wizard with branded art (a welcome and finish page, the Cut K mark, "You're early."),
  per user, no administrator prompt, installing to `%LOCALAPPDATA%\Programs\Kynimo` with a
  desktop and a Start menu shortcut. Uninstalling keeps the data folder. The app code is in
  `app.asar`; everything under `node_modules` is unpacked, because the server's packages read
  and spawn their own files (the script worker, CanvasKit's wasm, fonts, Playwright's driver).
  FFmpeg, FFprobe, Chromium and the licence notices (`resources/notices`, opened from Help) sit
  in `resources/`. A fully custom installer UI is a follow-up.
- **Unsigned, no auto-update.** Testers get the installer from a CI artifact or a shared link
  and see SmartScreen's "unknown publisher" warning on first run. A new beta build is a new
  installer.
- **Feedback goes to GitHub issues**: Help opens a new-issue page with the version, Windows
  version and server state filled in. It is the only URL the app opens in a browser.
- `scripts/` in `apps/desktop` holds the icon and installer art generators (pinned Chromium
  renders them, no new dependencies), `package.mjs`, and `smoke.mjs`, which launches
  `dist/win-unpacked/Kynimo.exe` with a fresh data folder and drives it over HTTP and the bridge.

## Alternatives

- **Tauri with a Node sidecar:** a smaller shell, but the server and Chromium would still ship
  as sidecars, and the team would add Rust to learn and maintain.
- **A second stdio server in the app:** breaks the one-writer rule for the data directory.
- **Electron's Chromium for capture:** one browser instead of two, but frames would depend on
  the Electron version.

## Consequences

- Measured on this build: the installer is 266 MB and the installed app 869 MB (Chromium 274 MB,
  FFmpeg and FFprobe 158 MB, unpacked `node_modules` 71 MB, Electron the rest). Two browsers
  and a full FFmpeg are the cost of one pinned render path.
- Follow-ups: code signing (and SmartScreen reputation), auto-update, macOS and Linux
  installers, persisting user-agent labels for clients that send none, previews longer than
  60 s, trimming the installer (the Playwright FFmpeg and `winldd` that come with the browser
  download, locale files), and a custom installer UI.
