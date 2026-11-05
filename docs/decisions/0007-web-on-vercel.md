# 0007 — Web app: Next.js on Vercel

- Status: accepted
- Date: 2026-11-05

## Context

We want a public web presence (landing page now, the thin web app in M7) with zero ops and automatic preview deployments that match the branch + PR workflow.

## Decision

- `apps/web` is a Next.js (App Router) app deployed on Vercel via the Vercel GitHub integration: every PR gets a preview deployment, `main` deploys to production.
- Vercel project Root Directory is `apps/web`; `vercel.json` uses `turbo-ignore` so the web app only rebuilds when it or its workspace dependencies change.
- We start on the free Hobby plan.

## Consequences

- Preview URLs for every PR, no infrastructure to run for the web surface.
- **Vercel Hobby is for non-commercial use.** Upgrade to Pro before Kynimo takes payments or launches commercially.
- Render workers (headless Chromium + FFmpeg, long jobs) do not fit Vercel functions; they get their own hosting in M6. Whether the MCP server runs on Vercel is decided in M3.
