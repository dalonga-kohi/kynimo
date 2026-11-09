import {
  BLEND_MODE_SUPPORT,
  LAYER_SUPPORT,
  MASK_MODE_SUPPORT,
  MATTE_MODE_SUPPORT,
  PAINT_SUPPORT,
  RENDERER_FORMATS,
  SHAPE_ITEM_SUPPORT,
  type Support,
} from "@kynimo/renderer";
import { type Asset, SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { RENDER_LIMITS } from "./render.js";

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
  effects: unavailable(
    "blur, drop shadow, glow, color effects and adjustment layers that use them arrive in M4",
  ),
  shape_operators: unavailable("trim paths, repeater and round corners arrive in M4"),
  text_animators: unavailable("per-character, word and line animators arrive in M4"),
  behaviors: unavailable("wiggle, loop, inertia, follow and oscillate arrive in M4"),
  intent_tools: unavailable(
    "animate, apply_preset, stagger and retime arrive in M4; use set_keyframes or apply_ops",
  ),
  svg_import: unavailable("SVG import arrives in M4; draw with shape layers"),
  shaders: unavailable("built-in shader effects arrive in M4; custom GLSL in M6"),
  styles: unavailable("guideline packs, tokens, apply_style and check_quality arrive in M5"),
  components: unavailable("components and their catalog arrive in M6"),
  catalogs: unavailable(
    "preset (M4), token (M5), component and shader (M6) catalogs arrive with their milestones",
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
    },
    assets: ASSET_SUPPORT,
    render: {
      tools: ["render_frames", "render_contact_sheet"],
      limits: RENDER_LIMITS,
      note: "requests over a limit are rejected with values that fit, never downscaled silently; every result lists skipped layers and warnings",
    },
    unavailable: UNAVAILABLE,
    resources: RESOURCES,
  };
}
