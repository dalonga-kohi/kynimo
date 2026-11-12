import { BUILT_IN_COMPONENTS } from "@kynimo/components";
import {
  AssetSchema,
  BEHAVIOR_TYPES,
  EffectInputSchema,
  GeneratorSchema,
  LayerSchema,
  MAX_BATCH_OPS,
  MAX_BEHAVIORS,
  MAX_EFFECTS,
  MotionBlurSchema,
  SCENE_FORMAT_VERSION,
} from "@kynimo/scene";
import { SCRIPT_LIMITS } from "@kynimo/script";
import { describe, expect, it } from "vitest";
import { capabilityManifest } from "./capabilities.js";
import { EXPORT_LIMITS } from "./export.js";
import { JOB_LIMITS } from "./jobs.js";
import { SCRIPT_CONCURRENCY } from "./service.js";

const manifest = capabilityManifest({ name: "kynimo", version: "test" });
const sorted = (values: Iterable<string>) => [...values].sort();

describe("capability manifest", () => {
  it("has an entry for every layer type and asset type in the schema", () => {
    expect(sorted(Object.keys(manifest.layer_types))).toEqual(
      sorted(LayerSchema.options.map((o) => o.shape.type.value)),
    );
    expect(sorted(Object.keys(manifest.assets))).toEqual(
      sorted(AssetSchema.options.map((o) => o.shape.type.value)),
    );
  });

  it("uses only the three statuses, each with a reason unless it renders", () => {
    const entries = [
      ...Object.values(manifest.layer_types),
      ...Object.values(manifest.features).flatMap((group) => Object.values(group)),
      ...Object.values(manifest.assets),
      ...Object.values(manifest.unavailable),
    ];
    for (const entry of entries) {
      expect(Object.keys(manifest.statuses)).toContain(entry.status);
      if (entry.status !== "renders") expect("reason" in entry && entry.reason).toBeTruthy();
    }
  });

  it("lists what text animators change and how many glyphs they may draw", () => {
    const props = manifest.features.text_animator_properties;
    expect(sorted(Object.keys(props))).toEqual(
      sorted(["position", "scale", "rotation", "opacity", "fill", "blur", "tracking"]),
    );
    expect(props.blur.status).toBe("accepted");
    expect(props.position.status).toBe("renders");
    expect(manifest.limits.text_animators.glyphsPerLayer).toBeGreaterThan(0);
    // Shipped features leave the unavailable list.
    expect(manifest.unavailable).not.toHaveProperty("text_animators");
    expect(manifest.unavailable).not.toHaveProperty("shape_operators");
  });

  it("declares the script tool, its SDK resource and its limits", () => {
    expect(manifest.scripts).toMatchObject({
      tool: "run_script",
      resource: "kynimo://sdk",
      limits: { ...SCRIPT_LIMITS, max_ops: MAX_BATCH_OPS, concurrency: SCRIPT_CONCURRENCY },
    });
    expect(manifest.resources.sdk).toBe("kynimo://sdk");
    expect(manifest.unavailable).not.toHaveProperty("scripts");
  });

  it("declares the export tools, formats, limits and job limits, and drops export from unavailable", () => {
    expect(manifest.export.tools).toEqual([
      "export",
      "render_preview_clip",
      "get_export_status",
      "cancel_export",
    ]);
    expect(Object.keys(manifest.export.formats)).toEqual(["mp4", "webm", "gif"]);
    expect(manifest.export.formats.webm.transparency).toBe(true);
    expect(manifest.export.formats.gif.audio).toBeNull();
    expect(manifest.export.limits).toEqual(EXPORT_LIMITS);
    expect(manifest.export.jobs).toEqual({
      concurrency: JOB_LIMITS.concurrency,
      max_active_per_account: JOB_LIMITS.maxActivePerAccount,
      retention_hours: 24,
    });
    expect(manifest.unavailable).not.toHaveProperty("export");
    const audio = manifest.layer_types.audio;
    expect(audio.status === "accepted" && audio.reason).toContain(
      "mixed into mp4 and webm exports",
    );
    const asset = manifest.assets.audio;
    expect(asset.status === "accepted" && asset.reason).toContain("Beats are detected at upload");
    expect(asset.status === "accepted" && asset.reason).toContain("mark_beats and sync_to_beats");
  });

  it("declares SVG import as available and lists what it does not carry", () => {
    expect(manifest.imports.svg).toMatchObject({ tool: "import_svg", status: "renders" });
    expect(manifest.imports.svg.note).toContain("Not carried (reported)");
    expect(manifest.unavailable).not.toHaveProperty("svg_import");
  });

  it("lists every behavior type as supported and states its limits", () => {
    expect(sorted(Object.keys(manifest.features.behaviors))).toEqual(sorted(BEHAVIOR_TYPES));
    for (const support of Object.values(manifest.features.behaviors))
      expect(support.status).toBe("renders");
    expect(manifest.limits.behaviors).toEqual({
      behaviorsPerLayer: MAX_BEHAVIORS,
      linkStepsPerFrame: 100_000,
    });
    expect(manifest.unavailable).not.toHaveProperty("behaviors");
  });

  it("lists the effect stack's exact supported types and limits", () => {
    expect(sorted(Object.keys(manifest.features.effects))).toEqual(
      sorted(EffectInputSchema.options.map((option) => option.shape.type.value)),
    );
    expect(
      Object.values(manifest.features.effects).every((effect) => effect.status === "renders"),
    ).toBe(true);
    expect(manifest.limits.effects.effectsPerLayer).toBe(MAX_EFFECTS);
    expect(manifest.unavailable).not.toHaveProperty("effects");
  });

  it("lists transform motion blur as rendering, with the schema's bounds", () => {
    expect(manifest.features.motion_blur.transform.status).toBe("renders");
    expect(manifest.limits.motion_blur).toEqual({
      shutterAngle: { min: 0, max: 720, default: 180 },
      shutterPhase: { min: -360, max: 360, default: -90 },
      samples: { min: 2, max: 64, default: 16 },
    });
    const { shutterAngle, shutterPhase, samples } = manifest.limits.motion_blur;
    expect(MotionBlurSchema.parse({})).toEqual({
      shutterAngle: shutterAngle.default,
      shutterPhase: shutterPhase.default,
      samples: samples.default,
    });
    for (const [key, limit] of Object.entries({ shutterAngle, shutterPhase, samples })) {
      expect(MotionBlurSchema.safeParse({ [key]: limit.min }).success, key).toBe(true);
      expect(MotionBlurSchema.safeParse({ [key]: limit.max }).success, key).toBe(true);
      expect(MotionBlurSchema.safeParse({ [key]: limit.min - 1 }).success, key).toBe(false);
      expect(MotionBlurSchema.safeParse({ [key]: limit.max + 1 }).success, key).toBe(false);
    }
  });

  it("lists every generator kind, the looks and their limits, and keeps custom shaders unavailable", () => {
    expect(sorted(Object.keys(manifest.features.generators))).toEqual(
      sorted(GeneratorSchema.options.map((option) => option.shape.type.value)),
    );
    expect(Object.values(manifest.features.generators).every((g) => g.status === "renders")).toBe(
      true,
    );
    for (const look of ["vignette", "grain", "chromatic-aberration", "posterize", "scanlines"])
      expect(manifest.features.effects).toHaveProperty(look);
    expect(manifest.limits.generators).toMatchObject({
      gradientStops: 16,
      auroraColors: 4,
      noiseOctaves: 6,
      noiseScale: { min: 8, max: 4096 },
      patternSize: { min: 2, max: 2048 },
      patternAngle: 3600,
      gradientPoint: 65536,
    });
    expect(manifest.limits.effects).toMatchObject({
      chromaticAberration: 32,
      grainSize: { min: 1, max: 8 },
      posterizeLevels: { min: 2, max: 32 },
      scanlineSpacing: { min: 2, max: 64 },
    });
    expect(manifest.unavailable).not.toHaveProperty("shaders");
    expect(manifest.unavailable.custom_shaders?.reason).toContain("M6");
    expect(manifest.unavailable.catalogs?.reason).toContain("shader catalog in M6");
    expect(manifest.layer_types.generator.status).toBe("renders");
    expect(manifest.layer_types.component.status).toBe("renders");
    expect(manifest.unavailable.custom_components?.reason).toContain("define_component");
    expect(manifest.components).toEqual({
      tools: ["add_component", "list_components"],
      resource: "kynimo://components",
      built_ins: [...new Set(BUILT_IN_COMPONENTS.map(({ id }) => id))].sort(),
    });
    expect(manifest.brief).toEqual({
      tool: "build_from_brief",
      max_shots: 24,
      shot_types: ["headline", "logo", "image", "video"],
    });
  });

  it("doesn't list the shipped intent tools as unavailable", () => {
    expect(manifest.unavailable).not.toHaveProperty("intent_tools");
    const text = JSON.stringify(manifest.unavailable);
    // The preset and component catalogs are available as resources.
    expect(manifest.unavailable.catalogs?.reason).toContain("kynimo://presets");
    for (const tool of [
      "animate",
      "apply_preset",
      "stagger",
      "retime",
      "mark_beats",
      "sync_to_beats",
      "add_behavior",
      "add_component",
      "build_from_brief",
    ])
      expect(text).not.toMatch(new RegExp(`\\b${tool}\\b.*arrive`));
  });

  it("names the format version and stays small enough to read in one go", () => {
    expect(manifest.scene_format_version).toBe(SCENE_FORMAT_VERSION);
    expect(JSON.stringify(manifest).length).toBeLessThan(10_700); // 9_000 before the export block (ADR-0048); 10_000 before motion blur (ADR-0053); 10_500 before the camera layer type (ADR-0054)
  });
});
