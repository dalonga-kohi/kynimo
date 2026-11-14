import { describe, expect, it } from "vitest";
import { clientSnippets } from "./commands.js";

const ENDPOINT = "http://127.0.0.1:8791/mcp";
const STDIO = {
  command: "C:\\Kynimo\\Kynimo.exe",
  args: ["C:\\Kynimo\\bridge.mjs"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};
const get = (id: string) => {
  const found = clientSnippets(ENDPOINT, STDIO).find((s) => s.id === id);
  if (found === undefined) throw new Error(`no snippet ${id}`);
  return found;
};

describe("clientSnippets", () => {
  it("lists the five clients in order", () => {
    expect(clientSnippets(ENDPOINT, STDIO).map((s) => s.label)).toEqual([
      "Claude Code",
      "Codex",
      "Cursor",
      "Claude Desktop",
      "Any client",
    ]);
  });

  it("builds the Claude Code and Codex commands for the endpoint's port", () => {
    expect(get("claude-code")).toMatchObject({
      codeLabel: "Terminal",
      code: `claude mcp add --transport http kynimo ${ENDPOINT}`,
    });
    expect(get("codex")).toMatchObject({
      codeLabel: "Terminal",
      code: `codex mcp add kynimo --url ${ENDPOINT}`,
    });
  });

  it("builds the Cursor config, pretty-printed with two spaces", () => {
    const cursor = get("cursor");
    expect(cursor.codeLabel).toBe("~/.cursor/mcp.json");
    expect(cursor.code).toBe(
      `{\n  "mcpServers": {\n    "kynimo": {\n      "url": "${ENDPOINT}"\n    }\n  }\n}`,
    );
  });

  it("builds the Claude Desktop config from the stdio bridge", () => {
    const desktop = get("claude-desktop");
    expect(desktop.codeLabel).toBe("claude_desktop_config.json");
    expect(JSON.parse(desktop.code)).toEqual({ mcpServers: { kynimo: STDIO } });
    expect(desktop.code).toContain('\n  "mcpServers": {');
  });

  it("leaves the Claude Desktop config empty until the bridge is known", () => {
    const desktop = clientSnippets(ENDPOINT, undefined).find((s) => s.id === "claude-desktop");
    expect(desktop?.code).toBe("");
  });

  it("gives the bare endpoint for any client", () => {
    expect(get("any")).toMatchObject({ codeLabel: "Streamable HTTP endpoint", code: ENDPOINT });
  });
});
