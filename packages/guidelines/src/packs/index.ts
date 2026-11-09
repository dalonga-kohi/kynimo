import type { StyleRef } from "@kynimo/scene";
import type { GuidelinePack } from "../pack.js";
import { brutalist } from "./brutalist.js";
import { editorial } from "./editorial.js";
import { keynote } from "./keynote.js";
import { playfulSaas } from "./playful-saas.js";

/**
 * Every built-in pack version ever published. A document pins `packId` + `version`, so a
 * published version is never edited or removed: a change is a new entry with a higher version.
 */
export const BUILT_IN_PACKS: readonly GuidelinePack[] = [
  keynote,
  playfulSaas,
  editorial,
  brutalist,
];

/** The pack a document's style reference pins, or `undefined` if this build doesn't have it. */
export const findPack = (ref: StyleRef): GuidelinePack | undefined =>
  BUILT_IN_PACKS.find((p) => p.id === ref.packId && p.version === ref.version);

const versionKey = (v: string) => v.split(".").map(Number) as [number, number, number];
const newer = (a: string, b: string) => {
  const [x, y] = [versionKey(a), versionKey(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** The newest version of each built-in pack, in catalog order: what `list_styles` offers. */
export function latestPacks(): GuidelinePack[] {
  const latest = new Map<string, GuidelinePack>();
  for (const pack of BUILT_IN_PACKS) {
    const seen = latest.get(pack.id);
    if (!seen || newer(pack.version, seen.version) > 0) latest.set(pack.id, pack);
  }
  return [...latest.values()];
}

export { brutalist, editorial, keynote, playfulSaas };
