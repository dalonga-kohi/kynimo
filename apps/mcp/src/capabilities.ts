import { builtInRegistry } from "@kynimo/components";
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
  MAX_GENERATOR_POINT,
  MAX_GENERATOR_STOPS,
  MAX_GRAIN_SIZE,
  MAX_NOISE_OCTAVES,
  MAX_NOISE_SCALE,
  MAX_PATTERN_ANGLE,
  MAX_PATTERN_SIZE,
  MAX_POSTERIZE_LEVELS,
  MAX_SCANLINE_SPACING,
  MAX_VIGNETTE_FEATHER,
  MAX_VIGNETTE_RADIUS,
  MIN_NOISE_SCALE,
  MIN_PATTERN_SIZE,
  MIN_POSTERIZE_LEVELS,
  MIN_SCANLINE_SPACING,
  MIN_VIGNETTE_FEATHER,
  SCENE_FORMAT_VERSION,
} from "@kynimo/scene";
import { SCRIPT_LIMITS } from "@kynimo/script";
import { MAX_BRIEF_SHOTS } from "./build-from-brief.js";
import { EXPORT_LIMITS } from "./export.js";
import { JOB_LIMITS } from "./jobs.js";
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
  components: "kynimo://components",
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
    reason: `${LAYER_SUPPORT.audio.status === "accepted" ? LAYER_SUPPORT.audio.reason : "audio renders"}. Add with upload_asset (WAV, MP3, FLAC, Ogg, M4A, or a video's own sound), stored as 48 kHz FLAC. Beats are detected at upload (bpm, confidence); mark_beats and sync_to_beats use them`,
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
  custom_components: unavailable("custom components (define_component) arrive in M6"),
  catalogs: unavailable(
    "the token catalog arrives in M5 and the shader catalog in M6; kynimo://presets and kynimo://components are available",
  ),
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
  noiseScale: { min: MIN_NOISE_SCALE, max: MAX_NOISE_SCALE },
  evolution: { min: -MAX_GENERATOR_EVOLUTION, max: MAX_GENERATOR_EVOLUTION },
  offset: { min: -MAX_GENERATOR_OFFSET, max: MAX_GENERATOR_OFFSET },
  patternSize: { min: MIN_PATTERN_SIZE, max: MAX_PATTERN_SIZE },
  patternAngle: MAX_PATTERN_ANGLE,
  gradientPoint: MAX_GENERATOR_POINT,
} as const;

const LOOK_LIMITS = {
  chromaticAberration: MAX_ABERRATION,
  grainSize: { min: 1, max: MAX_GRAIN_SIZE },
  posterizeLevels: { min: MIN_POSTERIZE_LEVELS, max: MAX_POSTERIZE_LEVELS },
  scanlineSpacing: { min: MIN_SCANLINE_SPACING, max: MAX_SCANLINE_SPACING },
  vignetteRadius: { min: 0, max: MAX_VIGNETTE_RADIUS },
  vignetteFeather: { min: MIN_VIGNETTE_FEATHER, max: MAX_VIGNETTE_FEATHER },
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
    export: {
      tools: ["export", "render_preview_clip", "get_export_status", "cancel_export"],
      formats: {
        mp4: { video: "H.264 (yuv420p, CRF 18)", audio: "AAC 192 kb/s", transparency: false },
        webm: { video: "VP9 (CRF 30)", audio: "Opus 128 kb/s", transparency: true },
        gif: { video: "256-color palette", audio: null, transparency: false },
      },
      limits: EXPORT_LIMITS,
      jobs: {
        concurrency: JOB_LIMITS.concurrency,
        max_active_per_account: JOB_LIMITS.maxActivePerAccount,
        retention_hours: JOB_LIMITS.retentionMs / 3_600_000,
      },
      note: "jobs run in the server process: a restart loses queued and running jobs and download links; audio layers inside precomps are not mixed yet (reported)",
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
    components: {
      tools: ["add_component", "list_components"],
      resource: RESOURCES.components,
      built_ins: [...new Set(builtInRegistry.list().map(({ id }) => id))],
    },
    brief: {
      tool: "build_from_brief",
      max_shots: MAX_BRIEF_SHOTS,
      shot_types: ["headline", "logo", "image", "video"],
    },
    unavailable: UNAVAILABLE,
    resources: RESOURCES,
  };
}
