import { createRemoteJWKSet, errors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

/**
 * OAuth for the remote server (ADR-0033). Kynimo is only the resource server: an external
 * authorization server signs users in, registers clients and issues JWT access tokens; Kynimo
 * checks each token's signature against the issuer's keys, its issuer, its audience (this
 * resource, RFC 8707) and lifetime, and publishes where to get one (RFC 9728).
 */
export interface AuthConfig {
  /** The MCP endpoint's public URL: the protected resource, and the default token audience. */
  resource: URL;
  /** The authorization server's issuer identifier, exactly as tokens carry it in `iss`. */
  issuer: string;
  /** Accepted `aud` values; a token must name at least one. */
  audience: readonly string[];
  /** The issuer's signing keys. */
  keys: JWTVerifyGetKey;
  /** Scopes every token must carry; empty: any token from the issuer for this audience. */
  requiredScopes: readonly string[];
}

/** Who a valid token speaks for. */
export interface Principal {
  /** The token's `sub`: the user at the authorization server. */
  subject: string;
  /** The OAuth client the token was issued to, when the token names it. */
  clientId?: string;
  scopes: string[];
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | {
      ok: false;
      status: 401 | 403;
      /** RFC 6750 error code; absent when the request carried no token at all. */
      error?: "invalid_request" | "invalid_token" | "insufficient_scope";
      description: string;
    };

/** Signature algorithms accepted: asymmetric only, so a leaked verifier key can't sign. */
const ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "EdDSA",
];

/** Slack for clock drift between the issuer and this server, in seconds. */
const CLOCK_TOLERANCE = 30;

/** Longest `sub` accepted; it becomes part of the account id and the undo actor. */
const MAX_SUBJECT = 200;

/**
 * The account a token's subject owns. Namespaced so no subject can name the local (stdio)
 * account. One subject is one account until accounts get their own table.
 */
export const accountForSubject = (subject: string): string => `user:${subject}`;

const scopesOf = (payload: JWTPayload): string[] => {
  // `scope` is RFC 9068's space-separated string; some issuers send an `scp` array instead.
  const { scope, scp } = payload as { scope?: unknown; scp?: unknown };
  if (typeof scope === "string") return scope.split(" ").filter((s) => s.length > 0);
  if (Array.isArray(scp)) return scp.filter((s): s is string => typeof s === "string");
  return [];
};

/** The bearer token in an `Authorization` header, or why there is none. */
export function bearerToken(
  header: string | undefined,
): { token: string } | { missing: true } | { malformed: string } {
  if (header === undefined || header.trim() === "") return { missing: true };
  const match = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(header);
  if (!match?.[1]) return { malformed: "the Authorization header must be 'Bearer <token>'" };
  return { token: match[1] };
}

/** Checks an `Authorization` header's access token. Never echoes the token. */
export async function authenticate(
  config: AuthConfig,
  header: string | undefined,
): Promise<AuthResult> {
  const bearer = bearerToken(header);
  if ("missing" in bearer)
    return { ok: false, status: 401, description: "this server needs an OAuth access token" };
  if ("malformed" in bearer)
    return { ok: false, status: 401, error: "invalid_request", description: bearer.malformed };
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(bearer.token, config.keys, {
      issuer: config.issuer,
      audience: [...config.audience],
      algorithms: ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE,
      requiredClaims: ["sub", "exp"],
    }));
  } catch (e) {
    // Our side failed (the issuer's keys are unreachable): not the token's fault, so no 401,
    // which would make the client throw a good token away.
    if (
      e instanceof errors.JWKSTimeout ||
      e instanceof errors.JWKSInvalid ||
      !(e instanceof errors.JOSEError)
    )
      throw new AuthUnavailable("the authorization server's signing keys could not be fetched");
    return { ok: false, status: 401, error: "invalid_token", description: tokenProblem(e) };
  }
  const subject = payload.sub;
  if (typeof subject !== "string" || subject.length < 1 || subject.length > MAX_SUBJECT)
    return {
      ok: false,
      status: 401,
      error: "invalid_token",
      description: `the token's subject must be 1 to ${MAX_SUBJECT} characters`,
    };
  const scopes = scopesOf(payload);
  const missing = config.requiredScopes.filter((s) => !scopes.includes(s));
  if (missing.length > 0)
    return {
      ok: false,
      status: 403,
      error: "insufficient_scope",
      description: `the token lacks the scope ${missing.join(" ")}`,
    };
  const { client_id: clientId, azp } = payload as { client_id?: unknown; azp?: unknown };
  const client =
    typeof clientId === "string" ? clientId : typeof azp === "string" ? azp : undefined;
  return {
    ok: true,
    principal: { subject, scopes, ...(client === undefined ? {} : { clientId: client }) },
  };
}

