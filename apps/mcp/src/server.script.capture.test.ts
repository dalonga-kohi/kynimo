import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaptureRenderer } from "./render.js";
import { TITLE_CARD_SCRIPT, titleCardFrames, titleCardReference } from "./script.test-util.js";
import { createServer } from "./server.js";
import { KynimoService } from "./service.js";
import { MemoryStore } from "./store.js";

/**
 * PLAN item 7 end to end: one script rebuilds the title-card reference scene (ADR-0018), and the
 * project's frames, drawn through render_frames, are the approved PNGs byte for byte. Needs the
 * pinned Chromium, like render.capture.test.ts.
 */
let renderer: CaptureRenderer;
let client: Client;

beforeAll(async () => {
  renderer = new CaptureRenderer();
  const server = createServer(new KynimoService(new MemoryStore(), "agent", { renderer }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
}, 60_000);

afterAll(async () => {
  await renderer?.close();
});

async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const r = (await client.callTool({ name, arguments: args })) as CallToolResult;
  if (r.isError) throw new Error(`${name} failed: ${JSON.stringify(r.content)}`);
  return r;
}

describe("run_script with the capture renderer", () => {
  it("renders the title-card reference frames exactly as approved", async () => {
    const reference = titleCardReference();
    const main = reference.compositions[0];
    if (main === undefined) throw new Error("no composition");
    const created = await call("create_project", {
      name: reference.name,
      idempotency_key: "c",
      width: main.width,
      height: main.height,
      fps: main.fps,
      duration_frames: main.durationFrames,
      background: main.background,
    });
    const project_id = created.structuredContent?.id as string;
    await call("run_script", {
      project_id,
      base_version: 1,
      idempotency_key: "s",
      source: TITLE_CARD_SCRIPT,
    });

    const approved = titleCardFrames();
    const rendered = await call("render_frames", {
      project_id,
      frames: approved.map((f) => f.frame),
      max_size: Math.max(main.width, main.height),
    });
    const images = rendered.content.flatMap((c) => (c.type === "image" ? [c] : []));
    expect(images).toHaveLength(approved.length);
    for (const [i, want] of approved.entries()) {
      const got = Buffer.from(images[i]?.data ?? "", "base64");
      expect(got.equals(want.png), `frame ${want.frame}`).toBe(true);
    }
  }, 60_000);
});
