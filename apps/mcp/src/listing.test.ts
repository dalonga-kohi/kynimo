import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compactJsonSchema } from "./listing.js";
import { createServer } from "./server.js";
import { KynimoService } from "./service.js";
import { MemoryStore } from "./store.js";

async function listTools() {
  const server = createServer(new KynimoService(new MemoryStore(), "agent"));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return (await client.listTools()).tools;
}

describe("compactJsonSchema", () => {
  it("drops zod's safe-integer bounds, $schema and empty additionalProperties", () => {
    const schema = z.toJSONSchema(
      z.looseObject({ frame: z.number().int(), count: z.number().int().nonnegative() }),
      { target: "draft-7" },
    );
    expect(compactJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        frame: { type: "integer" },
        count: { type: "integer", minimum: 0 },
      },
      required: ["frame", "count"],
    });
  });

  it("keeps real bounds, closed objects and typed additionalProperties", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        n: { type: "integer", minimum: -5, maximum: 9 },
        map: { type: "object", additionalProperties: { type: "string" } },
        list: { type: "array", items: { type: "integer", maximum: Number.MAX_SAFE_INTEGER } },
      },
    };
    expect(compactJsonSchema(schema)).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        n: { type: "integer", minimum: -5, maximum: 9 },
        map: { type: "object", additionalProperties: { type: "string" } },
        list: { type: "array", items: { type: "integer" } },
      },
    });
  });
});

describe("tool listing", () => {
  it("is compacted for every tool, input and output", async () => {
    const listing = JSON.stringify(await listTools());
    expect(listing).not.toContain('"$schema"');
    expect(listing).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(listing).not.toContain('"additionalProperties":{}');
  });

  it("uses no keyword whose meaning differs between draft-07 and 2020-12", async () => {
    // Dropping `$schema` relies on this: MCP reads a schema without one as 2020-12.
    const listing = JSON.stringify(await listTools());
    for (const keyword of ['"items":[', "additionalItems", "definitions", "dependencies", "$ref"])
      expect(listing, keyword).not.toContain(keyword);
  });

  it("keeps each tool within a size cap, so one tool cannot eat the budget unnoticed", async () => {
    for (const tool of await listTools()) {
      const cap = tool.name === "apply_ops" ? 13_000 : 4_500;
      expect(JSON.stringify(tool).length, tool.name).toBeLessThan(cap);
    }
  });
});
