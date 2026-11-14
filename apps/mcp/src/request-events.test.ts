import { describe, expect, it } from "vitest";
import { describeRequest } from "./request-events.js";

describe("describeRequest", () => {
  it("describes a single request", () => {
    expect(
      describeRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_project", arguments: { project_id: "p-1" } },
      }),
    ).toEqual([{ method: "tools/call", tool: "get_project", projectId: "p-1" }]);
  });

  it("reads the client of initialize", () => {
    expect(
      describeRequest({
        method: "initialize",
        params: { clientInfo: { name: "claude", version: "1.2" } },
      }),
    ).toEqual([{ method: "initialize", clientName: "claude", clientVersion: "1.2" }]);
  });

  it("describes every message of a batch and skips non-objects", () => {
    expect(
      describeRequest([{ method: "ping" }, 5, null, "x", [], { method: "tools/list" }]),
    ).toEqual([{ method: "ping" }, { method: "tools/list" }]);
  });

  it("returns nothing for a body that is not a request", () => {
    for (const body of [null, undefined, 3, "text", true, {}, { method: 4 }])
      expect(describeRequest(body)).toEqual([]);
  });

  it("tolerates missing or malformed params", () => {
    expect(describeRequest({ method: "tools/call" })).toEqual([{ method: "tools/call" }]);
    expect(describeRequest({ method: "tools/call", params: "no" })).toEqual([
      { method: "tools/call" },
    ]);
    expect(describeRequest({ method: "tools/call", params: { name: 7, arguments: [] } })).toEqual([
      { method: "tools/call" },
    ]);
  });

  it("ignores a project_id that is not a string", () => {
    expect(
      describeRequest({
        method: "tools/call",
        params: { name: "get_project", arguments: { project_id: 12 } },
      }),
    ).toEqual([{ method: "tools/call", tool: "get_project" }]);
  });

  it("cuts long strings at 200 characters", () => {
    const [message] = describeRequest({
      method: "tools/call",
      params: { name: "t".repeat(500), arguments: { project_id: "p".repeat(500) } },
    });
    expect(message?.tool).toHaveLength(200);
    expect(message?.projectId).toHaveLength(200);
    expect(describeRequest({ method: "m".repeat(300) })[0]?.method).toHaveLength(200);
  });

  it("reads at most 100 messages of a batch", () => {
    const batch = Array.from({ length: 250 }, (_, i) => ({ method: `m${i}` }));
    const messages = describeRequest(batch);
    expect(messages).toHaveLength(100);
    expect(messages[99]?.method).toBe("m99");
  });
});
