import { createLocalJWKSet } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AuthConfig,
  AuthUnavailable,
  accountForSubject,
  authenticate,
  bearerToken,
  challenge,
  discoverJwksUri,
  metadataUrl,
  resourceMetadata,
} from "./auth.js";
import { testIssuer } from "./auth.test-util.js";

const ISSUER = "https://auth.example.com";
const RESOURCE = new URL("https://mcp.example.com/mcp");

describe("authenticate", () => {
  let issuer: Awaited<ReturnType<typeof testIssuer>>;
  let config: AuthConfig;
  beforeAll(async () => {
    issuer = await testIssuer(ISSUER);
    config = {
      resource: RESOURCE,
      issuer: ISSUER,
      audience: [RESOURCE.href],
      keys: issuer.keys,
      requiredScopes: [],
    };
  });
  const check = (token: string, c: AuthConfig = config) => authenticate(c, `Bearer ${token}`);

  it("accepts a token for this resource and returns its subject, client and scopes", async () => {
    const token = await issuer.token({
      sub: "user_1",
      aud: RESOURCE.href,
      scope: "kynimo openid",
      client_id: "claude",
    });
    expect(await check(token)).toEqual({
      ok: true,
      principal: { subject: "user_1", clientId: "claude", scopes: ["kynimo", "openid"] },
    });
  });

  it("asks for a token when there is none, and rejects a malformed header", async () => {
    expect(await authenticate(config, undefined)).toEqual({
      ok: false,
      status: 401,
      description: "this server needs an OAuth access token",
    });
    expect(await authenticate(config, "Basic abc")).toMatchObject({
      status: 401,
      error: "invalid_request",
    });
  });

  it.each([
    ["expired", { exp: Math.floor(Date.now() / 1000) - 3600 }, "the token has expired"],
    ["for another resource", { aud: "https://other.example.com/mcp" }, "another resource"],
    ["from another issuer", { iss: "https://evil.example.com" }, "another authorization server"],
    ["without a subject", { sub: undefined }, "sub"],
  ])("rejects a token %s", async (_, claims, message) => {
    const token = await issuer.token({ sub: "user_1", aud: RESOURCE.href, ...claims });
    const result = await check(token);
    expect(result).toMatchObject({ ok: false, status: 401, error: "invalid_token" });
    expect(result.ok ? "" : result.description).toContain(message);
  });

  it("rejects a token signed by another key, and one that is not a JWT", async () => {
    const other = await testIssuer(ISSUER);
    const forged = await other.token({ sub: "user_1", aud: RESOURCE.href });
    expect(await check(forged)).toMatchObject({ status: 401, error: "invalid_token" });
    expect(await check("not.a.jwt")).toMatchObject({ status: 401, error: "invalid_token" });
  });

  it("refuses an unsigned token", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const exp = Math.floor(Date.now() / 1000) + 600;
    const none = `${enc({ alg: "none" })}.${enc({ sub: "u", aud: RESOURCE.href, iss: ISSUER, exp })}.`;
    expect(await check(none)).toMatchObject({ status: 401, error: "invalid_token" });
  });

  it("answers 403 insufficient_scope when a required scope is missing", async () => {
    const strict = { ...config, requiredScopes: ["kynimo"] };
    const token = await issuer.token({ sub: "user_1", aud: RESOURCE.href, scope: "openid" });
    expect(await check(token, strict)).toMatchObject({
      ok: false,
      status: 403,
      error: "insufficient_scope",
    });
    const scp = await issuer.token({ sub: "user_1", aud: RESOURCE.href, scp: ["kynimo"] });
    expect(await check(scp, strict)).toMatchObject({ ok: true });
  });

  it("throws AuthUnavailable when the issuer's keys can't be fetched", async () => {
    const down = {
      ...config,
      keys: async () => {
        throw new TypeError("fetch failed");
      },
    };
    const token = await issuer.token({ sub: "user_1", aud: RESOURCE.href });
    await expect(check(token, down)).rejects.toBeInstanceOf(AuthUnavailable);
  });
});

describe("protected resource metadata", () => {
  const config: AuthConfig = {
    resource: RESOURCE,
    issuer: ISSUER,
    audience: [RESOURCE.href],
    keys: createLocalJWKSet({ keys: [] }),
    requiredScopes: ["kynimo"],
  };

  it("lives at the well-known path with the resource path appended", () => {
    expect(metadataUrl(RESOURCE).href).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(metadataUrl(new URL("https://mcp.example.com/")).href).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    );
  });

  it("names the resource and its authorization server", () => {
    expect(resourceMetadata(config)).toEqual({
      resource: "https://mcp.example.com/mcp",
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["kynimo"],
      resource_name: "Kynimo",
    });
  });

  it("points a refused client at the metadata", () => {
    expect(challenge(config, { ok: false, status: 401, description: "x" })).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="kynimo"',
    );
    expect(
      challenge(config, { ok: false, status: 401, error: "invalid_token", description: 'a "b"' }),
    ).toContain('error="invalid_token", error_description="a b"');
  });
});

describe("bearerToken", () => {
  it("reads the token case-insensitively and rejects other schemes", () => {
    expect(bearerToken("bearer abc.def-ghi_")).toEqual({ token: "abc.def-ghi_" });
    expect(bearerToken(undefined)).toEqual({ missing: true });
    expect(bearerToken("Bearer a b")).toHaveProperty("malformed");
  });
});

describe("discoverJwksUri", () => {
  const respond =
    (docs: Record<string, unknown>): typeof fetch =>
    async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const doc = docs[url];
      return doc === undefined
        ? new Response("no", { status: 404 })
        : new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } });
    };

  it("reads the OAuth metadata first, then OpenID discovery", async () => {
    const oauth = respond({
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        issuer: ISSUER,
        jwks_uri: "https://auth.example.com/oauth2/jwks",
      },
    });
    expect((await discoverJwksUri(ISSUER, oauth)).href).toBe(
      "https://auth.example.com/oauth2/jwks",
    );
    const oidc = respond({
      "https://auth.example.com/tenant/.well-known/openid-configuration": {
        issuer: "https://auth.example.com/tenant",
        jwks_uri: "https://auth.example.com/tenant/keys",
      },
    });
    expect((await discoverJwksUri("https://auth.example.com/tenant", oidc)).href).toBe(
      "https://auth.example.com/tenant/keys",
    );
  });

  it("refuses metadata for another issuer and a jwks_uri over http", async () => {
    const wrong = respond({
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://evil.example.com",
        jwks_uri: "https://evil.example.com/jwks",
      },
    });
    await expect(discoverJwksUri(ISSUER, wrong)).rejects.toThrow(/could not discover/);
    const http = respond({
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        issuer: ISSUER,
        jwks_uri: "http://auth.example.com/jwks",
      },
    });
    await expect(discoverJwksUri(ISSUER, http)).rejects.toThrow(/must be https/);
  });
});

describe("accountForSubject", () => {
  it("namespaces subjects so none can be the local account", () => {
    expect(accountForSubject("local")).toBe("user:local");
  });
});
