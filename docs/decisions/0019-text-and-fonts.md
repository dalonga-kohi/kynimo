# 0019 — Text: fonts, shaping and layout

- Status: accepted
- Date: 2026-11-07

## Context

ADR-0016 chose CanvasKit's Paragraph API (HarfBuzz in WASM) for shaping and said its font manager gets only fonts we hand it. It left three things to the M2 text item: how fonts are loaded and pinned, the fallback order, and layout semantics. ADR-0013 put uploaded custom fonts in the beta, pinned by content hash next to the bundled ones, with missing glyphs falling back to a pinned bundled font. Schema v1 already had text layers (point or box, family, weight, size, tracking, leading, alignment, case, auto-fit). But it did not check the family, and it had no way to reference an uploaded font.

## Decision

- **Bundled fonts: Inter and Noto Sans**, as variable TTFs from google/fonts (SIL OFL 1.1). They are checked into `@kynimo/renderer/fonts/` with their licenses and pinned by SHA-256 in `BUNDLED_FONTS`.
  - Inter is the default design face. Noto Sans is the **fallback** and covers Latin, Greek and Cyrillic.
  - The family _names_ live in `@kynimo/scene` (`BUNDLED_FONT_FAMILIES`), because documents depend on them. Adding a family is additive. Removing or renaming one is a breaking format change.
  - CJK, emoji and other scripts are not bundled. Their size (15 MB and up) is not worth it before users ask. Those characters draw as missing-glyph boxes and are reported, and a font asset that covers them fixes it.
- **Font assets (scene format v2).** A new `font` asset pins a TrueType or OpenType file by hash. It has a `family` and a `weight: { min, max }` range: one weight for a static font, the `wght` axis range for a variable one.
  - A text layer's `font.family` must name a bundled family or a font asset of the project, matched exactly (case included).
  - A font asset may not reuse a bundled family name, compared ignoring case. Two assets of one family may not cover overlapping weights; one file may serve two disjoint ranges.
  - The 1 → 2 migration corrects bundled names spelled in another case ("inter" → "Inter"). Any other unknown family fails validation with a message listing the bundled and uploaded families, and a "did you mean" when only the case differs. Substituting a font silently would change the design.
- **`FontLibrary`**, the font twin of `ImageLibrary` (ADR-0017). Hosts hand it bytes: bundled files from the package, uploaded files from the asset store (M3). Every add checks the hash pin. It also checks the format by signature: WOFF, WOFF2 and `.ttc` collections are refused, each with a specific message. Files may be at most 32 MiB.
  - Each file is registered with a `TypefaceFontProvider` under a private alias. Skia's own family and style matching never picks a font for us, and system fonts are never consulted.
  - Use one library per document, because font asset families are per document.
- **Weight selection follows CSS Fonts 4.** The file whose range holds the requested weight wins, or else the nearest file in CSS search order. A variable file then gets `wght` set to the requested weight, clamped to its range. `opsz` follows the font size, as with CSS `font-optical-sizing: auto`. Fonts without an axis ignore it.
- **Fallback order: the layer's font, then Noto Sans.** Nothing else.
  - Frame plans carry `warnings` per composition, as they do `skipped`. A `font-fallback` warning lists the characters drawn with Noto Sans. A `missing-glyphs` warning lists the characters no loaded font has.
  - Both come from a character-map lookup, so they are exact and cheap, and agents can act on them (ADR-0018). They describe the layer's content, not one frame's ink: characters in lines a box hides are reported too.
- **Layout (CanvasKit Paragraph).**
  - **Tracking** is in thousandths of an em: `letterSpacing = tracking / 1000 × size`.
  - **Leading** is baseline to baseline, `leading × size`. A forced strut makes every line exactly that tall, fallback glyphs included.
  - **Case** uses locale-independent `toUpperCase` / `toLowerCase`, so `ß` becomes `SS` and the result doesn't depend on the host's locale.
  - Tabs become spaces. Text direction is LTR, with bidi runs reordered within lines.
  - **Point text:** the layer origin is on the first line's baseline. It sits at the left edge, the center or the right edge of each line, by alignment. Lines break only at newlines (layout width is unbounded), and `justify` acts as `left`, as in After Effects.
  - **Box text:** the origin is the box's top-left corner. Lines wrap to the box width. Lines that don't fit the box height are **hidden whole**, as in After Effects, and `justify` justifies every line but the last.
  - **Auto-fit is shrink-only.** It reduces the size until every line fits the height and no word breaks mid-word. Tracking and leading are relative, so they scale with it. The search is a fixed 12-step bisection between 1/64 and 1, so the chosen size is deterministic. Text that already fits keeps its size. Text that doesn't fit even at 1/64 is clipped like a plain box.
- **Raster.** Text is a vector layer: it rasterizes in composition space with its transform applied (ADR-0016). This replaces the `skipped: text` entry of ADR-0017.
  - CanvasKit 0.42 doesn't expose the typeface of shaped runs, so exact glyph bounds aren't available. The raster covers the line boxes padded by one em. After drawing, fully transparent edges are trimmed, so the compositor uploads only ink.
  - The padded size counts against the frame's raster budget before it is allocated.

## Consequences

- Text renders deterministically from pinned bytes. The text tests check repeat runs and a fresh CanvasKit instance. Golden hashes come with the "headless capture" item, as for shapes.
- Ink that reaches more than one em outside its line box is clipped, for example a heavy stack of combining marks. Real fonts stay well inside that, and exact bounds can replace the padding if CanvasKit exposes run typefaces.
- Auto-fit lays a paragraph out up to 14 times per frame. That is cheap for titles. If long box text gets slow, cache the fitted size per (content, box, font).
- The renderer adds no new dependencies, but its package now ships about 2.9 MB of fonts. Workers load them once per library. Web hosts fetch them lazily, like the CanvasKit WASM.
- Uploaded fonts can declare a weight range the file doesn't really have. A static file declared as 100–900 simply renders at its own weight. The upload tool (M3) should read the file's axes and fill in the range. It should also record license metadata (ADR-0013), which the asset doesn't hold yet. Adding that field is a format change.
- Italic, rich runs, keyframed source text and text animators are additive later: the text layer schema and this layout have room for them (CAPABILITIES §5).
