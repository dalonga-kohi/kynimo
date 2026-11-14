/** What a host can observe about one MCP request, without the arguments' contents. */
export interface McpRequestEvent {
  /** Date.now() at receipt: host-side bookkeeping, not a render path. */
  at: number;
  userAgent: string | undefined;
  /** One per JSON-RPC message in the body (batch or single); non-objects are skipped. */
  messages: McpRequestMessage[];
}

export interface McpRequestMessage {
  method: string;
  /** `params.name` when the method is `tools/call`. */
  tool?: string;
  /** `params.arguments.project_id` when it is a string. */
  projectId?: string;
  /** `params.clientInfo.name` when the method is `initialize`. */
  clientName?: string;
  /** `params.clientInfo.version` when the method is `initialize`. */
  clientVersion?: string;
}

/** Most messages read from one batch. */
export const MAX_DESCRIBED_MESSAGES = 100;
/** Longest string kept; longer ones are cut. */
export const MAX_DESCRIBED_CHARS = 200;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const clip = (v: unknown): string | undefined =>
  typeof v === "string" ? v.slice(0, MAX_DESCRIBED_CHARS) : undefined;

/**
 * Summarises a parsed request body for an observer. Defensive: the body is untrusted and may be
 * anything. Reads at most the first 100 messages of a batch and cuts strings at 200 characters.
 */
export function describeRequest(body: unknown): McpRequestMessage[] {
  const items = Array.isArray(body) ? body.slice(0, MAX_DESCRIBED_MESSAGES) : [body];
  const messages: McpRequestMessage[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const method = clip(item.method);
    if (method === undefined) continue;
    const message: McpRequestMessage = { method };
    const params = isRecord(item.params) ? item.params : undefined;
    if (params) {
      if (item.method === "tools/call") {
        const tool = clip(params.name);
        if (tool !== undefined) message.tool = tool;
        const args = isRecord(params.arguments) ? params.arguments : undefined;
        const projectId = clip(args?.project_id);
        if (projectId !== undefined) message.projectId = projectId;
      } else if (item.method === "initialize") {
        const info = isRecord(params.clientInfo) ? params.clientInfo : undefined;
        const name = clip(info?.name);
        if (name !== undefined) message.clientName = name;
        const version = clip(info?.version);
        if (version !== undefined) message.clientVersion = version;
      }
    }
    messages.push(message);
  }
  return messages;
}
