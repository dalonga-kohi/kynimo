# 0047 — Built-in components: kinetic type, lower third, logo reveal, transition, background

- Status: accepted
- Date: 2026-11-12

## Context

ADR-0046 gave components a model (typed props, `evaluate`, style-aware, drawn like a precomp) and an empty `BUILT_IN_COMPONENTS`. The first M6 library has to be useful on its own, look right in every guideline pack and share one idea of timing, without a scene format change (components output ordinary layers) and without font metrics, which components do not have.

## Decision

- **Five built-ins at version 1.0.0**, registered in `BUILT_IN_COMPONENTS`, each a pure `evaluate` that returns fully specified scene layers:
  - **`kinetic-type`**: animated text on one text layer with text animators. Variants `rise`, `pop`, `slam`, `typewriter`, `blur`, `cascade`, `scatter`, `wave`. Key props: `text` (`\n` starts a line, no wrapping), `variant`, `unit` (auto, characters, words, lines), `order`, `role` (display, headline, title), `color`, `useHighlight`/`highlight`, `align`, `position`, `stagger`, `textCase`, `scale`, `speed`, `exit`.
  - **`lower-third`**: a title and optional subtitle in a corner. Variants `bar`, `plate`, `underline`, `split`, `minimal`, `outline`. Key props: `title`, `subtitle`, `variant`, `corner`, `width` (fraction of the frame), `titleRole`, `subtitleRole`, `accent`, `plateColor`, `titleColor`, `subtitleColor`, `speed`, `exit`.
  - **`logo-reveal`**: a logo image (`asset` prop) or a wordmark, with an optional tagline. Variants `scale`, `wipe`, `blur`, `iris`, `rise`, `flip`, `glitch`, `stamp`. Key props: `logo`, `wordmark`, `tagline`, `size`, `position`, `variant`, `direction`, `accent`, `glow`, `speed`, `exit` (off by default), `useBackdrop`/`backdrop`.
  - **`transition`**: one component for ten cover transitions, `kind` = `wipe`, `panels`, `iris`, `dip`, `split`, `diagonal`, `blinds`, `shutter`, `circles`, `slide`. Key props: `direction`, `count`, `color`, `secondaryColor`, `origin`, `hold`.
  - **`background`**: generator layers. `kind` = `aurora`, `gradient`, `radial`, `conic`, `noise`, `stripes`, `grid`, `dots`, `checker`, `mesh`. Key props: `colorA` to `colorD` with `useFourth`, `loops`, `angle`, `origin`, `detail`, `seed`, `vignette`, `grain`, `scanlines`.
- **Shared timing (the envelope in `built-in/kit.ts`).** A component enters at the start of its instance (over the `speed` prop's duration token: fast, base or slow) and, with `exit` on, leaves over the last frames (the style's `fast` duration). The exit ends on frame `span - 1`, so the last frame is the end state, and with no exit the last frame is fully entered. The enter and exit together fit in `span - 1` frames: when they don't, both shrink in proportion (one frame at least each) and an exit that still doesn't fit is dropped. A one-frame instance shows its end state. A spring that cannot settle within its window (the scene format needs the next keyframe after it) falls back to the pack's `enter` bezier.
- **Style-aware.** Components take colors as roles (`{ role }` defaults such as `text`, `accent`, `surface`, `background`), type from the pack's type scale (`display`, `headline`, `title`, `body`), sizes from its spacing scale and distances (`small`, `base`, `large`), and durations and easings from its motion tokens. Sizes scale with the composition against the reference size, so the same instance works at 1080p, 4K and vertical. With no pinned pack the host uses Keynote (ADR-0046).
- **`ctx.assetSize(id)`** is added to `ComponentEvalContext`: the pixel size of an image or video asset of the project, or `null`. The host reads it from the document, so logo-reveal can fit a logo into 80% of the frame width without loading pixels.
- **No font metrics in components: estimates, as a known limit.** Components cannot measure text. Kinetic type puts the baseline at 0.35 em below the middle of a single line, moved up by half the extra lines. Logo-reveal estimates a wordmark's width at 0.65 em per glyph and pads its masks. The lower third lays text in a box with `autoFit`, so a long title shrinks to the width instead of overflowing. A wordmark or headline can therefore sit a few pixels off the true optical center; font metrics for components are a follow-up.
- **Transition semantics.** A transition is a cover transition: its shapes sweep over the frame, hide it completely at frame `floor((span - 1) / 2)` of the instance, and uncover it again by the last frame (`hold` keeps it covered around the midpoint for a few frames, shrinking when too long). It draws only its own shapes, so the author cuts the shots at that frame, with the outgoing shot ending and the incoming one starting there. `direction` is the direction of travel of the shapes. It draws at most 600 layers (`circles` is at most 24 × 24 = 576). Instances of one or two frames are covered from frame 0.
- **Background loops.** It runs from the first to the last frame of the instance and drifts `loops` times over it, so a whole number of loops repeats exactly (aurora, gradients, patterns and the mesh's aurora). The noise generator does not repeat (its coordinates drift on), so noise and the mesh's noise overlay do not loop exactly.
- **A component's own `background` is not drawn for a non-root composition** (a nested composition is transparent). Logo-reveal's optional backdrop is therefore a solid layer at the bottom of its stack, not the composition background.
- **Background looks sit on a top adjustment layer.** Vignette, grain and scanlines are effects of one full-frame adjustment layer above the stack, so they apply to the whole composite, the mesh's overlay noise included; with no look on there is no adjustment layer.
- **No scene format change.** Components output existing layers; instances are the existing component layer. The capture page and the MCP service already evaluate instances.

## Alternatives considered

- **One component per transition kind.** Ten near-identical components and catalog entries; one component with a `kind` enum shares the timing and the 600-layer limit.
- **Reveal transitions** (the incoming shot is uncovered by a moving shape). They need the shots beneath the transition as layers they can mask or blend, which a component cannot reach; they belong to shader transitions (the shader library item).
- **Text measurement on the component side** (a font-metrics service in `ctx`). It would need font files and shaping inside `evaluate`; the estimates and `autoFit` are good enough for the first library, and metrics can be added to `ctx` later without breaking components.

## Consequences

- Every built-in renders end to end: a capture test draws each one with default props with no fallbacks, and the reference scene `components` (a logo reveal, a transition that hides the cut, a headline and a lower third over an aurora) is approved frame by frame.
- The MCP capability manifest lists the built-ins' status under `unavailable.components`, which now says only what is still missing (`add_component`, the catalog).
- The host's per-frame `ProjectSchema` parse (ADR-0046) is now measurable on real components.
- Follow-ups:
  - `add_component` (and `build_from_brief`) with write-time prop validation, and the component catalog resource.
  - Font metrics for components, to replace the text estimates.
  - Measure the host's per-frame `ProjectSchema` cost on these components, and revisit `COMPONENT_COST_WEIGHT`.
  - A loop for the noise generator, so a `noise` or `mesh` background loops exactly.
