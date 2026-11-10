import { AssetSchema, LayerSchema, SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { describe, expect, it } from "vitest";
import { capabilityManifest } from "./capabilities.js";

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

  it("names the format version and stays small enough to read in one go", () => {
    expect(manifest.scene_format_version).toBe(SCENE_FORMAT_VERSION);
    expect(JSON.stringify(manifest).length).toBeLessThan(8_000);
  });
});
