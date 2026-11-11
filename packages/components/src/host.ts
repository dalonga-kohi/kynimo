import { type ComponentContext, type ComponentHost, mulberry32 } from "@kynimo/engine";
import { findPack, type GuidelinePack, keynote } from "@kynimo/guidelines";
import {
  type Asset,
  type ComponentLayer,
  type Composition,
  type Layer,
  type Project,
  ProjectSchema,
  SCENE_FORMAT_VERSION,
} from "@kynimo/scene";
import type { ComponentEvalContext, ComponentOutput } from "./define.js";
import { builtInRegistry, type ComponentRegistry } from "./registry.js";
import { resolveProps } from "./resolve-props.js";
import { createComponentStyle } from "./style.js";

const OUTPUT_COMPOSITION_ID = "component";
const MAX_VERSIONS_LISTED = 5;
const MAX_IDS_LISTED = 10;
const MAX_FAILURE_MESSAGE = 200;
const MAX_INVALID_MESSAGE = 300;

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;

const formatPath = (path: readonly PropertyKey[]): string =>
  path
    .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
    .join("")
    .replace(/^\./, "");

/** The pack a document's style pins; Keynote stands in when it pins none (ADR-0037). */
function packFor(project: Project, who: string): GuidelinePack {
  if (project.style === null) return keynote;
  const pack = findPack(project.style);
  if (pack === undefined)
    throw new RangeError(
      `${who}: the project pins style ${project.style.packId}@${project.style.version}, which isn't in this build`,
    );
  return pack;
}

/** Assets the output's layers need: those its image and video layers reference, and every font (text may use uploaded families). */
function neededAssets(project: Project, layers: readonly Layer[]): Asset[] {
  const used = new Set<string>();
  for (const layer of layers)
    if (layer.type === "image" || layer.type === "video") used.add(layer.assetId);
  return project.assets.filter((a) => a.type === "font" || used.has(a.id));
}

/**
 * Builds the engine's component host for one document: it looks instances up in `registry`, validates
 * and resolves their props, binds the document's style pack, runs the definition and validates the
 * subtree it returns with the scene schema, so the engine only ever sees documents the schema accepts.
 */
export function createComponentHost(
  project: Project,
  registry: ComponentRegistry = builtInRegistry,
): ComponentHost {
  return {
    evaluate(layer: ComponentLayer, ctx: ComponentContext): Composition {
      const ref = `${layer.componentId}@${layer.componentVersion}`;
      const who = `component '${ref}' on layer '${layer.id}'`;

      const def = registry.get(layer.componentId, layer.componentVersion);
      if (def === undefined) {
        const all = registry.list();
        const versions = all.filter((d) => d.id === layer.componentId).map((d) => d.version);
        if (versions.length > 0) {
          const shown = versions.slice(-MAX_VERSIONS_LISTED);
          throw new RangeError(
            `layer '${layer.id}': component '${layer.componentId}' has no version '${layer.componentVersion}'; available versions: ${shown.join(", ")}${versions.length > shown.length ? ", ..." : ""}`,
          );
        }
        const ids = [...new Set(all.map((d) => d.id))];
        throw new RangeError(
          `layer '${layer.id}': no component '${layer.componentId}'; available: ${ids.slice(0, MAX_IDS_LISTED).join(", ") || "none"}${ids.length > MAX_IDS_LISTED ? ", ..." : ""}`,
        );
      }

      const pack = packFor(project, who);
      const props = resolveProps(def.props, layer.props, {
        who,
        assets: project.assets,
        pack,
        frame: ctx.frame,
        fps: ctx.fps,
      });

      const next = mulberry32(ctx.seed);
      const evalCtx: ComponentEvalContext = {
        ...ctx,
        random: () => next() / 4294967296,
        style: createComponentStyle(pack, ctx, ctx.fps),
        assetSize: (id) => {
          const asset = project.assets.find((a) => a.id === id);
          return asset !== undefined && (asset.type === "image" || asset.type === "video")
            ? { width: asset.width, height: asset.height }
            : null;
        },
      };

      let output: ComponentOutput;
      try {
        output = def.evaluate(props, evalCtx);
      } catch (e) {
        throw new RangeError(
          `${who} failed: ${truncate(e instanceof Error ? e.message : String(e), MAX_FAILURE_MESSAGE)}`,
        );
      }

      const invalid = (where: string, message: string): never => {
        throw new RangeError(
          truncate(`${who} returned an invalid subtree: ${where}: ${message}`, MAX_INVALID_MESSAGE),
        );
      };
      if (typeof output !== "object" || output === null)
        return invalid("output", "expected { width, height, layers }");
      if (Array.isArray(output.layers)) {
        const audio = output.layers.findIndex((l) => (l as Layer | null)?.type === "audio");
        if (audio >= 0) invalid(`layers[${audio}].type`, "components cannot output audio layers");
        const precomp = output.layers.findIndex((l) => (l as Layer | null)?.type === "precomp");
        if (precomp >= 0)
          invalid(`layers[${precomp}].type`, "components cannot output precomp layers");
      }

      const parsed = ProjectSchema.safeParse({
        formatVersion: SCENE_FORMAT_VERSION,
        name: project.name,
        mainCompositionId: OUTPUT_COMPOSITION_ID,
        style: project.style,
        compositions: [
          {
            id: OUTPUT_COMPOSITION_ID,
            name: truncate(def.title, 200),
            width: output.width,
            height: output.height,
            fps: ctx.fps,
            durationFrames: Math.max(ctx.durationFrames, ctx.frame + 1),
            background: output.background ?? null,
            layers: output.layers,
            markers: [],
          },
        ],
        assets: Array.isArray(output.layers) ? neededAssets(project, output.layers) : [],
      });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        // Paths start `compositions[0].`; the component only knows the output's own fields.
        const path = formatPath(issue?.path ?? []).replace(/^compositions\[0\]\.?/, "");
        return invalid(path === "" ? "output" : path, issue?.message ?? "is invalid");
      }
      return parsed.data.compositions[0] as Composition;
    },
  };
}