/** Thrown when a token can't be checked for a reason on this side; the server answers 503. */
export class AuthUnavailable extends Error {}

/** A short reason a token was refused, safe to send back: never the token or its claims. */
function tokenProblem(e: errors.JOSEError): string {
  if (e instanceof errors.JWTExpired) return "the token has expired";
  if (e instanceof errors.JWTClaimValidationFailed) {
    if (e.claim === "iss") return "the token was issued by another authorization server";
    if (e.claim === "aud") return "the token is for another resource";
    if (e.claim === "nbf") return "the token is not valid yet";
    return `the token's ${e.claim} claim is invalid`;
  }
  if (e instanceof errors.JWKSNoMatchingKey) return "the token is signed with an unknown key";
  if (e instanceof errors.JWSSignatureVerificationFailed) return "the token's signature is invalid";
  if (e instanceof errors.JOSEAlgNotAllowed) return "the token's signing algorithm is not allowed";
  return "the token is not a valid JWT";
}

/**
 * Where the protected-resource metadata lives (RFC 9728 §3.1): the well-known prefix inserted
 * before the resource's path, so `https://h/mcp` → `https://h/.well-known/oauth-protected-resource/mcp`.
 */
export function metadataUrl(resource: URL): URL {
  const path = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  return new URL(`/.well-known/oauth-protected-resource${path}`, resource.origin);
}

/** The protected-resource metadata document (RFC 9728 §2). */
export function resourceMetadata(config: AuthConfig): Record<string, unknown> {
  return {
    resource: config.resource.href,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    ...(config.requiredScopes.length > 0 ? { scopes_supported: [...config.requiredScopes] } : {}),
    resource_name: "Kynimo",
  };
}

const quote = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

/** The `WWW-Authenticate` challenge for a refused request (RFC 6750 §3, RFC 9728 §5.1). */
export function challenge(config: AuthConfig, refused: Extract<AuthResult, { ok: false }>): string {
  const params = [`resource_metadata=${quote(metadataUrl(config.resource).href)}`];
  if (refused.error) {
    params.push(`error=${quote(refused.error)}`, `error_description=${quote(refused.description)}`);
  }
  if (config.requiredScopes.length > 0)
    params.push(`scope=${quote(config.requiredScopes.join(" "))}`);
  return `Bearer ${params.join(", ")}`;
}

/**
 * The issuer's `jwks_uri`, from its RFC 8414 metadata or, failing that, its OpenID Connect
 * discovery document. Both must name the configured issuer exactly.
 */
export async function discoverJwksUri(issuer: string, fetchFn: typeof fetch = fetch): Promise<URL> {
  const base = new URL(issuer);
  const path = base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${path}`, base.origin),
    new URL(`${base.origin}${path}/.well-known/openid-configuration`),
  ];
  const problems: string[] = [];
  for (const url of candidates) {
    try {
      const res = await fetchFn(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        problems.push(`${url.href}: HTTP ${res.status}`);
        continue;
      }
      const meta = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
      if (meta.issuer !== issuer) {
        problems.push(`${url.href}: names issuer ${JSON.stringify(meta.issuer)}`);
        continue;
      }
      if (typeof meta.jwks_uri !== "string") {
        problems.push(`${url.href}: has no jwks_uri`);
        continue;
      }
      const jwks = new URL(meta.jwks_uri);
      if (jwks.protocol !== "https:" && !isLoopback(jwks.hostname))
        throw new Error(`the issuer's jwks_uri must be https: ${jwks.href}`);
      return jwks;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("the issuer's jwks_uri")) throw e;
      problems.push(`${url.href}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`could not discover the signing keys of ${issuer} (${problems.join("; ")})`);
}

export const isLoopback = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "::1" ||
  hostname === "[::1]" ||
  /^127\.\d+\.\d+\.\d+$/.test(hostname);

/** Keys fetched from `jwksUri`, cached and refreshed by jose when an unknown key id appears. */
export const remoteKeys = (jwksUri: URL): JWTVerifyGetKey =>
  createRemoteJWKSet(jwksUri, { timeoutDuration: 10_000, cooldownDuration: 30_000 });
