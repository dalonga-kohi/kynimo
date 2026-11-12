import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthConfig } from "./auth.js";
import { testIssuer } from "./auth.test-util.js";
import { ExportFiles } from "./export-files.js";
import { type Caller, createHttpHandler, type HttpOptions, remoteEnv } from "./http.js";
import { createServer } from "./server.js";
import { KynimoService, ServiceRuntime } from "./service.js";
import { MemoryStore } from "./store.js";

const ISSUER = "https://auth.example.com";
const settings = {
  width: 640,
  height: 360,
  fps: { num: 30, den: 1 },
  duration_frames: 60,
  background: null,
};

let issuer: Awaited<ReturnType<typeof testIssuer>>;
beforeAll(async () => {
  issuer = await testIssuer(ISSUER);
});

let open: Server | undefined;
afterEach(async () => {
  const server = open;
  open = undefined;
  if (server) await new Promise((r) => server.close(r));
});

/** Serves the handler on a free loopback port; the resource URL is that port's `/mcp`. */
async function start({
  auth: withAuth = true,
  keys,
  ...rest
}: { auth?: boolean; keys?: AuthConfig["keys"] } & Omit<Partial<HttpOptions>, "auth"> = {}) {
  const store = new MemoryStore();
  const runtime = new ServiceRuntime();
  const callers: Caller[] = [];
  const server = createHttpServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  open = server;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const resource = new URL(`${base}/mcp`);
  const auth: AuthConfig | undefined = !withAuth
    ? undefined
    : {
        resource,
        issuer: ISSUER,
        audience: [resource.href],
        keys: keys ?? issuer.keys,
        requiredScopes: [],
      };
  server.on(
    "request",
    createHttpHandler({
      path: "/mcp",
      auth,
      allowedOrigins: ["https://app.example.com"],
      serve: (caller) => {
        callers.push(caller);
        return createServer(
          new KynimoService(store.forAccount(caller.account), caller.actor, runtime),
        );
      },
      ...rest,
    }),
  );
  const token = (sub: string) => issuer.token({ sub, aud: resource.href });
  const connect = async (bearer?: string) => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(resource, {
        requestInit: bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {},
      }),
    );
    return client;
  };
  return { base, resource, store, callers, token, connect };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { text: string }[];
  return { isError: result.isError === true, body: JSON.parse(first?.text ?? "null") };
};

const rpc = (method = "tools/list") =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} });
const post = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
  });

