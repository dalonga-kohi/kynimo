import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AuthConfig } from "./auth.js";
import { testIssuer } from "./auth.test-util.js";
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
    const junk = await post(resource.href, "{", { authorization });
    expect(junk.status).toBe(400);
  });

  it("answers 503, not 401, when the issuer's keys are unreachable", async () => {
    const { resource, token } = await start({
      keys: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const res = await post(resource.href, rpc(), { authorization: `Bearer ${await token("a")}` });
    expect(res.status).toBe(503);
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
