# @kynimo/mcp

Kynimo's MCP server. For now it runs locally over stdio; the remote transport comes later in M3. Contracts and decisions: [ADR-0018](../../docs/decisions/0018-agent-reliability-contracts.md), [ADR-0024](../../docs/decisions/0024-local-mcp-server.md).

```bash
pnpm --filter @kynimo/mcp build
node apps/mcp/dist/main.js --dir ~/kynimo-projects   # omit --dir to keep projects in memory
```

To connect an MCP client (e.g. Claude Desktop or Claude Code), point it at the built entry:

```json
{
  "mcpServers": {
    "kynimo": {
      "command": "node",
      "args": [
        "/absolute/path/to/kynimo/apps/mcp/dist/main.js",
        "--dir",
        "/absolute/path/to/projects"
      ]
    }
  }
}
```

Tools: `create_project`, `list_projects`, `get_project`, `get_scene`, `get_layer`, `find_layers`, `get_layer_schema`, `get_write_outcome`, `apply_ops`, `add_layer`, `update_layer`, `set_keyframes`, `undo`, `redo`. Every write takes `base_version` and `idempotency_key`.

One server process owns a `--dir` at a time; a second one on the same folder refuses to start. Give each client its own folder until the shared database store (later in M3).
