# 0033 — Remote transport (Streamable HTTP) and OAuth

- Status: accepted
- Date: 2026-11-09

## Context

ADR-0002 makes a remote MCP server the product surface. Claude and ChatGPT connect to remote servers over Streamable HTTP and sign users in with OAuth 2.1 as the MCP authorization spec describes: the server is a protected resource that names its authorization server (RFC 9728), and clients register themselves dynamically. Until now `kynimo-mcp` served stdio with one `--actor`, and every store returned every project (ADR-0029 left accounts to this item). Three things had to be settled: who runs the authorization server, how requests map to processes, and how projects are scoped to users.

## Decision

- **Kynimo is only the resource server.** An external authorization server signs users in, registers clients and issues JWT access tokens. Kynimo checks each token's signature against the issuer's JWKS (asymmetric algorithms only), its `iss`, its `aud` (the endpoint's public URL by default, RFC 8707), `exp`/`nbf` with 30 s of clock slack, and optionally required scopes. It stores no passwords, client registrations or tokens. The provider is configuration (`KYNIMO_OAUTH_ISSUER`, keys discovered from RFC 8414 or OpenID metadata, or `KYNIMO_OAUTH_JWKS_URL`); WorkOS AuthKit is the first one, because it supports dynamic client registration and client ID metadata documents. Running our own authorization server (the SDK's `mcpAuthRouter`) would mean owning security-critical token code for no product gain.
- **Refusals follow RFC 6750 and RFC 9728.** No or a bad token: `401` with `WWW-Authenticate: Bearer resource_metadata="…"` (plus `error="invalid_token"` when a token was sent); missing scope: `403 insufficient_scope`. The metadata is served at `/.well-known/oauth-protected-resource/<path>` and at the root form. When the issuer's keys can't be fetched the answer is `503`, not `401`, so a client never discards a good token for our outage.
- **Stateless Streamable HTTP.** Every `POST` builds its own MCP server and transport (about 0.4 ms) and answers with plain JSON; `GET` and `DELETE` (SSE stream, session end) answer `405`. Any process behind a load balancer can serve any request, matching the shared Postgres store. Nothing in the tool surface needs server-initiated messages yet; adding sessions later is additive. The renderer, render and asset caches and FFmpeg slots live in one `ServiceRuntime` per process that every request's `KynimoService` shares.
- **Accounts.** A token's `sub` is the account `user:<sub>` and also the actor for undo history and idempotency keys. Namespacing keeps every subject apart from the local account (`local`), which owns stdio projects and everything stored before this ADR. `MemoryStore` and `PostgresStore` implement `AccountStore`: each instance acts for one account, `forAccount` gives a view for another, and another account's project reads as missing (`not_found`), so ids reveal nothing. Postgres migration 2 adds `kynimo_projects.account` (default `local`, so a build from before accounts keeps working during a rolling deploy) and moves `create_project` keys to a per-account scope. `FileStore` stays single-account: with OAuth the server refuses `--dir`.
- **Request hygiene.** Authentication runs before the body is read; bodies over 12 MB (an 8 MB upload as base64 plus envelope) get `413`. A request with an `Origin` header outside `KYNIMO_ALLOWED_ORIGINS` gets `403` (DNS rebinding); server-side clients send none. The metadata document is public with permissive CORS. TLS is terminated by the hosting proxy.
- **`--no-auth`** serves HTTP as the local account, only on a loopback host, for local testing without an authorization server.

## Consequences

- Any MCP client with OAuth support can connect once the server is deployed (next M3 item: hosting, the issuer's configuration, connecting from Claude and ChatGPT).
- One user is one account. Teams, sharing and an accounts table (mapping issuer + subject to a stable account id, so a provider change keeps projects) come later; switching issuers today would orphan projects.
- All of one user's clients share one undo actor. Per-client actors (from `client_id`) can come later without a format change, but would split existing undo stacks.
- Assets stay content-addressed globally (ADR-0031): one account can only reference another's bytes by already having them.
- Not in this item: presigned upload URLs for larger media (ADR-0031, ADR-0032 deferred them here; they belong with deploy or export, where the bucket is public-facing), rate limits and usage quotas (private beta), CORS for browser-based MCP clients on the endpoint itself, and token revocation checks beyond token lifetime.
