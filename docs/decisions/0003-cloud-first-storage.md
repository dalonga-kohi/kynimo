# 0003 — Cloud-first project storage

- Status: accepted
- Date: 2026-11-05

## Context

Remote MCP clients (Claude.ai, ChatGPT) run outside the user's machine, so the MCP server must be able to read and write projects without a local browser tab or file system. Rendering also runs server-side.

## Decision

Projects live in the cloud: versioned scene documents in a database, assets/frames/exports in object storage. Local-first sync is out of scope for v1.

## Consequences

- Any MCP client and the web app see the same project instantly.
- Requires auth, per-project access control and storage costs from the start.
- Offline editing is not supported in v1.
