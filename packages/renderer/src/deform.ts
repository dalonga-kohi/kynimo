// biome-ignore-all lint/style/noNonNullAssertion: Mesh and band indices refer to storage constructed and bounded here.
import type { Point, ResolvedDeform } from "@kynimo/engine";
import {
  DEFORM_DENSITY,
  DEFORM_ITERATIONS,
  MAX_COMPOSITION_SIZE,
  MAX_DEFORM_PINS,
} from "@kynimo/scene";
import { RenderError } from "./errors.js";
import type { CoverageImage, PlannedDeform, RasterImage, RenderWarning } from "./raster.js";

export const MAX_DEFORM_TRIANGLES = 2 * DEFORM_DENSITY.max ** 2;
export const MAX_FRAME_DEFORM_WORK = 128_000_000;
/** Keeps source coordinates and placement offsets in a safe range for WebGL float32. */
export const MAX_DEFORM_COORDINATE = 2 ** 20;
/** Match the pinned WebGL renderer's four subpixel bits for deterministic edge ownership. */
const SUBPIXEL_SCALE = 16;
const subpixel = (v: number) => Math.round(v * SUBPIXEL_SCALE) / SUBPIXEL_SCALE;

function fail(id: string, message: string): never {
  throw new RenderError(`layer '${id.slice(0, 64)}': ${message}`);
}

/** Shared by all layers and nested plans of a frame. Both compositors also charge each actual draw. */
export class FrameDeformWork {
  private remaining: number;

  constructor(private readonly limit = MAX_FRAME_DEFORM_WORK) {
    this.remaining = limit;
  }

  charge(id: string, units: number): void {
    this.remaining -= units;
    if (units < 0 || !Number.isSafeInteger(this.remaining) || this.remaining < 0)
      fail(
        id,
        `deformation exceeds the frame budget of ${this.limit} work units; reduce density, iterations, or the number or size of deformed layers`,
      );
  }
}

interface Source {
  width: number;
  height: number;
  /** Omitted for layers whose whole rectangle is meshed. */
  raster?: RasterImage;
  mask: CoverageImage | null;
}

interface Mesh {
  rest: Point[];
  triangles: number[];
  neighbours: number[][];
}

const inIntRange = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;

const safeCoordinate = (n: number) => Number.isFinite(n) && Math.abs(n) <= MAX_DEFORM_COORDINATE;

function occupiedCells(
  { width, height, raster, mask }: Source,
  columns: number,
  rows: number,
): Uint8Array {
  const occupied = new Uint8Array(columns * rows);
  if (raster === undefined) return occupied.fill(1);
  const { pixels } = raster;
  for (let y = 0, i = 0; y < height; y++) {
    const firstRow = Math.floor((y * rows) / height);
    const lastRow = Math.ceil(((y + 1) * rows) / height);
    for (let x = 0; x < width; x++, i++) {
      if (pixels[i * 4 + 3] === 0 || mask?.coverage[i] === 0) continue;
      // A texel occupies [x,x+1) × [y,y+1). Include every cell it intersects by positive area,
      // even when a cell is smaller than a texel. The integer numerators keep grid-edge ties exact.
      const firstColumn = Math.floor((x * columns) / width);
      const lastColumn = Math.ceil(((x + 1) * columns) / width);
      for (let row = firstRow; row < lastRow; row++)
        for (let column = firstColumn; column < lastColumn; column++)
          occupied[row * columns + column] = 1;
    }
  }
  // Dilate from the original occupancy only, so the margin cannot propagate.
  const cells = occupied.slice();
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      if (occupied[y * columns + x] === 0) continue;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(rows - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(columns - 1, x + 1); xx++)
          cells[yy * columns + xx] = 1;
    }
  return cells;
}

