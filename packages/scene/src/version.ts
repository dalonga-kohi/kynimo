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
 * Policy: every format change bumps the version and ships a migration (see migrations.ts;
 * a test fails if a version has no step). Historically, version 1 stayed open until schema v1
 * part 2 (keyframes, precomp cycle validation) merged, so part 2 widened it without a bump.
 */
export const SCENE_FORMAT_VERSION = 2 as const;

export type SceneFormatVersion = typeof SCENE_FORMAT_VERSION;
