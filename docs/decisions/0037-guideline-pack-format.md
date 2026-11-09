# 0037 — Guideline pack format and the first four packs

- Status: accepted
- Date: 2026-11-09

## Context

Guidelines are the second pillar and half of Kynimo's answer to "why not Claude Motion" (ADR-0035). The scene format has pinned a pack by id and version since schema v1, but no pack existed. ADR-0035 decided we author the first packs ourselves. M4's intent tools and scripts (ADR-0036) need token names to refer to before M5's rules engine exists, so the format comes first.

## Decision

- **`@kynimo/guidelines`** holds the pack format, the built-in packs and token resolution. It depends only on `@kynimo/scene`.
- **A pack is plain, versioned JSON** validated by `GuidelinePackSchema` (`formatVersion` 1): personality, color, type, layout, motion, rules, sources.
- **Token names are fixed across packs; packs change values only.** Six color roles, six type roles, five durations, four easings (`enter`, `exit`, `move`, `emphasis`), three springs (`gentle`, `snappy`, `bouncy`), three staggers, three distances, five spacings. A preset, component or script written against names works in every pack, and a document restyles by switching packs.
- **Units.** Times are whole milliseconds, converted to frames at the composition's frame rate by one integer-arithmetic function (round half up, a non-zero time is at least one frame). Sizes and distances are pixels at a 1080-pixel reference and scale with the composition's shorter side. Easing tokens are keyframe interpolations (bezier, linear or hold), so a pack can make "enter" a hard cut. Fonts are bundled families only (ADR-0019).
- **Rules are thresholds in data; rule logic is code in the M5 engine.** Every pack sets every rule (ten to start: `readable-hold`, `concurrent-motion`, `text-contrast`, `safe-area`, `min-text-size`, `token-easing`, `token-color`, `entrance-duration`, `flash-rate`, `font-variety`) with a severity, and **every rule cites its sources**. `kynimo-judgment` is a source: it marks a number we chose and haven't yet measured.
- **A pack must pass its own rules.** Validation rejects a pack whose text colors miss its contrast threshold, whose type is under its minimum size, whose base duration is outside its entrance range, or whose type uses more weights than it allows.
- **`personality`** (summary, use for, do, avoid) is guidance for the agent choosing and using a pack. It is not enforcement; only `rules` are.
- **Published versions are immutable.** `BUILT_IN_PACKS` keeps every version ever published, because documents pin them.
- **First packs, all at 0.1.0:** Keynote, Playful SaaS, Editorial, Brutalist. Standards-based thresholds come from WCAG 2.2 (contrast, flashes), EBU R 95 (safe areas) and BBC subtitle reading rates; easing shapes from Material 3 and Carbon. Durations, springs, staggers and concurrency limits are our judgment. They are **drafts**: step 2 of the authoring method (measuring reference videos) and the brief-suite tuning haven't happened, and nobody has yet looked at a frame rendered with them. 1.0.0 needs both, plus the designer critique before public launch.

Open, decided in M5:

- **How documents refer to tokens.** Today a keyframe stores interpolation values, so a token would be expanded when written and a later `apply_style` couldn't tell which keyframes to restyle. Recommended: a `token` interpolation variant and color references in the scene format (a format bump), resolved against the pinned pack in one step before evaluation so the engine stays free of pack data.
- **Custom brand packs** (stored per account, validated by the same schema) and **fonts in packs**. All four packs use Inter because only Inter and Noto Sans are bundled; Editorial wants a serif and Brutalist a mono or grotesque. Bundling two more open-licensed families is the cheapest large gain in how different the packs look.

## Consequences

- Intent tools, presets and the script SDK can take token names from M4 on, with these packs replacing the "small built-in default token set" the roadmap planned for M4.
- A new rule is a pack format change: every pack must set it. That is deliberate, and it means a format bump with a migration for stored custom packs once those exist.
- Fixed token names limit what a pack can express (no fourth spring). Adding a name is additive and needs every built-in pack to supply it.
- The self-check keeps a careless pack edit from making every video fail its own report; it caught a contrast miss in the first Keynote draft.
- Until tokens are referenced from documents, switching packs restyles only what tools re-apply.
