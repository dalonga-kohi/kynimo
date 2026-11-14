/** What the activity feed calls a client that has no name of its own to show. */
export const UNKNOWN_CLIENT = "An agent";

const MAX_LABEL = 40;

/** The name people know a client by, from the `clientInfo.name` it sent on `initialize`. */
export function clientLabel(clientName: string | undefined): string {
  const name = (clientName ?? "").trim();
  if (name === "") return UNKNOWN_CLIENT;
  const lower = name.toLowerCase();
  if (lower.includes("claude-code") || lower === "claude code") return "Claude Code";
  if (lower.includes("codex")) return "Codex";
  if (lower.includes("cursor")) return "Cursor";
  if (lower.includes("claude-ai") || lower.includes("claude desktop") || lower === "claude")
    return "Claude Desktop";
  return name.slice(0, MAX_LABEL);
}
