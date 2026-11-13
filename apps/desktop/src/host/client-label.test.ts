import { describe, expect, it } from "vitest";
import { clientLabel } from "./client-label.js";

describe("clientLabel", () => {
  it.each([
    ["claude-code", "Claude Code"],
    ["Claude-Code-Desktop", "Claude Code"],
    ["Claude Code", "Claude Code"],
    ["codex-mcp-client", "Codex"],
    ["OpenAI Codex", "Codex"],
    ["cursor-vscode", "Cursor"],
    ["Cursor", "Cursor"],
    ["claude-ai", "Claude Desktop"],
    ["Claude Desktop", "Claude Desktop"],
    ["claude", "Claude Desktop"],
    ["  Claude  ", "Claude Desktop"],
    ["my-agent", "my-agent"],
    ["  spaced  ", "spaced"],
    ["x".repeat(60), "x".repeat(40)],
    ["", "An agent"],
    ["   ", "An agent"],
  ])("%j is %j", (name, label) => {
    expect(clientLabel(name)).toBe(label);
  });

  it("is An agent when there is no name", () => {
    expect(clientLabel(undefined)).toBe("An agent");
  });

  it("does not take a longer name that merely starts with claude for Claude Desktop", () => {
    expect(clientLabel("claudette")).toBe("claudette");
  });
});
