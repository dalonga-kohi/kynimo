import {
  AssetSchema,
  BEHAVIOR_TYPES,
  EffectInputSchema,
  LayerSchema,
  MAX_BATCH_OPS,
  MAX_BEHAVIORS,
  MAX_EFFECTS,
  SCENE_FORMAT_VERSION,
} from "@kynimo/scene";
import { SCRIPT_LIMITS } from "@kynimo/script";
import { describe, expect, it } from "vitest";
import { capabilityManifest } from "./capabilities.js";
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

  it("doesn't list the shipped intent tools as unavailable", () => {
    expect(manifest.unavailable).not.toHaveProperty("intent_tools");
    const text = JSON.stringify(manifest.unavailable);
    // The preset catalog is a resource now; only the tokens/components/shaders catalogs are missing.
    expect(manifest.unavailable.catalogs?.reason).toContain("kynimo://presets");
    for (const tool of ["animate", "apply_preset", "stagger", "retime", "add_behavior"])
      expect(text).not.toMatch(new RegExp(`\\b${tool}\\b.*arrive`));
  });

  it("names the format version and stays small enough to read in one go", () => {
    expect(manifest.scene_format_version).toBe(SCENE_FORMAT_VERSION);
    expect(JSON.stringify(manifest).length).toBeLessThan(8_000);
  });
});
