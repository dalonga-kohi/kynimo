import { IntentError } from "@kynimo/intent";
import { LayerIdSchema, type LayerInput, type Op, type Project } from "@kynimo/scene";
import { importSvg, SvgImportError } from "@kynimo/svg";
import type { z } from "zod";
import type { ImportSvgRequest } from "./schemas.js";

export type ImportSvgArgs = z.infer<typeof ImportSvgRequest>;

/** `svg`, else `svg-2`, `svg-3`, ...: the first id no layer of the project uses (ids are project-wide). */
function freeLayerId(doc: Project): string {
  const used = new Set(doc.compositions.flatMap((c) => c.layers.map((l) => l.id as string)));
  if (!used.has("svg")) return "svg";
  for (let n = 2; ; n++) if (!used.has(`svg-${n}`)) return `svg-${n}`;
}

/**
 * Expands `import_svg` into one addLayer op: a shape layer spanning the composition, with the
 * converter's contents, placed so the SVG's viewBox centre sits at `position`. Pure and deterministic.
 */
export function importSvgExpansion(
  doc: Project,
  input: ImportSvgArgs,
): { ops: Op[]; resolved: object } {
  const compId = input.composition ?? doc.mainCompositionId;
  const composition = doc.compositions.find((c) => c.id === compId);
  if (!composition)
    throw new IntentError(
      ["composition"],
      `composition '${compId}' does not exist; use one of: ${doc.compositions.map((c) => c.id).join(", ")}`,
    );
  let result: ReturnType<typeof importSvg>;
  try {
    result = importSvg(input.svg);
  } catch (e) {
    if (e instanceof SvgImportError) throw new IntentError(["svg"], e.message);
    throw e;
  }
  const layerId = input.layer_id ?? freeLayerId(doc);
  const name = input.name ?? (result.title ? result.title : "SVG");
  const k = input.width === undefined ? 1 : input.width / result.size.width;
  const scale: [number, number] = [result.scale[0] * k, result.scale[1] * k];
  const outSize = { width: result.size.width * k, height: result.size.height * k };
  const sized = (n: number): boolean => n >= 1e-6 && n <= 1e15;
  if (
    !scale.every((n) => Number.isFinite(n) && n > 0) ||
    !sized(outSize.width) ||
    !sized(outSize.height)
  ) {
    throw new IntentError(
      ["width"],
      "width is too large or too small for this SVG; use a normal pixel width such as 512",
    );
  }
  const position: [number, number] = input.position
    ? [input.position[0] ?? 0, input.position[1] ?? 0]
    : [composition.width / 2, composition.height / 2];
  const layer: Extract<LayerInput, { type: "shape" }> = {
    type: "shape",
    name,
    inFrame: 0,
    outFrame: composition.durationFrames,
    startFrame: 0,
    hidden: false,
    solo: false,
    editor: { locked: false, shy: false, label: null },
    markers: [],
    parent: null,
    threeD: false,
    transform: {
      anchorPoint: { value: result.anchorPoint },
      position: { value: position },
      positionZ: { value: 0 },
      scale: { value: scale },
      rotation: { value: 0 },
      rotationX: { value: 0 },
      rotationY: { value: 0 },
      skew: { value: 0 },
      opacity: { value: 1 },
    },
    blendMode: "normal",
    matte: null,
    masks: [],
    effects: [],
    motionBlur: null,
    transition: null,
    behaviors: [],
    contents: result.contents,
  };
  const op: Op = {
    op: "addLayer",
    composition: composition.id,
    id: LayerIdSchema.parse(layerId),
    layer,
    ...(input.index === undefined ? {} : { index: input.index }),
  };
  return {
    ops: [op],
    resolved: {
      layer_id: layerId,
      name,
      size: outSize,
      view_box: result.viewBox,
      report: result.report,
    },
  };
}
