import type { StdioServerConfig } from "../../shared/api.js";

export type ClientId = "claude-code" | "codex" | "cursor" | "claude-desktop" | "any";

export interface ClientSnippet {
  id: ClientId;
  label: string;
  /** The small label above the code. */
  codeLabel: string;
  code: string;
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** What to paste into each kind of MCP client, for this server. */
export function clientSnippets(
  endpoint: string,
  stdio: StdioServerConfig | undefined,
): ClientSnippet[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      codeLabel: "Terminal",
      code: `claude mcp add --transport http kynimo ${endpoint}`,
    },
    {
      id: "codex",
      label: "Codex",
      codeLabel: "Terminal",
      code: `codex mcp add kynimo --url ${endpoint}`,
    },
    {
      id: "cursor",
      label: "Cursor",
      codeLabel: "~/.cursor/mcp.json",
      code: json({ mcpServers: { kynimo: { url: endpoint } } }),
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      codeLabel: "claude_desktop_config.json",
      code:
        stdio === undefined
          ? ""
          : json({
              mcpServers: {
                kynimo: { command: stdio.command, args: stdio.args, env: stdio.env },
              },
            }),
    },
    { id: "any", label: "Any client", codeLabel: "Streamable HTTP endpoint", code: endpoint },
  ];
}
