import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

type Json = unknown;

/**
 * Drops what zod's JSON Schema output spends bytes on without telling a client anything:
 * - `minimum: -2^53+1` / `maximum: 2^53-1`, which zod adds to every `.int()`; `type: "integer"` stays;
 * - `$schema` on every tool schema; the listing has no tuples, `$ref`s or `definitions`, so every
 *   keyword it uses means the same under draft-07 and MCP's default dialect (2020-12);
 * - `additionalProperties: {}`, which allows anything, the same as leaving it out.
 * The server still validates every input against the full zod schema.
 */
export function compactJsonSchema(node: Json): Json {
  if (Array.isArray(node)) return node.map(compactJsonSchema);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$schema") continue;
    if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === "additionalProperties" && isEmptyObject(value)) continue;
    out[key] = compactJsonSchema(value);
  }
  return out;
}

const isEmptyObject = (v: Json): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0;

const compactListing = (result: ListToolsResult): ListToolsResult => ({
  ...result,
  tools: result.tools.map((tool) => ({
    ...tool,
    inputSchema: compactJsonSchema(
      tool.inputSchema,
    ) as ListToolsResult["tools"][number]["inputSchema"],
    ...(tool.outputSchema === undefined
      ? {}
      : {
          outputSchema: compactJsonSchema(
            tool.outputSchema,
          ) as ListToolsResult["tools"][number]["outputSchema"],
        }),
  })),
});

/**
 * Makes the server answer `tools/list` with compacted schemas. The SDK builds the listing itself
 * when the first tool is registered; this wraps that handler as it is installed, so the listing
 * stays exactly the SDK's apart from the schema bytes. Call it before registering any tool.
 */
export function compactToolListing(server: McpServer): void {
  const low = server.server;
  // The SDK's signature is generic over the request schema; the wrapper only needs to tell
  // tools/list apart and pass every other registration through untouched.
  type Handler = (...args: unknown[]) => unknown;
  const install = low.setRequestHandler.bind(low) as (schema: unknown, handler: Handler) => void;
  const wrapped = (schema: unknown, handler: Handler): void => {
    if (schema !== ListToolsRequestSchema) install(schema, handler);
    else
      install(schema, async (...args) =>
        compactListing((await handler(...args)) as ListToolsResult),
      );
  };
  low.setRequestHandler = wrapped as typeof low.setRequestHandler;
}
