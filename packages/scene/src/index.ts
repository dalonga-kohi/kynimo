/**
 * Version of the Kynimo scene format.
 *
 * Bump this on every schema change and ship a migration from the previous
 * version (see docs/decisions/0001-scene-graph-source-of-truth.md).
 */
export const SCENE_FORMAT_VERSION = 0 as const;

export type SceneFormatVersion = typeof SCENE_FORMAT_VERSION;
