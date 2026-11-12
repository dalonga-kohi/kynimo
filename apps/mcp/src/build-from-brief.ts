import { type ComponentStyle, createComponentStyle } from "@kynimo/components";
import { nestedFrame } from "@kynimo/engine";
import { IntentError, resolveStyle } from "@kynimo/intent";
import {
  type Composition,
  ImageLayerSchema,
  type Json,
  type Op,
  type Project,
  VideoLayerSchema,
  withLayerDefaults,
} from "@kynimo/scene";
import { z } from "zod";
import { addComponentExpansion } from "./components.js";
import type { BuildFromBriefRequest } from "./schemas.js";

export const MAX_BRIEF_SHOTS = 24;
const COMPONENT_VERSION = "1.0.0";
const MediaLayerInput = z.discriminatedUnion("type", [
  ImageLayerSchema.omit({ id: true }),
  VideoLayerSchema.omit({ id: true }),
]);

type Brief = z.infer<typeof BuildFromBriefRequest>;
type Shot = Brief["shots"][number];
type Window = { in_frame: number; out_frame: number };
type ShotWindow = Window & { type: Shot["type"] };
type Boundary = { frame: number; type: "cut" } | ({ frame: number; type: "wipe" } & Window);

function headlineScale(text: string, style: ComponentStyle, composition: Composition): number {
  const type = style.type("display");
  const tracking = Math.max(0, type.tracking / 1000);
  const lines = (type.textCase === "upper" ? text.toUpperCase() : text).split(
    /\r\n|[\n\r\u2028\u2029]/,
  );
  // Kinetic type uses point text. Estimate line advances with extra room for wide glyphs,
  // and keep the caller's line breaks. Font measurement belongs to the renderer.
  const widths = lines.map((line) => {
    let width = 0;
    for (const char of line) {
      const advance =
        char === " "
          ? 0.35
          : char === "\t"
            ? 1.4
            : /[MWmw@%&]|[^\x20-\x7e]/.test(char)
              ? 1.1
              : 0.65;
      width += advance + tracking;
    }
    return width * type.size;
  });
  const height = ((lines.length - 1) * type.leading + 1.25) * type.size;
  const safe = 1 - 2 * style.pack.layout.margin;
  return Math.min(
    1,
    (composition.width * safe) / Math.max(...widths),
    (composition.height * safe) / height,
  );
}

function mediaOperation(
  doc: Project,
  composition: Composition,
  shot: Extract<Shot, { type: "image" | "video" }>,
  window: Window,
  index: number,
): Op {
  const asset = doc.assets.find((entry) => entry.id === shot.asset_id);
  if (asset?.type !== shot.type)
    throw new IntentError(
      ["shots", index, "asset_id"],
      `'${shot.asset_id}' must be an uploaded ${shot.type} asset in this project`,
    );

  const offset = shot.type === "video" ? (shot.source_offset_frames ?? 0) : 0;
  if (asset.type === "video") {
    if (nestedFrame(offset, composition.fps, asset.fps) >= asset.frameCount)
      throw new IntentError(
        ["shots", index, "source_offset_frames"],
        "the trim offset is past the end of the video",
      );
    const last = nestedFrame(offset + shot.duration_frames - 1, composition.fps, asset.fps);
    if (last >= asset.frameCount)
      throw new IntentError(
        ["shots", index, "duration_frames"],
        "the video ends before this shot; shorten the shot or reduce the trim offset",
      );
  }

  const xScale = composition.width / asset.width;
  const yScale = composition.height / asset.height;
  const scale = shot.fit === "cover" ? Math.max(xScale, yScale) : Math.min(xScale, yScale);
  return {
    op: "addLayer",
    composition: composition.id,
    layer: MediaLayerInput.parse(
      withLayerDefaults(
        {
          type: shot.type,
          assetId: asset.id,
          name: asset.name,
          inFrame: window.in_frame,
          outFrame: window.out_frame,
          startFrame: window.in_frame - offset,
          transform: {
            anchorPoint: { value: [asset.width / 2, asset.height / 2] },
            scale: { value: [scale, scale] },
          },
        },
        composition,
      ),
    ),
  };
}

