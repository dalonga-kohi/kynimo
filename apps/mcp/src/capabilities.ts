import {
  BEHAVIOR_LIMITS,
  BEHAVIOR_SUPPORT,
  BLEND_MODE_SUPPORT,
  EFFECT_LIMITS,
  EFFECT_SUPPORT,
  GENERATOR_SUPPORT,
  LAYER_SUPPORT,
  MASK_MODE_SUPPORT,
  MATTE_MODE_SUPPORT,
  PAINT_SUPPORT,
  RENDERER_FORMATS,
  SHAPE_ITEM_SUPPORT,
  type Support,
  TEXT_ANIMATOR_LIMITS,
  TEXT_ANIMATOR_SUPPORT,
} from "@kynimo/renderer";
import {
  type Asset,
  MAX_ABERRATION,
  MAX_AURORA_COLORS,
  MAX_BATCH_OPS,
  MAX_GENERATOR_EVOLUTION,
  MAX_GENERATOR_OFFSET,
  MAX_GENERATOR_STOPS,
  MAX_NOISE_OCTAVES,
  SCENE_FORMAT_VERSION,
} from "@kynimo/scene";
import { SCRIPT_LIMITS } from "@kynimo/script";
import { RENDER_LIMITS } from "./render.js";
import { SCRIPT_CONCURRENCY } from "./service.js";

/** A feature the scene format has no room for yet, or a tool this server does not have yet. */
export interface Unavailable {
  status: "unavailable";
  reason: string;
}

/** Resources this server serves; listed in the manifest for clients that do not show resources. */
export const RESOURCES = {
  capabilities: "kynimo://capabilities",
  scene: "kynimo://schema/scene",
  ops: "kynimo://schema/ops",
  layer: "kynimo://schema/layer/{type}",
  presets: "kynimo://presets",
  sdk: "kynimo://sdk",
} as const;

const ASSET_SUPPORT: Readonly<Record<Asset["type"], Support>> = {
  image: {
    status: "renders",
    note: `formats: ${RENDERER_FORMATS.image.join(", ")}; add with upload_asset`,
  },
  font: {
    status: "renders",
    note: `formats: ${RENDERER_FORMATS.font.join(", ")}; add with upload_asset; bundled without an asset: ${RENDERER_FORMATS.bundledFonts.join(", ")}`,
  },
  video: {
    status: "renders",
    note: "add with upload_asset (MP4, MOV, WebM, MKV; up to 60 s): decoded at upload to JPEG frames, at most 1920 px and 60 fps; needs FFmpeg on the server",
  },
  audio: {
    status: "accepted",
    reason: `${LAYER_SUPPORT.audio.status === "accepted" ? LAYER_SUPPORT.audio.reason : "audio renders"}. Add with upload_asset (WAV, MP3, FLAC, Ogg, M4A, or a video's own sound), stored as 48 kHz FLAC`,
  },
};

const unavailable = (reason: string): Unavailable => ({ status: "unavailable", reason });

/**
 * What the format and this server do not have yet, by roadmap milestone. The one hand-kept part of
 * the manifest: everything the format accepts comes from the renderer's tables instead. An entry
 * goes when the item that builds it ships.
 */
const UNAVAILABLE: Readonly<Record<string, Unavailable>> = {
  custom_shaders: unavailable(
    "custom GLSL shaders (define_shader) arrive in M6; built-in generators and looks render now",
  ),
  styles: unavailable("guideline packs, tokens, apply_style and check_quality arrive in M5"),
  components: unavailable("components and their catalog arrive in M6"),
  catalogs: unavailable(
    "the token catalog arrives in M5, the component and shader catalogs in M6; the preset catalog is the resource kynimo://presets (tool list_presets)",
  ),
  export: unavailable("MP4, WebM and GIF export and preview clips arrive in M7"),
  keyframed_text: unavailable(
    "text content is constant; keyframed source text is planned after the beta",
  ),
  three_d: unavailable("3D layers, cameras and lights are planned after the beta"),
};

const STATUSES = {
  renders:
    "handled in rendered frames (a note says when that means drawing nothing, as for null layers)",
  accepted:
    "valid in a document, but not in rendered frames; the reason says why. Drawn layers left out are also listed under skipped in render results",
  unavailable: "not in the format or the server yet; the reason says when",
} as const;

/** Generator and look limits (ADR-0045): the scene schema's bounds, stated for agents. */
const GENERATOR_LIMITS = {
  gradientStops: MAX_GENERATOR_STOPS,
  auroraColors: MAX_AURORA_COLORS,
  noiseOctaves: MAX_NOISE_OCTAVES,
  noiseScale: { min: 8, max: 4096 },
  evolution: { min: -MAX_GENERATOR_EVOLUTION, max: MAX_GENERATOR_EVOLUTION },
  offset: { min: -MAX_GENERATOR_OFFSET, max: MAX_GENERATOR_OFFSET },
  patternSize: { min: 2, max: 2048 },
} as const;

const LOOK_LIMITS = {
  chromaticAberration: MAX_ABERRATION,
  grainSize: { min: 1, max: 8 },
  posterizeLevels: { min: 2, max: 32 },
  scanlineSpacing: { min: 2, max: 64 },
} as const;

/** The capability manifest (ADR-0018), built from the renderer's tables, so it cannot drift from them. */
export function capabilityManifest(server: { name: string; version: string }) {
  return {
    server,
    scene_format_version: SCENE_FORMAT_VERSION,
    statuses: STATUSES,
    layer_types: LAYER_SUPPORT,
    features: {
      shape_items: SHAPE_ITEM_SUPPORT,
      paints: PAINT_SUPPORT,
      blend_modes: BLEND_MODE_SUPPORT,
      mask_modes: MASK_MODE_SUPPORT,
      track_matte_modes: MATTE_MODE_SUPPORT,
      text_animator_properties: TEXT_ANIMATOR_SUPPORT,
      behaviors: BEHAVIOR_SUPPORT,
      effects: EFFECT_SUPPORT,
      generators: GENERATOR_SUPPORT,
    },
    limits: {
      text_animators: TEXT_ANIMATOR_LIMITS,
      behaviors: BEHAVIOR_LIMITS,
      effects: { ...EFFECT_LIMITS, ...LOOK_LIMITS },
      generators: GENERATOR_LIMITS,
    },
    assets: ASSET_SUPPORT,
    render: {
      tools: ["render_frames", "render_contact_sheet"],
      limits: RENDER_LIMITS,
      note: "requests over a limit are rejected with values that fit, never downscaled silently; every result lists skipped layers and warnings",
    },
    scripts: {
      tool: "run_script",
      resource: RESOURCES.sdk,
      limits: { ...SCRIPT_LIMITS, max_ops: MAX_BATCH_OPS, concurrency: SCRIPT_CONCURRENCY },
      note: "a script runs once in a sandbox with no clock, randomness (kynimo.random() is seeded), network or imports; limits are per run (interrupts count instructions; deadlineMs is a backstop); a script that exceeds one fails with nothing applied; the source and seed are kept with the version they wrote (get_script)",
    },
    imports: {
      svg: {
        tool: "import_svg",
        status: "renders",
        note: "import_svg: paths, basic shapes, groups, transforms, fills, strokes, dashes, linear/radial gradients, <use>. Not carried (reported): text, images, filters, clip paths, masks, patterns, markers, <style> sheets, animation.",
      },
    },
    unavailable: UNAVAILABLE,
    resources: RESOURCES,
  };
}
