import { readFileSync } from "node:fs";
import { migrateProject } from "@kynimo/scene";

/** The title-card reference scene (ADR-0018) and the script that rebuilds it. */
const REFERENCE = new URL("../../../packages/capture/reference/title-card/", import.meta.url);

export const TITLE_CARD_SCRIPT = readFileSync(
  new URL("./fixtures/title-card.script.ts", import.meta.url),
  "utf8",
);

/** The reference document migrated to the current schema. */
export const titleCardReference = () => {
  const result = migrateProject(JSON.parse(readFileSync(new URL("scene.json", REFERENCE), "utf8")));
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.doc;
};

export const titleCardFrames = (): { frame: number; png: Buffer }[] =>
  (
    JSON.parse(readFileSync(new URL("reference.json", REFERENCE), "utf8")) as { frames: number[] }
  ).frames.map((frame) => ({
    frame,
    png: readFileSync(new URL(`frames/${String(frame).padStart(3, "0")}.png`, REFERENCE)),
  }));
