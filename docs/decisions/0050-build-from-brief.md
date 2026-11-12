# 0050 — Build an editable storyboard from a brief

- Status: accepted
- Date: 2026-11-12

## Context

ADR-0049 let agents place and validate one built-in component at a time. A brief typically needs several shots. The MCP client interprets the user's request and provides the shot order, copy, asset choices, and durations. Kynimo calculates the exact timing and expands the storyboard locally.

## Decision

- `build_from_brief` accepts 1–24 ordered shots. The supported types are `headline`, `logo` (uploaded image or wordmark), `image`, and `video`. Each shot may carry a lower third. The target is an existing composition, with integer frame durations and an optional start frame. Every shot must fit its composition window.
- The expansion uses ordinary `addLayer` operations and pins the built-in definitions at the versions used by the storyboard recipe. The shared background uses the style's background and surface colors. Typography, timing and the lower-third plate come from the pinned style or the existing Keynote fallback. The caller can omit the shared background with `background: "transparent"`.
- Headline scale is estimated from the display type size, line count and glyph advances against the style's safe margins. Line breaks are preserved. Copy that would need a smaller scale than the kinetic type component supports is rejected with a path to that shot's text.
- Media uses its project asset dimensions to preserve aspect ratio. Contain is the default; Cover crops centrally. Video offsets are measured in composition frames and validated with the engine's exact mapping to source frames. Video shots place the visual track. Sound uses a separate audio layer.
- Hard cuts are the default. An optional wipe is centered on each cut with a span based on the style's fast duration. Its odd span places full cover on the cut. The adjacent shot lengths limit both halves so wipes cannot overlap. An undersized window resolves to a hard cut, reported in the reply.
- The existing intent write path validates and applies the operations as one version. A dry run returns the same planned operations, shot windows and transition windows without writing. A warning identifies when existing soloed layers hide the storyboard. Idempotent retry and undo follow the existing write contract.

## Consequences

Agents can assemble a storyboard in one MCP call from the same structured data they use to plan it. The scene format already represents the result. The brief suite can measure how well agents turn user requests into these inputs.
