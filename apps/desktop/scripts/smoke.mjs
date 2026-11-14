// Smoke test for the packaged app: dist/win-unpacked/Kynimo.exe holds the exact files the
// installer installs. Launches it with a fresh data folder and drives it over its HTTP endpoint
// and its stdio bridge. Run after pnpm desktop:package: pnpm --filter @kynimo/desktop smoke
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

if (process.platform !== "win32") throw new Error("The desktop smoke test runs on Windows");
const desktop = fileURLToPath(new URL("..", import.meta.url));
const unpacked = join(desktop, "dist", "win-unpacked");
const exe = join(unpacked, "Kynimo.exe");
const bridge = join(unpacked, "resources", "bridge.mjs");
await access(exe).catch(() => {
  throw new Error(`${exe} not found: run pnpm desktop:package first`);
});

const scratch = await mkdtemp(join(tmpdir(), "kynimo desktop smoke "));
const local = join(scratch, "local");
const roaming = join(scratch, "roaming");
await Promise.all([mkdir(local), mkdir(roaming)]);
const env = {
  ...process.env,
  LOCALAPPDATA: local,
  APPDATA: roaming,
  // The packaged app must use its own FFmpeg and Chromium, whatever the environment says.
  KYNIMO_FFMPEG: "unused",
  KYNIMO_FFPROBE: "unused",
  PLAYWRIGHT_BROWSERS_PATH: "unused",
};
delete env.ELECTRON_RUN_AS_NODE;
const desktopDir = join(local, "Kynimo", "desktop");
const endpointFile = join(desktopDir, "endpoint.json");
let failed = false;
const pass = (name) => process.stdout.write(`ok   ${name}\n`);

async function check(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (error) {
    failed = true;
    process.stdout.write(`FAIL ${name}: ${error instanceof Error ? error.message : error}\n`);
  }
}

/** Decodes a non-interlaced 8-bit PNG and returns how many distinct pixels colours it has. */
function distinctColors(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "expected 8-bit PNG");
      assert.equal(data[12], 0, "expected non-interlaced PNG");
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      assert.ok(channels, `unsupported colour type ${data[9]}`);
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    const up = rows[y - 1] ?? Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = up[i];
      const c = i >= channels ? up[i - channels] : 0;
      const p = a + b - c;
      const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      line[i] = (line[i] + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
    }
    rows.push(line);
  }
  const colors = new Set();
  for (const line of rows)
    for (let x = 0; x < width; x++)
      colors.add(line.subarray(x * channels, (x + 1) * channels).join());
  return colors.size;
}

const app = spawn(exe, [], { env, stdio: "ignore", windowsHide: false });
let exited = false;
app.once("exit", () => {
  exited = true;
});

