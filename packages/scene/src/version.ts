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
 * Policy: version 1 stays open until schema v1 part 2 (keyframes, precomp cycle
 * validation) merges, so part 2 widens it without a bump. After that, every
 * format change bumps the version and ships a migration (see migrations.ts; a test fails
 * if a version has no step).
 */
export const SCENE_FORMAT_VERSION = 1 as const;

export type SceneFormatVersion = typeof SCENE_FORMAT_VERSION;
