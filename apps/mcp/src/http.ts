import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type AuthConfig,
  AuthUnavailable,
  accountForSubject,
  authenticate,
  challenge,
  isLoopback,
  metadataUrl,
  type Principal,
  resourceMetadata,
} from "./auth.js";
import { LOCAL_ACCOUNT } from "./store.js";

/** Who a request acts for: whose projects it sees, and whose undo stack and keys it uses. */
export interface Caller {
  account: string;
  actor: string;
  /** The verified token's principal; absent on a server without auth. */
  principal?: Principal;
}

export interface HttpOptions {
  /** Path of the MCP endpoint, e.g. `/mcp`. */
  path: string;
  /** OAuth settings; undefined: no auth, every request acts for the local account. */
  auth: AuthConfig | undefined;
  /** Builds the MCP server for one request. */
  serve: (caller: Caller) => McpServer;
  /**
   * Origins a browser may call from. A request with an `Origin` header outside this list is
   * refused (DNS rebinding); requests without one (server-side clients) are unaffected.
   */
  allowedOrigins: readonly string[];
  /** Largest request body. Default MAX_BODY_BYTES. */
  maxBodyBytes?: number;
  /** Where unexpected errors are reported; never given tokens or bodies. */
  onError?: (e: unknown) => void;
}

/** Room for an 8 MB `upload_asset` as base64 inside its JSON-RPC envelope. */
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

class TooLarge extends Error {}

/** The request body, refusing more than `max` bytes before reading them all. */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new TooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const send = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

/** A JSON-RPC error with no request id, for failures before the request is read. */
const rpcError = (code: number, message: string) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id: null,
});

/**
 * The remote server's request handler (ADR-0033): stateless Streamable HTTP, so any process can
 * serve any request. Every POST to `path` is authenticated, gets its own MCP server for the
 * caller's account, and is answered with plain JSON. GET and DELETE on `path` (the SSE stream
 * and session end, which stateless servers don't have) answer 405. The protected-resource
 * metadata is served at its well-known paths.
 */
export function createHttpHandler(options: HttpOptions): RequestListener {
  const maxBody = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const onError = options.onError ?? (() => undefined);
  const { auth } = options;
  const metadataPaths = auth
    ? new Set([metadataUrl(auth.resource).pathname, "/.well-known/oauth-protected-resource"])
    : new Set<string>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (auth && metadataPaths.has(url.pathname)) {
      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS")
        return send(res, 405, { error: "method not allowed" }, { allow: "GET" });
      // Public and read-only: browser-based clients may fetch it from any origin.
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        return void res.end();
      }
      return send(res, 200, resourceMetadata(auth), {
        ...cors,
        "cache-control": "public, max-age=3600",
      });
    }
    if (url.pathname !== options.path) return send(res, 404, { error: "not found" });

    const origin = req.headers.origin;
    if (origin !== undefined && !options.allowedOrigins.includes(origin))
      return send(res, 403, rpcError(-32000, `origin ${origin} is not allowed`));
    if (req.method !== "POST")
      return send(res, 405, rpcError(-32000, "this server is stateless: POST only"), {
        allow: "POST",
      });

    let caller: Caller;
    if (auth) {
      const result = await authenticate(auth, req.headers.authorization);
      if (!result.ok)
        return send(res, result.status, rpcError(-32001, result.description), {
          "www-authenticate": challenge(auth, result),
        });
      const account = accountForSubject(result.principal.subject);
      caller = { account, actor: account, principal: result.principal };
    } else {
      caller = { account: LOCAL_ACCOUNT, actor: LOCAL_ACCOUNT };
    }

    let body: unknown;
    try {
      body = JSON.parse((await readBody(req, maxBody)).toString("utf8"));
    } catch (e) {
      if (e instanceof TooLarge) {
        // Stop reading; the client gets its answer without uploading the rest.
        res.setHeader("connection", "close");
        return send(res, 413, rpcError(-32000, `the request is larger than ${maxBody} bytes`));
      }
      return send(res, 400, rpcError(-32700, "the request body is not valid JSON"));
    }

    const server = options.serve(caller);
    // No sessionIdGenerator: a stateless transport, used for this one request.
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof AuthUnavailable) {
        if (!res.headersSent) send(res, 503, rpcError(-32000, e.message), { "retry-after": "5" });
        return;
      }
      onError(e);
      if (!res.headersSent) send(res, 500, rpcError(-32603, "internal server error"));
      else res.destroy();
    });
  };
}

/** Remote settings read from the environment, before the issuer's keys are located. */
export interface RemoteEnv {
  resource: URL;
  issuer: string;
  audience: string[];
  /** Explicit JWKS URL; otherwise discovered from the issuer. */
  jwksUri?: URL;
  requiredScopes: string[];
  allowedOrigins: string[];
}

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const httpsUrl = (name: string, value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a URL, got ${JSON.stringify(value)}`);
  }
  if (url.protocol !== "https:" && !isLoopback(url.hostname))
    throw new Error(`${name} must be an https URL (http only on localhost)`);
  if (url.search !== "" || url.hash !== "")
    throw new Error(`${name} must not have a query or fragment`);
  return url;
};

/**
 * Reads KYNIMO_PUBLIC_URL (the MCP endpoint as clients reach it), KYNIMO_OAUTH_ISSUER and the
 * optional KYNIMO_OAUTH_AUDIENCE, KYNIMO_OAUTH_JWKS_URL, KYNIMO_OAUTH_SCOPES and
 * KYNIMO_ALLOWED_ORIGINS (comma or space separated). Throws with the variable's name.
 */
export function remoteEnv(env: Record<string, string | undefined>): RemoteEnv {
  const publicUrl = env.KYNIMO_PUBLIC_URL;
  const issuer = env.KYNIMO_OAUTH_ISSUER;
  if (!publicUrl) throw new Error("set KYNIMO_PUBLIC_URL to the MCP endpoint's public URL");
  if (!issuer) throw new Error("set KYNIMO_OAUTH_ISSUER to the authorization server's issuer");
  const resource = httpsUrl("KYNIMO_PUBLIC_URL", publicUrl);
  httpsUrl("KYNIMO_OAUTH_ISSUER", issuer);
  const audience = list(env.KYNIMO_OAUTH_AUDIENCE);
  const allowedOrigins = list(env.KYNIMO_ALLOWED_ORIGINS);
  for (const origin of allowedOrigins)
    if (new URL(origin).origin !== origin)
      throw new Error(`KYNIMO_ALLOWED_ORIGINS: ${origin} is not an origin (scheme://host[:port])`);
  return {
    resource,
    issuer,
    audience: audience.length > 0 ? audience : [resource.href],
    ...(env.KYNIMO_OAUTH_JWKS_URL
      ? { jwksUri: httpsUrl("KYNIMO_OAUTH_JWKS_URL", env.KYNIMO_OAUTH_JWKS_URL) }
      : {}),
    requiredScopes: list(env.KYNIMO_OAUTH_SCOPES),
    allowedOrigins,
  };
}
