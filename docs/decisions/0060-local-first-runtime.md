# 0060 — Local-first MCP runtime

- Status: accepted (supersedes the product defaults in ADR-0002 and ADR-0003)
- Date: 2026-11-13

## Context

Kynimo already serves its engine over stdio and Streamable HTTP. The local file store
supports project versions and serializes writes. Capture uses pinned Chromium and export
uses FFmpeg. A user needs a downloadable server that starts all of this on their machine
without provisioning services. A desktop shell can use the same server later.

## Decision

- The native launcher starts one local account with no sign-in. It binds Streamable HTTP
  to `127.0.0.1:8787` by default. Clients may use stdio when they manage the server process.
  The same scene operations, render pipeline and tool contracts run on either transport.
- Use the existing JSON project store and file-backed blobs and exports in a per-user data
  directory. A data directory has one writer process. Multiple local clients can share it
  through the same HTTP process. The launcher supplies its own media paths and uses no
  hosted configuration from the user's environment.
- Portable archives carry the pinned Node.js and Chromium runtimes and standalone FFmpeg
  and FFprobe. Build and smoke-test each archive on the target OS and architecture.
  Initial targets are Windows x64, macOS Intel and Apple Silicon, and glibc Linux x64 and
  ARM64. Linux still needs Chromium's system libraries.
- The desktop shell can own the launcher process and call the local runtime. OAuth,
  Postgres, S3 and Docker remain available through their existing deployment entry points.

## Consequences

- Kynimo's storage and rendering run on the user's machine. Clients that support a local
  MCP transport can connect. A cloud-only connector needs an endpoint it can reach.
- HTTP preview links are local to the server machine. Users can copy finished video files
  for sharing and long-term storage.
- The archive workflow can verify packages without distributing them. Before public
  distribution, decide Kynimo's usage terms (ADR-0006), verify the third-party distribution
  obligations including the corresponding source for the bundled FFmpeg builds, and verify
  signing and launch behavior on clean machines.
