# Kynimo — Plans for the next items

How the next roadmap items are meant to be built. [ROADMAP.md](ROADMAP.md) owns the order; this file owns the approach. A plan here is a starting point for the "Shape" step of the feature loop, not a decision: decisions land as ADRs. Delete a section when its item merges.

## Deploy (M3, last item)

Goal: a stranger's Claude or ChatGPT connects to a URL, signs in and rebuilds a reference scene.

1. Hosting ADR. The server needs the pinned Chromium, FFmpeg and long-lived processes, so it is a container host, not serverless functions. Managed Postgres and R2 are already decided (ADR-0029, ADR-0031).
2. One Dockerfile for `apps/mcp` with the pinned Chromium and FFmpeg; `/healthz`; graceful shutdown that lets a running render finish.
3. Observability before users: one structured log line per tool call (tool, account, duration, error kind, bytes returned). The brief suite and pricing both read this later.
4. Per-account limits: projects, stored bytes, render seconds per day. Rejections say the limit and the current use.
5. Measure render seconds per frame at 1080p on the host and write it into the ADR. Export pricing and M7 worker sizing depend on that number. `node packages/capture/bench/export.mjs` gives it per stage; run it once as is and once with `KYNIMO_GPU=hardware` if the host has a GPU, and choose the backend by cost per exported frame (ADR-0059).
6. Connect from Claude and ChatGPT by hand; record each client's quirks (image results, resource support, listing limits) in `apps/mcp/README.md`.

Open: region, and whether renders share the server process until M7 (recommended: yes, with a concurrency cap).

## Per-glyph text cost (M4 follow-up to ADR-0038)

Animated text draws each cluster as its own paragraph: about 0.25 ms per glyph, so the budgets are 1 000 per layer and 4 000 per frame. A frame of long animated text is near a second, and contact sheets multiply it.

1. Measure first: time a fade, a rise and a tracking animator at 200, 1 000 and 4 000 glyphs, in Node and in the pinned Chromium, and write the numbers into ADR-0038.
2. Candidates, cheapest first:
   - Cache shaped paragraphs by text only and apply color and alpha at draw time (a color filter in a layer), so a fade stops defeating the cache.
   - Draw glyph runs from the full layout's own glyph ids and positions (`drawGlyphs`), which also keeps ligatures and joining. canvaskit 0.42 reports run typefaces as null, so the font per run has to be matched by hand, fallback fonts included.
   - Reuse shaped clusters across frames in the render cache (M7).
3. Constraint: a layer with an active animator must stay pixel-identical to the plain layer when the animator changes nothing visible; the parity tests in `packages/renderer/src/text-animator.test.ts` and the `text-animators` reference frames are the gate. Raise the budgets only with the measured numbers.

## Brief suite v1 (M4)

1. `apps/evals`: briefs as data (prompt, optional assets, composition size, duration); a runner that starts a local server, connects a model through an MCP client, and stops at a call or token cap.
2. Five briefs: product launch teaser (15 s), feature promo with a screenshot, kinetic quote, logo sting (5 s), social clip with uploaded footage.
3. Report per run, kept as JSON plus a contact sheet per brief: finished or not, tool calls by tool, rejected calls by error kind, tokens, wall time. A summary table compares against the previous report.
4. A person looks at the contact sheets and writes three lines per brief in the PR: what looks wrong, which tool or doc would have prevented it. Those lines feed the next item.
5. Not in CI. The model key comes from `.env` (with an `.env.example`); nothing from a run is committed except reports.

Open: which model and client are the baseline, and whether a second client is run for comparison (recommended: one baseline, a second before beta).

## Packs to 1.0.0 (M5, ADR-0037)

The format and four draft packs (0.1.0) exist in `@kynimo/guidelines`. What is left of the authoring method:

1. Collect 15–20 reference launch videos we admire, a few per pack personality.
2. Measure them frame by frame: entrance and exit durations, overlap between elements, hold time per word, stagger gaps, easing shapes, how many things move at once. Replace every `kynimo-judgment` number the measurements contradict; cite the measurement set as a source.
3. A reference scene per pack (same content, four looks), built with tokens only, approved frames looked at (ADR-0018). This is the first time anyone sees the packs.
4. Bundle a serif and a mono family (open licence), then give Editorial and Brutalist their own type.
5. Run the brief suite per pack. A rule that never fires, or fires on videos that look right, is cut or retuned.
6. Publish as 1.0.0; 0.1.0 stays in `BUILT_IN_PACKS` for documents that pinned it.
