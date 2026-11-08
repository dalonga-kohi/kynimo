# 0023 — Reference scenes: layout and approval

- Status: accepted (implements ADR-0018's reference scenes for M2)
- Date: 2026-11-08

## Context

ADR-0018 asks for acceptance scenes whose approved PNGs are their golden: CI renders each chosen frame and compares bytes, and a person looks at every PNG that a PR adds or changes. ADR-0022 built the capture path they run on. That left open where the scenes live, what they are written in, how big the frames are and how a frame gets approved.

## Decision

- **Location.** `packages/capture/reference/<scene>/`, next to the capture path they test. If a later milestone (M6 components) needs them in another package, they move then.
- **Plain scene documents.** Each scene is a `scene.json` in the real file format, not a test builder. It stays at the format version it was written in, and the test runs it through `migrateProject`, so the scenes keep exercising migrations as the format grows. Its image and font assets sit in `assets/`, and each asset's `uri` is a path relative to the scene folder, which is how the test finds the bytes.
- **`reference.json`** holds a one-paragraph description of what the scene covers and the chosen frames. The approved frames are `frames/<frame>.png`, with the frame number padded to three digits.
- **640×360.** Big enough to judge type, feathering and edges by eye, and small enough that the four M2 scenes' twelve frames come to about 390 KB.
- **The test** (`src/reference.test.ts`):
  - It renders every listed frame in the pinned Chromium and compares the PNG bytes exactly with the approved file. On a mismatch it writes the new frames to `renders/reference/<scene>/`.
  - A reference frame must render with no skipped layers and no warnings.
  - Scene folders must match the list in the test, and each `frames/` folder must hold exactly the chosen frames, so nothing is dropped or left stale.
- **Approval.** `KYNIMO_UPDATE_GOLDEN=1 pnpm --filter @kynimo/capture test` rewrites the approved PNGs together with the determinism golden. Whoever runs it looks at every changed PNG before committing, and the PR shows it. Bumping a pin (Chromium, CanvasKit, a font) re-approves the frames in the same PR, as ADR-0016 requires.
- **The M2 set:** `title-card`, `masked-matted-reveal`, `nested-precomp-parenting` and `product-card`. Kinetic type (M4), styled scenes (M5) and components (M6) are added by the items that build those features.

## Consequences

- A rendering change that moves any pixel fails CI until someone re-approves the frames, and re-approving means looking at them. That is the point, but a renderer-wide change (a new resampling rule, a CanvasKit bump) will touch every reference PNG.
- The PNGs compare as bytes, so a change in the PNG encoder alone also needs re-approval. The determinism test's `pixelsSha256` tells which of the two moved.
- Byte comparison has no tolerance. If CI's runners ever disagree with the machine that approved the frames, that is ADR-0016's CPU-family caveat, and the fix is pinning the hardware, not loosening the comparison.
- The documents are verbose JSON (every layer spells out every field). Editing them by hand is fine for four scenes. Once the MCP server exists, new scenes can be built through its tools.