function buildMesh(source: Source, density: number, id: string, work: FrameDeformWork): Mesh {
  const { width, height, raster } = source;
  const longest = Math.max(width, height);
  const columns = Math.max(1, Math.ceil((density * width) / longest));
  const rows = Math.max(1, Math.ceil((density * height) / longest));
  const stride = columns + 1;
  // Each cell's margin and graph visits have constant cost. The sum of intersections of the
  // pixel and grid intervals along an axis is at most pixels + cells.
  work.charge(
    id,
    32 * stride * (rows + 1) +
      (raster === undefined ? 0 : width * height + (width + columns) * (height + rows)),
  );
  const cells = occupiedCells(source, columns, rows);
  const indices = new Int32Array(stride * (rows + 1)).fill(-1);
  const rest: Point[] = [];
  for (let y = 0; y <= rows; y++)
    for (let x = 0; x <= columns; x++) {
      if (
        !(x > 0 && y > 0 && cells[(y - 1) * columns + x - 1]) &&
        !(x < columns && y > 0 && cells[(y - 1) * columns + x]) &&
        !(x > 0 && y < rows && cells[y * columns + x - 1]) &&
        !(x < columns && y < rows && cells[y * columns + x])
      )
        continue;
      indices[y * stride + x] = rest.length;
      rest.push([(x * width) / columns, (y * height) / rows]);
    }
  const triangles: number[] = [];
  const neighbours: number[][] = rest.map(() => []);
  const edge = (a: number, b: number) => {
    if (neighbours[a]!.includes(b)) return;
    neighbours[a]!.push(b);
    neighbours[b]!.push(a);
  };
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      if (cells[y * columns + x] === 0) continue;
      const corner = y * stride + x;
      const a = indices[corner]!;
      const b = indices[corner + 1]!;
      const c = indices[corner + stride]!;
      const d = indices[corner + stride + 1]!;
      triangles.push(a, b, d, a, d, c);
      edge(a, b);
      edge(b, d);
      edge(a, d);
      edge(d, c);
      edge(c, a);
    }
  return { rest, triangles, neighbours };
}

function pinTargets(
  rest: readonly Point[],
  pins: ResolvedDeform["pins"],
  [scale, offsetX, offsetY]: readonly [number, number, number],
  id: string,
): { targets: Map<number, Point>; warning: RenderWarning | null } {
  const targets = new Map<number, Point>();
  const examples: string[] = [];
  let collisions = 0;
  for (const pin of pins) {
    const x = pin.rest[0] * scale + offsetX;
    const y = pin.rest[1] * scale + offsetY;
    const dx = (pin.position[0] - pin.rest[0]) * scale;
    const dy = (pin.position[1] - pin.rest[1]) * scale;
    if (![x, y, dx, dy].every(safeCoordinate))
      fail(
        id,
        `deform pin '${pin.id.slice(0, 60)}' exceeds the finite ±${MAX_DEFORM_COORDINATE} raster coordinate or displacement limit; reduce the pin position`,
      );
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < rest.length; i++) {
      const [vx, vy] = rest[i]!;
      const d = (vx - x) ** 2 + (vy - y) ** 2;
      if (d >= best) continue;
      best = d;
      nearest = i;
    }
    const vertex = rest[nearest];
    if (vertex === undefined) continue;
    const target: Point = [vertex[0] + dx, vertex[1] + dy];
    if (!target.every(safeCoordinate))
      fail(
        id,
        `deform pin '${pin.id.slice(0, 60)}' exceeds the ±${MAX_DEFORM_COORDINATE} raster coordinate limit; reduce the pin position`,
      );
    if (targets.has(nearest)) {
      collisions++;
      if (examples.length < 5) examples.push(pin.id.slice(0, 60));
    } else targets.set(nearest, target);
  }
  return {
    targets,
    warning:
      collisions === 0
        ? null
        : {
            id,
            kind: "deform-pin-collision",
            codepoints: [],
            message: `${collisions} deform pin(s) share a mesh vertex with an earlier pin (${examples.join(", ")}); the first pin on each vertex wins`,
          },
  };
}

/** Free vertices, in mesh order, for just the connected components that have a pin. */
function freeVertices(mesh: Mesh, targets: ReadonlyMap<number, Point>): number[] {
  const seen = new Uint8Array(mesh.rest.length);
  const pending = [...targets.keys()];
  for (const v of pending) seen[v] = 1;
  for (let v = pending.pop(); v !== undefined; v = pending.pop())
    for (const u of mesh.neighbours[v]!) {
      if (seen[u]) continue;
      seen[u] = 1;
      pending.push(u);
    }
  const free: number[] = [];
  for (let i = 0; i < seen.length; i++) if (seen[i] && !targets.has(i)) free.push(i);
  return free;
}

/** In-place lower band Cholesky of the positive definite Laplacian with pins eliminated. */
function cholesky(l: Float64Array, size: number, band: number, id: string): void {
  const stride = band + 1;
  for (let i = 0; i < size; i++) {
    const row = i * stride;
    const first = Math.max(0, i - band);
    for (let j = first; j <= i; j++) {
      const entry = row + i - j;
      const col = j * stride;
      let v = l[entry]!;
      for (let k = first; k < j; k++) v -= l[row + i - k]! * l[col + j - k]!;
      if (i === j) {
        if (!(v > 0) || !Number.isFinite(v))
          fail(id, "deform mesh has an invalid solver pivot; move the pins or reduce density");
        l[entry] = Math.sqrt(v);
      } else l[entry] = v / l[col]!;
    }
  }
}

