# Kynimo — Plans for the next items

How the next roadmap items are meant to be built. [ROADMAP.md](ROADMAP.md) owns the order; this file owns the approach. A plan here is a starting point for the "Shape" step of the feature loop, not a decision: decisions land as ADRs. Delete a section when its item merges.

## Deploy (M3, last item)

Goal: a stranger's Claude or ChatGPT connects to a URL, signs in and rebuilds a reference scene.

1. Hosting ADR. The server needs the pinned Chromium, FFmpeg and long-lived processes, so it is a container host, not serverless functions. Managed Postgres and R2 are already decided (ADR-0029, ADR-0031).
2. One Dockerfile for `apps/mcp` with the pinned Chromium and FFmpeg; `/healthz`; graceful shutdown that lets a running render finish.
3. Observability before users: one structured log line per tool call (tool, account, duration, error kind, bytes returned). The brief suite and pricing both read this later.
4. Per-account limits: projects, stored bytes, render seconds per day. Rejections say the limit and the current use.
5. Measure render seconds per frame at 1080p on the host and write it into the ADR. Export pricing and M7 worker sizing depend on that number.
6. Connect from Claude and ChatGPT by hand; record each client's quirks (image results, resource support, listing limits) in `apps/mcp/README.md`.

Open: region, and whether renders share the server process until M7 (recommended: yes, with a concurrency cap).

## Text animators + range selectors (M4)

The feature most launch videos lean on, so it is the first to reach reference-scene quality.

1. Scene (format bump + migration): `animators[]` on text layers; each has a range selector (unit, start, end, offset, shape, ease high/low, order incl. seeded random, reverse, center-out) and animatable properties (position, scale, rotation, opacity, fill, blur, tracking).
2. Engine: pure function from selector + glyph index/count to a 0–1 weight per glyph. Property-test it against hand-computed After Effects cases for each shape.
3. Renderer: per-glyph transforms after shaping, so layout never shifts while animating; tracking is the one property that re-lays out. Glyph work joins the per-frame work budget (same pattern as ADR-0034).
4. Per-glyph blur needs the effect path; if effects haven't landed, the manifest reports it as accepted, not rendered.
5. `describe_motion` summarises an animator as one line ("words fade up, 3-frame stagger"), not per-glyph data.

## Behaviors (M4)

1. One list per property, applied after keyframes in a fixed order. Each behavior is a pure function of (frame, base track, params, seed).
2. Wiggle uses seeded value noise sampled by frame; no accumulated state, so any frame evaluates alone.
3. Follow/link reads another property's resolved value: validate no cycles at op time, like parenting.
4. Inertia needs the base track's velocity at its last keyframe: derive it analytically from the segment, never by sampling earlier frames.

## Intent tools (M4)

The tools agents should reach for first. Each expands to one `apply_ops` batch and returns the ops it produced, so the agent can inspect and adjust.

1. `animate`: layer selector, property, from/to or a named move, duration in seconds, easing or spring by name. Places spring keyframes at settle frames (CAPABILITIES.md, spring note).
2. `apply_preset`: presets are data (name, parameters, op template) in a catalog that is also an MCP resource. Start with about twelve that cover the brief suite: fade-up, scale-in, slide, mask-reveal, typewriter, word-by-word, blur-in, pop, draw-on (trim), count-up, exit pairs.
3. `stagger`: offset, order (index, reverse, center-out, seeded random) and rhythm; works over layers and, through animators, glyphs.
4. `retime`: scale or shift a selection's keyframes; refuses results that break spring settle rules and suggests the fix.
5. A built-in default token set (four durations, four easings, three springs) so results look deliberate before M5 packs exist.
6. Listing budget: move per-tool detail into `get_layer_schema`-style lookups so `tools/list` stays under 60 KB. Rewrite the server instructions to lead with intent tools.

## Brief suite v1 (M4)

1. `apps/evals`: briefs as data (prompt, optional assets, composition size, duration); a runner that starts a local server, connects a model through an MCP client, and stops at a call or token cap.
2. Five briefs: product launch teaser (15 s), feature promo with a screenshot, kinetic quote, logo sting (5 s), social clip with uploaded footage.
3. Report per run, kept as JSON plus a contact sheet per brief: finished or not, tool calls by tool, rejected calls by error kind, tokens, wall time. A summary table compares against the previous report.
4. A person looks at the contact sheets and writes three lines per brief in the PR: what looks wrong, which tool or doc would have prevented it. Those lines feed the next item.
5. Not in CI. The model key comes from `.env` (with an `.env.example`); nothing from a run is committed except reports.

Open: which model and client are the baseline, and whether a second client is run for comparison (recommended: one baseline, a second before beta).

## First pack (M5) — how we author without a designer

1. Collect sources: published motion guidelines (Material, Apple HIG, IBM Carbon, Fluent) and 15–20 reference launch videos we admire.
2. Measure the references frame by frame: entrance and exit durations, overlap between elements, hold time per word, stagger gaps, easing shapes, how many things move at once.
3. Turn measurements into tokens and rules. Every rule has an id, a threshold, a source and a suggested fix op.
4. Run the brief suite with and without the pack. A rule that never fires, or fires on videos that look right, is cut.
5. Build the second pack with a deliberately different personality. Anything that had to change in code rather than data is a pack-format bug.
