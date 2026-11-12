import {
  mat4Multiply,
  mat4RotateX,
  mat4RotateY,
  mat4Translate,
  type Projective,
  projectLayerPlane,
} from "@kynimo/engine";

/**
 * The projection of a layer's z = 0 plane through a camera, built from the engine's own pieces: the
 * layer's raster pixel → composition pixel map. The default camera sits at `(width / 2, height / 2,
 * -zoom)` looking along +z, so a layer at `z = 0` with no rotation lands exactly where a 2D layer
 * with the same position and anchor does.
 */
export function cardProjection(options: {
  comp: [number, number];
  zoom: number;
  position: [number, number, number];
  anchor: [number, number];
  rotationX?: number;
  rotationY?: number;
  camera?: [number, number, number];
}): Projective {
  const { comp, zoom, position, anchor, rotationX = 0, rotationY = 0 } = options;
  const [cw, ch] = comp;
  const camera = options.camera ?? [cw / 2, ch / 2, -zoom];
  const world = mat4Multiply(
    mat4Translate(...position),
    mat4Multiply(
      mat4RotateY(rotationY),
      mat4Multiply(mat4RotateX(rotationX), mat4Translate(-anchor[0], -anchor[1], 0)),
    ),
  );
  const view = mat4Translate(-camera[0], -camera[1], -camera[2]);
  return projectLayerPlane(mat4Multiply(view, world), zoom, cw, ch);
}