/** Solves L Lᵀ x = rhs in place. */
function solveBand(l: Float64Array, band: number, rhs: Float64Array): void {
  const stride = band + 1;
  for (let i = 0; i < rhs.length; i++) {
    const row = i * stride;
    let value = rhs[i]!;
    for (let j = Math.max(0, i - band); j < i; j++) value -= l[row + i - j]! * rhs[j]!;
    rhs[i] = value / l[row]!;
  }
  for (let i = rhs.length - 1; i >= 0; i--) {
    let value = rhs[i]!;
    for (let j = i + 1; j <= Math.min(i + band, rhs.length - 1); j++)
      value -= l[j * stride + j - i]! * rhs[j]!;
    rhs[i] = value / l[i * stride]!;
  }
}

function solveMesh(
  mesh: Mesh,
  targets: ReadonlyMap<number, Point>,
  iterations: number,
  id: string,
  work: FrameDeformWork,
): Point[] {
  const { rest, neighbours } = mesh;
  const free = freeVertices(mesh, targets);
  const current = rest.map((v, i) => targets.get(i) ?? v);
  if (free.length === 0) return current;
  const rowOf = new Int32Array(rest.length).fill(-1);
  free.forEach((v, i) => {
    rowOf[v] = i;
  });
  let band = 0;
  free.forEach((v, i) => {
    for (const u of neighbours[v]!) {
      const j = rowOf[u]!;
      if (j >= 0 && j < i) band = Math.max(band, i - j);
    }
  });
  const stride = band + 1;
  work.charge(
    id,
    free.length * stride ** 2 +
      iterations * (4 * free.length * stride + 4 * mesh.triangles.length + rest.length),
  );
  const l = new Float64Array(free.length * stride);
  free.forEach((v, i) => {
    const row = i * stride;
    l[row] = neighbours[v]!.length;
    for (const u of neighbours[v]!) {
      const j = rowOf[u]!;
      if (j >= 0 && j < i) l[row + i - j] = -1;
    }
  });
  cholesky(l, free.length, band, id);

  const cos = new Float64Array(rest.length);
  const sin = new Float64Array(rest.length);
  const rhsX = new Float64Array(free.length);
  const rhsY = new Float64Array(free.length);
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let v = 0; v < rest.length; v++) {
      if (rowOf[v] === -1 && !targets.has(v)) continue;
      const [rx, ry] = rest[v]!;
      const [cx, cy] = current[v]!;
      let dot = 0;
      let cross = 0;
      for (const u of neighbours[v]!) {
        const [sx, sy] = rest[u]!;
        const [tx, ty] = current[u]!;
        dot += (rx - sx) * (cx - tx) + (ry - sy) * (cy - ty);
        cross += (rx - sx) * (cy - ty) - (ry - sy) * (cx - tx);
      }
      const angle = Math.atan2(cross, dot);
      cos[v] = Math.cos(angle);
      sin[v] = Math.sin(angle);
    }
    free.forEach((v, i) => {
      const [rx, ry] = rest[v]!;
      let x = 0;
      let y = 0;
      for (const u of neighbours[v]!) {
        const [sx, sy] = rest[u]!;
        const c = (cos[v]! + cos[u]!) * 0.5;
        const s = (sin[v]! + sin[u]!) * 0.5;
        x += c * (rx - sx) - s * (ry - sy);
        y += s * (rx - sx) + c * (ry - sy);
        const pin = targets.get(u);
        if (pin !== undefined) {
          x += pin[0];
          y += pin[1];
        }
      }
      rhsX[i] = x;
      rhsY[i] = y;
    });
    solveBand(l, band, rhsX);
    solveBand(l, band, rhsY);
    free.forEach((v, i) => {
      current[v] = [rhsX[i]!, rhsY[i]!];
    });
  }
  return current;
}