try {
  let endpoint;
  await check("app writes endpoint.json within 60 s", async () => {
    for (let i = 0; i < 600 && !exited; i++) {
      try {
        endpoint = JSON.parse(await readFile(endpointFile, "utf8")).endpoint;
        if (endpoint) return;
      } catch {}
      await delay(100);
    }
    throw new Error(exited ? "the app exited early" : "no endpoint.json appeared");
  });

  if (endpoint) {
    const requireMcp = createRequire(join(desktop, "package.json"));
    const requireSdk = createRequire(requireMcp.resolve("@kynimo/mcp"));
    const { Client } = requireSdk("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = requireSdk(
      "@modelcontextprotocol/sdk/client/streamableHttp.js",
    );
    const client = new Client({ name: "smoke-test", version: "1.0.0" });
    let project;
    const call = async (name, args) => {
      const reply = await client.callTool({ name, arguments: args });
      assert.ok(!reply.isError, `${name}: ${JSON.stringify(reply.content)}`);
      return reply;
    };
    try {
      await check("initialize over HTTP as smoke-test", async () => {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
        assert.ok((await client.listTools()).tools.some((tool) => tool.name === "export"));
      });
      await check("create_project and add a visible layer", async () => {
        const created = await call("create_project", {
          name: "Desktop smoke",
          width: 320,
          height: 180,
          duration_frames: 4,
          idempotency_key: "create",
        });
        project = created.structuredContent.id;
        await call("run_script", {
          project_id: project,
          base_version: 1,
          idempotency_key: "script",
          source:
            'kynimo.composition().add("solid", { name: "Square", color: "#ff8800", width: 40, height: 40 });',
        });
      });
      await check("render one frame: a PNG that is not blank", async () => {
        const reply = await call("render_frames", { project_id: project, frames: [0] });
        const image = reply.content.find((item) => item.type === "image");
        assert.equal(image?.mimeType, "image/png");
        const colors = distinctColors(Buffer.from(image.data, "base64"));
        assert.ok(colors > 1, "the frame is a single colour");
      });
      await check("export a 4-frame mp4 and read its ftyp box", async () => {
        const job = (
          await call("export", { project_id: project, format: "mp4", idempotency_key: "export" })
        ).structuredContent;
        const done = (await call("get_export_status", { job_id: job.job_id, wait_seconds: 25 }))
          .structuredContent;
        assert.equal(done.state, "succeeded", JSON.stringify(done));
        const file = Buffer.from(await (await fetch(done.result.url)).arrayBuffer());
        assert.equal(file.subarray(4, 8).toString(), "ftyp");
      });
    } finally {
      await client.close().catch(() => undefined);
    }

    await check("stdio bridge answers initialize and tools/list", async () => {
      const child = spawn(exe, [bridge], {
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const replies = new Map();
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        try {
          const message = JSON.parse(line);
          if (message.id !== undefined) replies.set(message.id, message);
        } catch {}
      });
      let errors = "";
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        errors += chunk;
      });
      try {
        const send = (message) =>
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
        send({
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "smoke-test-bridge", version: "1.0.0" },
          },
        });
        send({ method: "notifications/initialized" });
        send({ id: 2, method: "tools/list", params: {} });
        for (let i = 0; i < 300 && !(replies.has(1) && replies.has(2)); i++) await delay(100);
        assert.ok(replies.has(1) && replies.has(2), `no replies from the bridge. ${errors}`);
        assert.ok(replies.get(1).result?.serverInfo, "initialize had no serverInfo");
        assert.ok(
          replies.get(2).result?.tools?.some((tool) => tool.name === "create_project"),
          "tools/list had no create_project",
        );
      } finally {
        child.stdin.end();
        const timer = setTimeout(() => child.kill(), 10_000);
        await once(child, "exit").finally(() => clearTimeout(timer));
      }
    });

    await check("activity.json records smoke-test and the project's creator", async () => {
      let activity;
      // The log is written a moment after a change.
      for (let i = 0; i < 50; i++) {
        try {
          activity = JSON.parse(await readFile(join(desktopDir, "activity.json"), "utf8"));
          if (project && activity.projects[project]?.createdBy) break;
        } catch {}
        await delay(200);
      }
      assert.ok(activity, "no activity.json was written");
      assert.ok(activity.clients["smoke-test"], JSON.stringify(activity.clients));
      assert.equal(activity.projects[project]?.createdBy, "smoke-test");
    });
  }

  await check("closing the window quits the app and removes endpoint.json", async () => {
    // Without /F this sends WM_CLOSE, like the close button.
    execFileSync("taskkill", ["/PID", String(app.pid)], { stdio: "ignore" });
    const timer = setTimeout(() => {
      try {
        execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {}
    }, 10_000);
    if (!exited) await once(app, "exit").finally(() => clearTimeout(timer));
    clearTimeout(timer);
    assert.ok(
      !(await readdir(desktopDir)).includes("endpoint.json"),
      "endpoint.json is still there",
    );
  });
} finally {
  if (!exited) {
    try {
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

if (failed) process.exit(1);
process.stdout.write("Packaged app passed every check.\n");
