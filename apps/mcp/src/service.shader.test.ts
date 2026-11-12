import { CaptureError, validateShaderProgram } from "@kynimo/capture";
import { type ShaderDefinitionInput, withLayerDefaults } from "@kynimo/scene";
import { beforeEach, expect, it, vi } from "vitest";
import { KynimoService } from "./service.js";
import { MemoryStore } from "./store.js";

vi.mock("@kynimo/capture", async (original) => ({
  ...(await original<typeof import("@kynimo/capture")>()),
  validateShaderProgram: vi.fn(),
}));

const validator = vi.mocked(validateShaderProgram);
const shader: ShaderDefinitionInput = {
  id: "custom-card",
  version: "1.0.0",
  kind: "generator",
  title: "Card",
  source: "return vec4(1.0);",
  uniforms: {},
};

beforeEach(() => {
  validator.mockReset();
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function project() {
  const store = new MemoryStore();
  const service = new KynimoService(store, "author");
  const { id } = await service.createProject({
    name: "Shaders",
    idempotency_key: "project",
    width: 64,
    height: 64,
    duration_frames: 8,
    fps: { num: 30, den: 1 },
    background: null,
  });
  const state = await store.get(id);
  const comp = state?.doc.compositions[0];
  if (comp === undefined) throw new Error("missing test composition");
  return { service, id, comp };
}

it("leaves the project writable while Chromium validates a new shader", async () => {
  const { service, id, comp } = await project();
  const started = deferred();
  const complete = deferred();
  validator.mockImplementation(async () => {
    started.resolve();
    await complete.promise;
  });
  const publication = service.defineShader(id, "shader", shader);
  await started.promise;
  const sceneEdit = service.write(
    { project_id: id, base_version: 1, idempotency_key: "layer" },
    {
      kind: "ops",
      ops: [
        {
          op: "addLayer",
          composition: comp.id,
          layer: withLayerDefaults(
            {
              type: "solid",
              name: "Box",
              width: 10,
              height: 10,
              color: "#ff0000",
            },
            comp,
          ),
        },
      ],
    },
  );
  const unlocked = await Promise.race([
    sceneEdit,
    new Promise<string>((resolve) => setImmediate(() => resolve("locked"))),
  ]).finally(complete.resolve);
  await Promise.all([publication, sceneEdit]);
  expect(unlocked).toMatchObject({ version: 2, changed: true });
  expect(await service.getWriteOutcome("shader", id)).toMatchObject({
    status: "applied",
    version: 2,
  });
});

it("keeps the key retryable after shader worker failure", async () => {
  const { service, id } = await project();
  validator
    .mockRejectedValueOnce(
      new CaptureError("the pinned browser could not create WebGL2", "ShaderValidationUnavailable"),
    )
    .mockResolvedValueOnce(undefined);
  await expect(service.defineShader(id, "shader", shader)).rejects.toMatchObject({
    kind: "unavailable",
    message: "the pinned browser could not create WebGL2",
  });
  expect(await service.getWriteOutcome("shader", id)).toEqual({ status: "unknown" });
  expect(await service.listDefinitions(id)).toEqual({ definitions: [] });
  await expect(service.defineShader(id, "shader", shader)).resolves.toMatchObject({
    created: true,
    replayed: false,
  });
});
