# 0002 — Agent-first through a remote MCP server

- Status: accepted (amended by ADR-0008: tool groups and web app scope; amended by ADR-0035: a `review` tool group)
- Date: 2026-11-05

## Context

Kynimo's primary user interface is the user's own AI assistant. MCP is supported by Claude, ChatGPT and most coding agents, and both major chat products can connect to remote MCP servers.

## Decision

The MCP server is the primary product surface. It is remote (Streamable HTTP) with OAuth so any MCP client can connect; a local stdio mode exists for development. Tools come in three groups: intent-level (`build_from_brief`, `apply_style`, `add_component`), precise (`add_layer`, `set_keyframes`, …) and feedback (`render_frames`, `check_quality`, `export`). The web app is a thin companion in v1.

## Consequences

- Tool design and tool output (structured state, rendered frames, quality reports) are core product work, not plumbing.
- Tool contracts must be typed and backward compatible because clients we don't control depend on them.
- We need hosted infrastructure and auth early (M3).
