/**
 * Version of the Kynimo scene format.
 *
 * Bump this on every schema change and ship a migration from the previous
 * version (see docs/decisions/0001-scene-graph-source-of-truth.md).
 *
 * 1: first schema (project, assets, compositions, layers, transform, parenting,
 *    markers, render switches, pinned style). Version 0 was a placeholder with no
 *    documents, so there is nothing to migrate from.
 *
 * 2: font assets; text layers must name a bundled family or a font asset (ADR-0019). The step
 *    from 1 spells bundled family names exactly ("inter" → "Inter").
 *
 * 3: drawing layers carry `blendMode`, `matte` and `masks` (ADR-0020). The step from 2 adds
 *    `normal`, `null` and `[]`, which draw exactly as version 2 did.
 *
 * 4: video assets (a frame manifest pinned by hash, size, frame rate, frame count) and video
 *    layers (ADR-0032). Both are new variants, so the step from 3 changes nothing.
 *
 * 5: shape path operators: trim paths, round corners and repeater items (ADR-0034). All three are
 *    new variants, so the step from 4 changes nothing.
 *
 * 6: text animators on text layers (ADR-0038). The step from 5 adds an empty `animators` list,
 *    which draws exactly as version 5 did.
 *
 * Policy: every format change bumps the version and ships a migration (see migrations.ts;
 * a test fails if a version has no step). Historically, version 1 stayed open until schema v1
 * part 2 (keyframes, precomp cycle validation) merged, so part 2 widened it without a bump.
 */
export const SCENE_FORMAT_VERSION = 6 as const;

export type SceneFormatVersion = typeof SCENE_FORMAT_VERSION;
