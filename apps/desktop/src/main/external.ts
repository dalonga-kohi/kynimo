import type { StdioServerConfig, StudioStatus } from "../shared/api.js";

const REPO = "https://github.com/dalonga-kohi/kynimo";
/** The only URL prefix the app ever opens in the browser. */
export const FEEDBACK_PREFIX = `${REPO}/issues/new?`;

export interface FeedbackInfo {
  appVersion: string;
  /** e.g. "10.0.26200" from os.release(). */
  osVersion: string;
  status: Pick<StudioStatus, "server" | "port" | "error">;
}

/** A pre-filled new-issue URL: what the app is, what the server is doing, and two questions. */
export function feedbackUrl(info: FeedbackInfo): string {
  const { status } = info;
  const server =
    status.server === "running"
      ? `running on port ${status.port ?? "?"}`
      : status.server === "failed"
        ? `failed: ${status.error ?? "unknown error"}`
        : "starting";
  const body = [
    "**What happened**",
    "",
    "",
    "**What you expected**",
    "",
    "",
    "---",
    `Kynimo ${info.appVersion}`,
    `Windows ${info.osVersion}`,
    `Server: ${server}`,
  ].join("\n");
  return `${FEEDBACK_PREFIX}title=${encodeURIComponent("Feedback: ")}&body=${encodeURIComponent(body)}`;
}

export const isFeedbackUrl = (url: string): boolean => url.startsWith(FEEDBACK_PREFIX);

/** The `kynimo` server entry for a client that only starts stdio servers. */
export function stdioServer(execPath: string, bridgePath: string): StdioServerConfig {
  return { command: execPath, args: [bridgePath], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

/** The MCP client config for a client that only starts stdio servers. */
export function stdioConfig(execPath: string, bridgePath: string): string {
  return JSON.stringify({ mcpServers: { kynimo: stdioServer(execPath, bridgePath) } }, null, 2);
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A file name made from an animation's name: no characters Windows rejects, never empty. */
export function sanitizeFileName(name: string): string {
  const cleaned = Array.from(name, (ch) =>
    ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? "-" : ch,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    // Windows drops trailing dots and spaces.
    .replace(/[. ]+$/, "")
    .slice(0, 100)
    .replace(/[. ]+$/, "");
  if (cleaned === "" || /^-+$/.test(cleaned)) return "animation";
  return RESERVED.test(cleaned.split(".")[0] ?? "") ? `${cleaned}_` : cleaned;
}