describe("remote MCP over Streamable HTTP", () => {
  it("serves tools to a signed-in client, scoped to the token's account", async () => {
    const { connect, token, callers } = await start();
    const alice = await connect(await token("alice"));
    const created = await call(alice, "create_project", {
      name: "Alice's",
      idempotency_key: "c",
      ...settings,
    });
    expect(created.isError).toBe(false);
    expect((await call(alice, "list_projects")).body.projects).toHaveLength(1);

    const bob = await connect(await token("bob"));
    expect((await call(bob, "list_projects")).body.projects).toEqual([]);
    const peek = await call(bob, "get_project", { project_id: created.body.id });
    expect(peek).toMatchObject({ isError: true, body: { error: "not_found" } });
    expect(new Set(callers.map((c) => c.account))).toEqual(new Set(["user:alice", "user:bob"]));
    expect(callers.every((c) => c.actor === c.account && c.principal)).toBe(true);
  });

  it("answers 401 with a challenge that points at the resource metadata", async () => {
    const { resource, base } = await start();
    const res = await post(resource.href, rpc());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    );
    const bad = await post(resource.href, rpc(), { authorization: "Bearer nope" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("serves the protected-resource metadata at both well-known paths", async () => {
    const { base, resource } = await start();
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        resource: resource.href,
        authorization_servers: [ISSUER],
      });
    }
  });

  it("refuses foreign browser origins, GET streams and oversized bodies", async () => {
    const { resource, token } = await start({ maxBodyBytes: 1024 });
    const authorization = `Bearer ${await token("alice")}`;
    const foreign = await post(resource.href, rpc(), {
      authorization,
      origin: "https://evil.example.com",
    });
    expect(foreign.status).toBe(403);
    const allowed = await post(resource.href, rpc("ping"), {
      authorization,
      origin: "https://app.example.com",
    });
    expect(allowed.status).toBe(200);
    expect((await fetch(resource.href, { headers: { authorization } })).status).toBe(405);
    const big = await post(resource.href, JSON.stringify({ pad: "x".repeat(2048) }), {
      authorization,
    });
    expect(big.status).toBe(413);
    // Streamed without Content-Length: still a 413, not a reset connection.
    const chunk = new TextEncoder().encode("x".repeat(512));
    const streamed = await fetch(resource.href, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: new ReadableStream({
        start(c) {
          for (let i = 0; i < 8; i++) c.enqueue(chunk);
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(413);
    const junk = await post(resource.href, "{", { authorization });
    expect(junk.status).toBe(400);
  });

  it("answers 503, not 401, when the issuer's keys are unreachable, and reports it", async () => {
    const reported: unknown[] = [];
    const { resource, token } = await start({
      keys: async () => {
        throw new TypeError("fetch failed");
      },
      onError: (e) => reported.push(e),
    });
    const res = await post(resource.href, rpc(), { authorization: `Bearer ${await token("a")}` });
    expect(res.status).toBe(503);
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).cause).toBeInstanceOf(TypeError);
  });

  it("acts for the local account without auth", async () => {
    const { connect, store, callers } = await start({ auth: false });
    const client = await connect();
    await call(client, "create_project", { name: "Local", idempotency_key: "c", ...settings });
    expect((await store.list()).map((p) => p.name)).toEqual(["Local"]);
    expect(callers[0]).toEqual({ account: "local", actor: "local" });
  });
});

describe("remoteEnv", () => {
  const base = {
    KYNIMO_PUBLIC_URL: "https://mcp.example.com/mcp",
    KYNIMO_OAUTH_ISSUER: ISSUER,
  };

  it("defaults the audience to the public URL and reads lists", () => {
    expect(remoteEnv(base)).toEqual({
      resource: new URL("https://mcp.example.com/mcp"),
      issuer: ISSUER,
      audience: ["https://mcp.example.com/mcp"],
      requiredScopes: [],
      allowedOrigins: [],
    });
    const full = remoteEnv({
      ...base,
      KYNIMO_OAUTH_AUDIENCE: "a, b",
      KYNIMO_OAUTH_SCOPES: "kynimo openid",
      KYNIMO_OAUTH_JWKS_URL: "https://auth.example.com/jwks",
      KYNIMO_ALLOWED_ORIGINS: "https://app.example.com",
    });
    expect(full).toMatchObject({
      audience: ["a", "b"],
      requiredScopes: ["kynimo", "openid"],
      jwksUri: new URL("https://auth.example.com/jwks"),
      allowedOrigins: ["https://app.example.com"],
    });
  });

  it("names the variable that is missing or wrong", () => {
    expect(() => remoteEnv({})).toThrow(/KYNIMO_PUBLIC_URL/);
    expect(() => remoteEnv({ KYNIMO_PUBLIC_URL: base.KYNIMO_PUBLIC_URL })).toThrow(
      /KYNIMO_OAUTH_ISSUER/,
    );
    expect(() => remoteEnv({ ...base, KYNIMO_PUBLIC_URL: "http://mcp.example.com/mcp" })).toThrow(
      /https/,
    );
    expect(
      remoteEnv({ ...base, KYNIMO_PUBLIC_URL: "http://localhost:8787/mcp" }).resource.port,
    ).toBe("8787");
    expect(() =>
      remoteEnv({ ...base, KYNIMO_ALLOWED_ORIGINS: "https://app.example.com/x" }),
    ).toThrow(/not an origin/);
  });
});

describe("export downloads", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function saved(format: "mp4" | "gif" = "mp4", body = "not really a video") {
    dir = await mkdtemp(join(tmpdir(), "kynimo-test-http-exports-"));
    const exports = await ExportFiles.open(join(dir, "exports"));
    const source = join(dir, "out.tmp");
    await writeFile(source, body);
    const file = await exports.save(source, `j-${"ab".repeat(16)}`, format);
    return { exports, file };
  }

  it("serves a file by its token with download headers, and HEAD without a body", async () => {
    const { exports, file } = await saved();
    const { base } = await start({ auth: false, exports });
    const res = await fetch(`${base}/exports/${file.token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("not really a video");
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "video/mp4",
      "content-length": "18",
      "content-disposition": `attachment; filename="kynimo-j-${"ab".repeat(16)}.mp4"`,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    });
    const head = await fetch(`${base}/exports/${file.token}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("18");
    expect(await head.text()).toBe("");
    // Needs no sign-in: the token is the capability.
    const withAuth = await start({ exports });
    expect((await fetch(`${withAuth.base}/exports/${file.token}`)).status).toBe(200);
  });

  it("answers 404 for unknown or malformed tokens and 405 for other methods", async () => {
    const { exports, file } = await saved("gif");
    const { base } = await start({ auth: false, exports });
    for (const path of [
      `/exports/${"A".repeat(43)}`,
      "/exports/short",
      `/exports/${file.token}/x`,
      "/exports/",
    ]) {
      const res = await fetch(`${base}${path}`);
      expect([path, res.status]).toEqual([path, 404]);
      expect(await res.json()).toEqual({ error: "not found" });
    }
    const post = await fetch(`${base}/exports/${file.token}`, { method: "POST", body: "x" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
    expect((await fetch(`${base}/exports/${file.token}`)).headers.get("content-type")).toBe(
      "image/gif",
    );
  });

  it("answers 404, not a crash, when the file was removed underneath", async () => {
    const { exports, file } = await saved();
    const { base } = await start({ auth: false, exports });
    await unlink(file.file);
    const res = await fetch(`${base}/exports/${file.token}`);
    expect(res.status).toBe(404);
    // The server still answers.
    expect((await fetch(`${base}/exports/${file.token}`, { method: "HEAD" })).status).toBe(404);
  });

  it("is a plain 404 when the server has no export storage", async () => {
    const { exports, file } = await saved();
    const { base } = await start({ auth: false });
    expect((await fetch(`${base}/exports/${file.token}`)).status).toBe(404);
    expect(exports.lookup(file.token)).toBeDefined();
  });
});
