import { expect, it } from "vitest";
import { evaluateFrame } from "./evaluate.js";
import { composition, deepFreeze, project, solid, transform } from "./fixtures.test-util.js";

it("samples pin positions in layer time at the center frame of a motion-blurred layer", () => {
  const doc = deepFreeze(
    project([
      composition("main", [
        solid("s", {
          startFrame: 10,
          motionBlur: { samples: 4 },
          transform: transform({
            position: {
              keyframes: [
                { frame: 0, value: [0, 0], interpolation: { type: "linear" } },
                { frame: 10, value: [50, 0], interpolation: { type: "linear" } },
              ],
            },
          }),
          deform: {
            pins: [
              {
                id: "tip",
                rest: [12, 24],
                position: {
                  keyframes: [
                    { frame: 0, value: [12, 24], interpolation: { type: "linear" } },
                    { frame: 10, value: [32, 44], interpolation: { type: "hold" } },
                  ],
                },
              },
            ],
          },
        }),
      ]),
    ]),
  );
  const layer = evaluateFrame(doc, 15).layers[0];
  expect(layer).toMatchObject({
    layerFrame: 5,
    deform: {
      density: 24,
      iterations: 10,
      pins: [{ id: "tip", rest: [12, 24], position: [22, 34] }],
    },
  });
  expect(layer?.motion).toHaveLength(4);
  expect(evaluateFrame(doc, 15).layers[0]).toEqual(layer);
});