function drawPlan(
  mesh: Mesh,
  positions: readonly Point[],
  [padX, padY]: readonly [number, number],
  id: string,
  work: FrameDeformWork,
): PlannedDeform {
  let l = Number.POSITIVE_INFINITY;
  let t = Number.POSITIVE_INFINITY;
  let r = Number.NEGATIVE_INFINITY;
  let b = Number.NEGATIVE_INFINITY;
  for (const [x, y] of positions) {
    if (!safeCoordinate(x) || !safeCoordinate(y))
      fail(
        id,
        `deform solve exceeded the finite ±${MAX_DEFORM_COORDINATE} raster coordinate limit; reduce pin displacement`,
      );
    l = Math.min(l, x);
    t = Math.min(t, y);
    r = Math.max(r, x);
    b = Math.max(b, y);
  }
  const x = Math.floor(l) - 1;
  const y = Math.floor(t) - 1;
  if (!safeCoordinate(x) || !safeCoordinate(y))
    fail(
      id,
      `deform target origin exceeds ±${MAX_DEFORM_COORDINATE} raster pixels; reduce pin displacement`,
    );
  const width = Math.ceil(r) + 1 - x;
  const height = Math.ceil(b) + 1 - y;
  const targetWidth = width + 2 * padX;
  const targetHeight = height + 2 * padY;
  if (
    !inIntRange(targetWidth, 1, MAX_COMPOSITION_SIZE) ||
    !inIntRange(targetHeight, 1, MAX_COMPOSITION_SIZE)
  )
    fail(
      id,
      `deformation with effect padding exceeds the ${MAX_COMPOSITION_SIZE}-pixel target size limit; reduce pin displacement, layer size or effect radius`,
    );
  const triangleCount = mesh.triangles.length / 3;
  let drawWork = targetWidth * targetHeight + triangleCount;
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const a = positions[mesh.triangles[i]!]!;
    const b = positions[mesh.triangles[i + 1]!]!;
    const c = positions[mesh.triangles[i + 2]!]!;
    // Conservative bounding boxes include subpixel rounding on the shared vertex stream.
    drawWork +=
      (2 + Math.ceil(Math.max(a[0], b[0], c[0]) - Math.min(a[0], b[0], c[0]))) *
      (2 + Math.ceil(Math.max(a[1], b[1], c[1]) - Math.min(a[1], b[1], c[1])));
  }
  work.charge(id, drawWork);
  const vertices: number[] = [];
  for (const v of mesh.triangles) {
    const [dx, dy] = positions[v]!;
    const [sx, sy] = mesh.rest[v]!;
    vertices.push(subpixel(dx - x), subpixel(dy - y), Math.fround(sx), Math.fround(sy));
  }
  return { origin: [x, y], width, height, vertices, drawWork };
}

/** Plans the center-frame warp; everything here is CPU math over the untransformed layer raster. */
export function planDeform(
  id: string,
  deform: ResolvedDeform,
  source: Source,
  layerToRaster: readonly [scale: number, x: number, y: number],
  padding: readonly [number, number],
  work: FrameDeformWork,
): { warp: PlannedDeform | null; warning: RenderWarning | null } {
  const { width, height, raster, mask } = source;
  const { density, iterations, pins } = deform;
  if (
    !inIntRange(width, 1, MAX_COMPOSITION_SIZE) ||
    !inIntRange(height, 1, MAX_COMPOSITION_SIZE) ||
    (raster !== undefined &&
      (raster.width !== width ||
        raster.height !== height ||
        raster.pixels.length !== width * height * 4)) ||
    (mask !== null &&
      (mask.width !== width || mask.height !== height || mask.coverage.length !== width * height))
  )
    fail(
      id,
      `invalid deform source raster; check its data and the ${MAX_COMPOSITION_SIZE}-pixel size limit`,
    );
  if (!inIntRange(density, DEFORM_DENSITY.min, DEFORM_DENSITY.max))
    fail(id, `deform density must be an integer in ${DEFORM_DENSITY.min}..${DEFORM_DENSITY.max}`);
  if (!inIntRange(iterations, DEFORM_ITERATIONS.min, DEFORM_ITERATIONS.max))
    fail(
      id,
      `deform iterations must be an integer in ${DEFORM_ITERATIONS.min}..${DEFORM_ITERATIONS.max}`,
    );
  if (pins.length > MAX_DEFORM_PINS)
    fail(id, `deform accepts at most ${MAX_DEFORM_PINS} pins; remove some pins`);
  if (pins.length === 0) return { warp: null, warning: null };
  if (!(layerToRaster[0] > 0) || !layerToRaster.every(Number.isFinite))
    fail(id, "invalid layer-to-raster scale for deformation; reduce the layer size");
  const mesh = buildMesh(source, density, id, work);
  work.charge(id, mesh.rest.length * pins.length);
  const { targets, warning } = pinTargets(mesh.rest, pins, layerToRaster, id);
  const moves = [...targets].some(
    ([v, p]) => p[0] !== mesh.rest[v]![0] || p[1] !== mesh.rest[v]![1],
  );
  if (!moves) return { warp: null, warning };
  if (mesh.triangles.length > MAX_DEFORM_TRIANGLES * 3)
    fail(id, `deform mesh exceeds ${MAX_DEFORM_TRIANGLES} triangles; reduce density`);
  const positions = solveMesh(mesh, targets, iterations, id, work);
  return { warp: drawPlan(mesh, positions, padding, id, work), warning };
}