export function buildFromBriefExpansion(
  doc: Project,
  input: Brief,
): { ops: Op[]; resolved: object } {
  const id = input.composition ?? doc.mainCompositionId;
  const composition = doc.compositions.find((entry) => entry.id === id);
  if (composition === undefined)
    throw new IntentError(["composition"], `unknown composition '${id}'; see get_scene`);

  const start = input.start_frame ?? 0;
  if (start >= composition.durationFrames)
    throw new IntentError(["start_frame"], "must be before the end of the composition");

  let end = start;
  const planned = input.shots.map((shot, index) => {
    const in_frame = end;
    end += shot.duration_frames;
    if (end > composition.durationFrames)
      throw new IntentError(
        ["shots", index, "duration_frames"],
        `this shot would end at frame ${end}; the composition ends at frame ${composition.durationFrames}`,
      );
    const window: ShotWindow = { type: shot.type, in_frame, out_frame: end };
    return { shot, window };
  });
  const { pack, ref } = resolveStyle(doc);
  const style = createComponentStyle(pack, composition, composition.fps);
  const ops: Op[] = [];
  const component = (component_id: string, window: Window, props: Record<string, Json>) => {
    ops.push(
      ...addComponentExpansion(doc, {
        component_id,
        component_version: COMPONENT_VERSION,
        composition: composition.id,
        in_frame: window.in_frame,
        out_frame: window.out_frame,
        props,
      }).ops,
    );
  };
  if (input.background !== "transparent")
    component(
      "background",
      { in_frame: start, out_frame: end },
      {
        kind: "gradient",
        loops: 0,
        colorA: { role: "background" },
        colorB: { role: "surface" },
        colorC: { role: "surface" },
      },
    );

  for (const [index, { shot, window }] of planned.entries()) {
    switch (shot.type) {
      case "headline": {
        if (shot.text.trim() === "")
          throw new IntentError(["shots", index, "text"], "supply headline copy");
        const scale = headlineScale(shot.text, style, composition);
        // The pinned kinetic type definition accepts scale values from 0.25 to 4.
        if (scale < 0.25)
          throw new IntentError(
            ["shots", index, "text"],
            "the headline does not fit at minimum scale; shorten it or use fewer or shorter lines",
          );
        component("kinetic-type", window, { text: shot.text, scale, exit: false });
        break;
      }
      case "logo":
        if (shot.asset_id === undefined && !shot.wordmark?.trim())
          throw new IntentError(["shots", index, "wordmark"], "supply an image asset or wordmark");
        if (
          shot.asset_id !== undefined &&
          !doc.assets.some((asset) => asset.id === shot.asset_id && asset.type === "image")
        )
          throw new IntentError(["shots", index, "asset_id"], "supply an uploaded image asset id");
        component("logo-reveal", window, {
          logo: shot.asset_id ?? null,
          wordmark: shot.wordmark ?? "",
          tagline: shot.tagline ?? "",
        });
        break;
      case "image":
      case "video":
        ops.push(mediaOperation(doc, composition, shot, window, index));
        break;
    }
    if (shot.lower_third !== undefined) {
      if (shot.lower_third.title.trim() === "")
        throw new IntentError(["shots", index, "lower_third", "title"], "supply a title");
      component("lower-third", window, {
        title: shot.lower_third.title,
        subtitle: shot.lower_third.subtitle ?? "",
        variant: "plate",
        exit: false,
      });
    }
  }

  const shots = planned.map(({ window }) => window);
  const transitions: Boundary[] = [];
  const halfFast = Math.floor((style.frames("fast") - 1) / 2);
  for (const [index, left] of shots.entries()) {
    const right = shots[index + 1];
    if (right === undefined) break;
    const frame = right.in_frame;
    // Odd spans put full cover at the cut. At most half of each adjacent shot is used.
    const half = Math.min(
      halfFast,
      Math.floor((left.out_frame - left.in_frame - 1) / 2),
      Math.floor((right.out_frame - right.in_frame - 1) / 2),
    );
    if (input.transition === "wipe" && half > 0) {
      const window = { in_frame: frame - half, out_frame: frame + half + 1 };
      component("transition", window, { kind: "wipe" });
      transitions.push({ type: "wipe", frame, ...window });
    } else transitions.push({ type: "cut", frame });
  }
  const warnings = composition.layers.some(({ solo }) => solo)
    ? ["Existing soloed layers hide the storyboard. Clear solo with update_layer to see it."]
    : [];
  return {
    ops,
    resolved: {
      composition: id,
      style: ref,
      in_frame: start,
      out_frame: end,
      shots,
      transitions,
      warnings,
    },
  };
}
