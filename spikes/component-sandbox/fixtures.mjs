import {
  createComponentHost,
  createComponentRegistry,
  defineComponent,
} from "../../packages/components/dist/index.js";
import { evaluateFrame } from "../../packages/engine/dist/index.js";
import {
  ProjectSchema,
  SCENE_FORMAT_VERSION,
  withLayerDefaults,
} from "../../packages/scene/dist/index.js";

export const FRAME_COUNT = 240;
export const SCENES = { representative: 8, stress: 32 };

// The same trusted fixture runs natively and as source in QuickJS. It has no outer dependencies.
function evaluate(props, ctx) {
  const value = (v) => ({ value: v });
  const make = (id, type, x, y) => ({
    id,
    name: id,
    type,
    inFrame: 0,
    outFrame: ctx.durationFrames,
    startFrame: 0,
    hidden: false,
    solo: false,
    editor: { locked: false, shy: false, label: null },
    markers: [],
    parent: null,
    blendMode: "normal",
    matte: null,
    masks: [],
    transform: {
      anchorPoint: value([0, 0]),
      position: value([x, y]),
      scale: value([1, 1]),
      rotation: value(0),
      skew: value(0),
      opacity: value(1),
    },
  });
  const solid = (id, x, y, width, height, color) => ({
    ...make(id, "solid", x, y),
    width,
    height,
    color,
  });
  const text = (id, x, y, content, size) => ({
    ...make(id, "text", x, y),
    content: value(content),
    box: { mode: "point" },
    font: { family: ctx.style.title.family, weight: ctx.style.title.weight, size: value(size) },
    tracking: value(0),
    leading: value(1.2),
    align: "left",
    textCase: "none",
    animators: [],
    fill: value(ctx.style.foreground),
  });
  const { gap, title } = ctx.style;
  const layers = [];
  if (props.kind === "label") {
    layers.push(solid("plate", gap, 0, 380, 106, props.tone));
    layers.push(text("title", gap * 2, title.size, props.label, title.size));
    layers.push(text("subtitle", gap * 2, title.size * 1.65, "Quarterly report", title.size / 2));
  } else if (props.kind === "chart") {
    layers.push(text("title", gap, title.size, props.label, title.size));
    layers.push(solid("axis", gap, 260, 360, 2, ctx.style.foreground));
    for (let i = 0; i < 7; i++) {
      const height = 8 + Math.floor((50 + ctx.random() * 180) * props.progress);
      layers.push(solid(`bar-${i}`, gap + i * 48, 260 - height, 32, height, props.tone));
    }
  } else {
    for (let i = 0; i < 16; i++) {
      const angle = i * 0.3926990817 + ctx.frame * 0.025;
      const radius = (70 + ctx.random() * 180) * props.progress;
      const x = Math.round(ctx.width / 2 + Math.cos(angle) * radius);
      const y = Math.round(ctx.height / 2 + Math.sin(angle) * radius);
      layers.push(solid(`particle-${i}`, x, y, 8, 8, props.tone));
    }
  }
  return { width: ctx.width, height: ctx.height, layers };
}

export const source = evaluate.toString();

function componentContext(ctx) {
  return {
    frame: ctx.frame,
    fps: ctx.fps,
    width: ctx.width,
    height: ctx.height,
    durationFrames: ctx.durationFrames,
    seed: ctx.seed,
    depth: ctx.depth,
    style: {
      foreground: ctx.style.color("text"),
      title: ctx.style.type("title"),
      gap: ctx.style.spacing("m"),
    },
  };
}

const native = (props, ctx) => evaluate(props, { ...ctx, random: mulberryUnit(ctx.seed) });

function makeProject(count) {
  const composition = {
    id: "main",
    name: "Main",
    width: 1920,
    height: 1080,
    fps: { num: 60, den: 1 },
    durationFrames: FRAME_COUNT,
    background: null,
    markers: [],
  };
  const kinds = ["label", "chart", "particles", "label", "chart", "label", "particles", "chart"];
  const layers = Array.from({ length: count }, (_, i) => {
    const id = `fixture-${i}`;
    return withLayerDefaults(
      {
        id,
        name: id,
        type: "component",
        componentId: "fixture",
        componentVersion: "1.0.0",
        props: {
          kind: kinds[i % kinds.length],
          label: `Metric ${i + 1} · 東京`,
          progress: {
            keyframes: [
              { frame: 0, value: 0.1, interpolation: { type: "linear" } },
              { frame: FRAME_COUNT - 1, value: 1, interpolation: { type: "linear" } },
            ],
          },
        },
      },
      composition,
    );
  });
  return ProjectSchema.parse({
    formatVersion: SCENE_FORMAT_VERSION,
    name: "Component sandbox spike",
    mainCompositionId: composition.id,
    style: null,
    assets: [],
    compositions: [{ ...composition, layers }],
  });
}

export function createFrameEvaluator(run = native) {
  const definition = defineComponent({
    id: "fixture",
    version: "1.0.0",
    title: "Fixture",
    description: "Lower third, bar chart or particle field for the M6 spike.",
    props: {
      kind: {
        type: "enum",
        description: "Fixture variant.",
        values: ["label", "chart", "particles"],
        default: "label",
      },
      label: { type: "string", description: "Title text.", default: "Metric", maxLength: 60 },
      progress: {
        type: "number",
        description: "Normalized progress.",
        default: 0,
        min: 0,
        max: 1,
        animatable: true,
      },
      tone: { type: "color", description: "Accent.", default: { role: "accent" } },
    },
    evaluate: (props, ctx) => run(props, componentContext(ctx)),
  });
  const registry = createComponentRegistry([definition]);
  const scenes = Object.fromEntries(
    Object.entries(SCENES).map(([name, count]) => {
      const project = makeProject(count);
      return [name, { project, components: createComponentHost(project, registry) }];
    }),
  );
  return (scene, frame) => {
    const { project, components } = scenes[scene];
    return evaluateFrame(project, frame, project.mainCompositionId, { components });
  };
}

// This source is also installed in the guest. Keep its stream identical to ADR-0046.
import { mulberry32 } from "../../packages/engine/dist/index.js";

export function mulberryUnit(seed) {
  const next = mulberry32(seed);
  return () => next() / 4294967296;
}
