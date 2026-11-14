# Kynimo — Plans for the next items

How the next roadmap items are meant to be built. [ROADMAP.md](ROADMAP.md) owns the order; this file owns the approach. A plan here is a starting point for the "Shape" step of the feature loop, not a decision: decisions land as ADRs. Delete a section when its item merges.

## Local distribution (M3, last item)

Goal: a user downloads an archive, runs the local server and rebuilds a reference scene
from their MCP client (ADR-0060).

1. Build and smoke-test each native archive, including rendering and export from a fresh extraction.
2. Decide usage terms and verify third-party notices and corresponding sources before public distribution.
3. Verify the public package launch on clean Windows, macOS and Linux machines and document local client setup.
4. Use the same server process as the backend for a desktop shell.

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
