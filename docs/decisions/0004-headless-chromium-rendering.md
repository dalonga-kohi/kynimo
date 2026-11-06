# 0004 — Headless Chromium rendering for v1

- Status: accepted (amended by ADR-0008: bit-identical output is guaranteed in render workers; the live browser preview is visually equivalent; amended by ADR-0013: drawing is GPU-based, WebGL2)
- Date: 2026-11-05

## Context

Agents need fast preview frames, users need a live browser preview, and exports must match both exactly. A custom native renderer would be faster but would duplicate the drawing code and risk preview/export mismatches.

## Decision

v1 evaluates and draws scenes with browser technology. The same renderer code runs in the web preview and in headless Chromium workers that capture frames; FFmpeg encodes exports.

## Consequences

- What you preview is what you export.
- Deterministic output requires pinned browser versions, bundled fonts and no wall-clock or random inputs.
- Rendering cost per frame is higher than a native renderer; revisit (WebGPU/native) when cost or speed demands it.
