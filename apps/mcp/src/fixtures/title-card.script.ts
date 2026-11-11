// Rebuilds packages/capture/reference/title-card/scene.json with the script SDK (ADR-0036).
// A fixture for the sandbox, not app code: `kynimo` is the global the sandbox provides, and the
// file is excluded from the app's tsc build. server.script.test.ts runs it end to end.
const comp = kynimo.composition();

const bezier = (x1: number, y1: number, x2: number, y2: number) =>
  ({ type: "bezier", x1, y1, x2, y2 }) as const;
const linear = { type: "linear" } as const;
const expo = bezier(0.16, 1, 0.3, 1);

// Layers are added bottom-first: each new layer lands on top.
const backdrop = comp.add(
  "shape",
  {
    name: "backdrop",
    contents: [
      {
        id: "rect-5",
        name: "rect",
        type: "rect",
        position: { value: [320, 180] },
        size: { value: [640, 360] },
        cornerRadius: { value: 0 },
      },
      {
        id: "fill-6",
        name: "fill",
        type: "fill",
        paint: {
          type: "linear-gradient",
          start: { value: [0, 0] },
          end: { value: [640, 360] },
          stops: {
            value: [
              { offset: 0, color: "#141b2e" },
              { offset: 1, color: "#07090f" },
            ],
          },
        },
        opacity: { value: 1 },
        rule: "nonzero",
      },
    ],
  },
  { id: "backdrop" },
);
backdrop.set("position", [0, 0]);

const glow = comp.add(
  "shape",
  {
    name: "glow",
    blendMode: "screen",
    contents: [
      {
        id: "ellipse-3",
        name: "ellipse",
        type: "ellipse",
        position: { value: [520, 70] },
        size: { value: [420, 420] },
      },
      {
        id: "fill-4",
        name: "fill",
        type: "fill",
        paint: {
          type: "radial-gradient",
          center: { value: [520, 70] },
          radius: { value: 210 },
          stops: {
            value: [
              { offset: 0, color: "#3d5afe66" },
              { offset: 1, color: "#3d5afe00" },
            ],
          },
        },
        opacity: { value: 1 },
        rule: "nonzero",
      },
    ],
  },
  { id: "glow" },
);
glow.set("position", [0, 0]);
glow.keyframes("opacity", [
  { frame: 0, value: 0.4, interpolation: bezier(0.65, 0, 0.35, 1) },
  { frame: 59, value: 1, interpolation: linear },
]);

const text = (
  id: string,
  content: string,
  weight: number,
  size: number,
  fill: string,
  tracking = 0,
  textCase: "none" | "upper" = "none",
) =>
  comp.add(
    "text",
    {
      name: id,
      content: { value: content },
      box: { mode: "point" },
      font: { family: "Inter", weight, size: { value: size } },
      tracking: { value: tracking },
      leading: { value: 1.2 },
      align: "left",
      textCase,
      fill: { value: fill },
    },
    { id },
  );

const subtitle = text(
  "subtitle",
  "Kynimo renders every frame the same way, everywhere.",
  400,
  18,
  "#9aa3ba",
);
subtitle.keyframes("position", [
  { frame: 14, value: [80, 266], interpolation: expo },
  { frame: 34, value: [80, 256], interpolation: linear },
]);
subtitle.keyframes("opacity", [
  { frame: 14, value: 0, interpolation: expo },
  { frame: 34, value: 1, interpolation: linear },
]);

const rule = comp.add(
  "shape",
  {
    name: "rule",
    contents: [
      {
        id: "rect-1",
        name: "rect",
        type: "rect",
        position: { value: [90, 2] },
        size: { value: [180, 4] },
        cornerRadius: { value: 2 },
      },
      {
        id: "fill-2",
        name: "fill",
        type: "fill",
        paint: {
          type: "linear-gradient",
          start: { value: [0, 0] },
          end: { value: [180, 0] },
          stops: {
            value: [
              { offset: 0, color: "#ff7a59" },
              { offset: 1, color: "#ffb86b" },
            ],
          },
        },
        opacity: { value: 1 },
        rule: "nonzero",
      },
    ],
  },
  { id: "rule" },
);
rule.set("position", [80, 218]);
rule.keyframes("scale", [
  { frame: 8, value: [0, 1], interpolation: expo },
  { frame: 32, value: [1, 1], interpolation: linear },
]);

const title = text("title", "Motion, made by agents.", 700, 46, "#f5f7fb", -20);
title.keyframes("position", [
  { frame: 2, value: [80, 222], interpolation: { type: "spring", damping: 0.7, response: 0.5 } },
  { frame: 27, value: [80, 196], interpolation: linear },
]);
title.keyframes("opacity", [
  { frame: 2, value: 0, interpolation: expo },
  { frame: 16, value: 1, interpolation: linear },
]);

const kicker = text("kicker", "Reference scene 01", 600, 13, "#ff7a59", 160, "upper");
kicker.set("position", [80, 132]);
kicker.keyframes("opacity", [
  { frame: 0, value: 0, interpolation: linear },
  { frame: 12, value: 1, interpolation: linear },
]);
