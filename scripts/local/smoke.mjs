import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const windows = process.platform === "win32";
const archive = process.argv[2];
if (!archive) throw new Error("Pass the path to a Kynimo local archive");
const scratch = await mkdtemp(join(tmpdir(), "kynimo local smoke "));
const data = join(scratch, "data");
const env = {
  ...process.env,
  // Starting in this environment must still use the bundle's local data and binaries.
  KYNIMO_DATABASE_URL: "unused",
  KYNIMO_S3_ENDPOINT: "unused",
  KYNIMO_OAUTH_ISSUER: "unused",
  KYNIMO_FFMPEG: "unused",
  KYNIMO_FFPROBE: "unused",
  PORT: "unused",
  PLAYWRIGHT_BROWSERS_PATH: "unused",
};

try {
  execFileSync("tar", ["-xf", resolve(archive), "-C", scratch], { stdio: "inherit" });
  const bundle = join(scratch, (await readdir(scratch))[0]);
  const node = join(bundle, "runtime", windows ? "node.exe" : "node");
  const launcher = join(bundle, "launch.mjs");
  const help = windows
    ? execFileSync("cmd.exe", ["/d", "/c", "kynimo.cmd", "--help"], { cwd: bundle })
    : execFileSync(join(bundle, "kynimo"), ["--help"], { cwd: scratch });
  assert.match(help.toString(), /Kynimo local MCP server/);

  const requireApp = createRequire(join(bundle, "app", "package.json"));
  const { Client } = requireApp("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = requireApp(
    "@modelcontextprotocol/sdk/client/streamableHttp.js",
  );
  const { StdioClientTransport } = requireApp("@modelcontextprotocol/sdk/client/stdio.js");
  const http = spawn(node, [launcher, "--port", "0", "--dir", data], {
    cwd: scratch,
    env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const exited = once(http, "exit");
  let logs = "";
  http.stderr.setEncoding("utf8").on("data", (chunk) => {
    logs += chunk;
  });
  let project;
  const client = new Client({ name: "bundle-smoke", version: "1.0.0" });
  try {
    let endpoint;
    for (let i = 0; i < 300 && http.exitCode === null; i++) {
      endpoint = /ready on (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(logs)?.[1];
      if (endpoint) break;
      await delay(100);
    }
    assert.ok(endpoint, `No loopback endpoint appeared:\n${logs}`);
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "export"));

    const call = async (name, args) => {
      const reply = await client.callTool({ name, arguments: args });
      assert.ok(!reply.isError, `${name}: ${JSON.stringify(reply.content)}`);
      return reply;
    };
    const created = await call("create_project", {
      name: "Bundle smoke",
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
    const png = await call("render_frames", { project_id: project, frames: [0] });
    const image = png.content.find((item) => item.type === "image");
    assert.equal(image?.mimeType, "image/png");
    assert.equal(
      Buffer.from(image.data, "base64").subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
    );
    await call("upload_asset", {
      project_id: project,
      base_version: 2,
      idempotency_key: "upload",
      name: "frame.png",
      id: "rendered-frame",
      data: image.data,
    });

    const job = (
      await call("export", {
        project_id: project,
        format: "mp4",
        idempotency_key: "export",
      })
    ).structuredContent;
    const finished = (
      await call("get_export_status", {
        job_id: job.job_id,
        wait_seconds: 25,
      })
    ).structuredContent;
    assert.equal(finished.state, "succeeded", JSON.stringify(finished));
    assert.equal(new URL(finished.result.url).origin, new URL(endpoint).origin);
    const response = await fetch(finished.result.url);
    assert.equal(response.status, 200);
    const file = Buffer.from(await response.arrayBuffer());
    assert.equal(file.length, finished.result.bytes);
    assert.equal(file.subarray(4, 8).toString(), "ftyp");
    const preview = (await call("get_preview_link", { job_id: job.job_id })).structuredContent;
    const playback = await fetch(preview.url, { headers: { Range: "bytes=0-15" } });
    assert.equal(playback.status, 206);
    assert.deepEqual(Buffer.from(await playback.arrayBuffer()), file.subarray(0, 16));
  } finally {
    await client.close();
    if (http.connected) http.disconnect();
    const timer = setTimeout(() => http.kill(), 10_000);
    const [code] = await exited.finally(() => clearTimeout(timer));
    assert.equal(code, 0, logs);
  }

  const stdio = new Client({ name: "bundle-smoke", version: "1.0.0" });
  try {
    await stdio.connect(
      new StdioClientTransport({
        command: node,
        args: [launcher, "--stdio", "--dir", data],
        cwd: scratch,
        env,
      }),
    );
    const reply = await stdio.callTool({ name: "get_project", arguments: { project_id: project } });
    assert.ok(!reply.isError, JSON.stringify(reply.content));
    assert.equal(reply.structuredContent.name, "Bundle smoke");
    const assets = await stdio.callTool({
      name: "list_assets",
      arguments: { project_id: project },
    });
    assert.ok(!assets.isError, JSON.stringify(assets.content));
    assert.equal(assets.structuredContent.assets[0].id, "rendered-frame");
  } finally {
    await stdio.close();
  }

  // A desktop parent may quit before the engine finishes opening its store and media tools.
  const starting = spawn(node, [launcher, "--port", "0", "--dir", data], {
    cwd: scratch,
    env,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const stopped = once(starting, "exit");
  starting.disconnect();
  const timer = setTimeout(() => starting.kill(), 10_000);
  const [code] = await stopped.finally(() => clearTimeout(timer));
  assert.equal(code, 0, "Server should shut down if its parent disconnects during startup");
  assert.ok(!(await readdir(data)).includes(".lock"), "Shutdown should release the data lock");
  process.stdout.write("Bundle passed MCP, script, PNG, MP4 playback, and persistence checks.\n");
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 5 });
}
