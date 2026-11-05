# 0007 — Web app: Next.js on Vercel

- Status: accepted (amended in place 2026-11-05: milestone numbers updated after the ADR-0008 roadmap restructure)
- Date: 2026-11-05

## Context

We want a public web presence (landing page now, the simple editor in M8) with zero ops and automatic preview deployments that match the branch + PR workflow.

## Decision

- `apps/web` is a Next.js (App Router) app deployed on Vercel via the Vercel GitHub integration: every PR gets a preview deployment, `main` deploys to production.
- Vercel project Root Directory is `apps/web`; `vercel.json` uses `turbo-ignore` so the web app only rebuilds when it or its workspace dependencies change.
- We start on the free Hobby plan.

Vercel project setup (one-time, in the Vercel dashboard):

1. Import `dalonga-kohi/kynimo` from GitHub; set **Root Directory** to `apps/web` (framework auto-detects as Next.js).
2. Environment variable `ENABLE_EXPERIMENTAL_COREPACK=1` (all environments) so Vercel uses pnpm 12 from the root `packageManager` field.
3. Node.js version **24.x** in Project Settings → Build and Deployment.
4. Confirm the first build log shows pnpm 12.16.1 and Node 24.

## Consequences

- Preview URLs for every PR, no infrastructure to run for the web surface.
- **Vercel Hobby is for non-commercial use.** Upgrade to Pro before Kynimo takes payments or launches commercially.
- Render workers (headless Chromium + FFmpeg, long jobs) do not fit Vercel functions; they get their own hosting in M7. Whether the MCP server runs on Vercel is decided in M3.
