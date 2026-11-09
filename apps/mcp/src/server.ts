import { LayerSelectorSchema, SCENE_FORMAT_VERSION } from "@kynimo/scene";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { capabilityManifest, RESOURCES } from "./capabilities.js";
import { withLayerDefaults } from "./defaults.js";
import { layerJsonSchema, opJsonSchema, sceneJsonSchema } from "./json-schemas.js";
import { compactToolListing } from "./listing.js";
import {
  AddLayerInput,
  AddMaskInput,
  ApplyOpsInput,
  CreateProjectInput,
  CreateProjectOutput,
  DescribeMotionInput,
  DescribeMotionOutput,
  FindLayersOutput,
  GetCapabilitiesOutput,
  GetLayerOutput,
  GetLayerSchemaOutput,
  GetProjectOutput,
  GetSceneOutput,
  IdempotencyKeySchema,
  LAYER_TYPES,
  ListProjectsOutput,
  PrecomposeInput,
  ProjectIdSchema,
  RenderContactSheetInput,
  RenderContactSheetOutput,
  RenderFramesInput,
  RenderFramesOutput,
  SetKeyframesInput,
  SetMatteInput,
  UndoRedoInput,
  UpdateLayerInput,
  WriteOutcomeOutput,
  WriteOutput,
} from "./schemas.js";
import { type KynimoService, type Rendered, ToolError, type WriteMeta } from "./service.js";

export const SERVER_NAME = "kynimo";
export const SERVER_VERSION = "0.1.0";
const SERVER = { name: SERVER_NAME, version: SERVER_VERSION };

const INSTRUCTIONS = `Kynimo is a motion graphics engine. A project holds compositions of layers; every edit is a typed scene operation, so it stays editable and undoable.
Call get_capabilities once: it says what this build draws, what it accepts but leaves out of frames, and what is not available yet.
Workflow: create_project or list_projects → get_scene (summary) → write with apply_ops (one atomic batch) or the single-purpose tools → check with get_scene / get_layer / describe_motion (timing), and look at the result with render_contact_sheet (whole animation) and render_frames (details).
Every write needs base_version (the version you last read) and a fresh idempotency_key. If a call fails without a reply, retry it with the same key, or ask get_write_outcome whether it landed.
Time is integer frames at the composition frame rate. Layers are top-first (index 0 draws on top). Keyframe frames are in layer time (composition frame = startFrame + frame).`;

const reply = (structured: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(structured) }],
  structuredContent: structured,
});

const errorReply = (e: unknown): CallToolResult => {
  const body =
    e instanceof ToolError
      ? {
          error: e.kind,
          message: e.message,
          errors: e.errors,
          ...(e.currentVersion === undefined ? {} : { current_version: e.currentVersion }),
        }
      : { error: "internal", message: e instanceof Error ? e.message : String(e) };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] };
};

/** A render result: its PNGs as image content, then the structured result as text. */
const imageReply = ({ result, images }: Rendered<object>): CallToolResult => ({
  content: [
    ...images.map((png) => ({
      type: "image" as const,
      data: Buffer.from(png).toString("base64"),
      mimeType: "image/png",
    })),
    { type: "text", text: JSON.stringify(result) },
  ],
  structuredContent: result as Record<string, unknown>,
});

/** Runs a handler and turns any failure into an MCP error result; nothing throws to the transport. */
const guard =
  <A>(fn: (args: A) => Promise<Record<string, unknown>>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return reply(await fn(args));
    } catch (e) {
      return errorReply(e);
    }
  };

const guardImages =
  <A>(fn: (args: A) => Promise<Rendered<object>>) =>
  async (args: A): Promise<CallToolResult> => {
    try {
      return imageReply(await fn(args));
    } catch (e) {
      return errorReply(e);
    }
  };

const meta = (a: WriteMeta): WriteMeta => ({
  project_id: a.project_id,
  base_version: a.base_version,
  idempotency_key: a.idempotency_key,
});

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
/** Writes that can remove layers or discard work: clients should not auto-approve them. */
const DESTRUCTIVE = { ...WRITE, destructiveHint: true } as const;

/** Builds the MCP server on a service. The transport (stdio now, Streamable HTTP later) is the caller's. */
export function createServer(service: KynimoService): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  compactToolListing(server);

  // Project
  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description:
        "Creates a project with one empty main composition (id 'main'). Returns the project id and version 1.",
      inputSchema: CreateProjectInput,
      outputSchema: CreateProjectOutput,
      annotations: WRITE,
    },
    guard(async (a) => ({ ...(await service.createProject(a)) })),
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Lists projects with their current versions.",
      inputSchema: z.object({}),
      outputSchema: ListProjectsOutput,
      annotations: READ,
    },
    guard(async () => ({ projects: await service.listProjects() })),
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project",
      description:
        "Project overview: version, compositions (size, frame rate, duration, layer count), asset count.",
      inputSchema: z.object({ project_id: ProjectIdSchema }),
      outputSchema: GetProjectOutput,
      annotations: READ,
    },
    guard(async (a) => service.getProject(a.project_id)),
  );

  // Read
  server.registerTool(
    "get_scene",
    {
      title: "Get scene",
      description:
        "The scene. 'summary' (default) lists each composition's layers with timing and which properties are keyframed when, in composition frames. 'full' returns the whole document. Filter to one composition with `composition`.",
      inputSchema: z.object({
        project_id: ProjectIdSchema,
        detail: z.enum(["summary", "full"]).default("summary"),
        composition: z.string().min(1).max(64).optional(),
      }),
      outputSchema: GetSceneOutput,
      annotations: READ,
    },
    guard(async (a) => service.getScene(a.project_id, a.detail, a.composition)),
  );

  server.registerTool(
    "find_layers",
    {
      title: "Find layers",
      description:
        "Layers matching a selector: a layer id, or { name, type, composition } where `name` may use * as a wildcard.",
      inputSchema: z.object({
        project_id: ProjectIdSchema,
        selector: LayerSelectorSchema,
        limit: z.number().int().min(1).max(200).default(50),
      }),
      outputSchema: FindLayersOutput,
      annotations: READ,
    },
    guard(async (a) => service.findLayers(a.project_id, a.selector, a.limit)),
  );

  server.registerTool(
    "get_layer",
    {
      title: "Get layer",
      description: "One layer in full. The selector must match exactly one layer.",
      inputSchema: z.object({ project_id: ProjectIdSchema, layer: LayerSelectorSchema }),
      outputSchema: GetLayerOutput,
      annotations: READ,
    },
    guard(async (a) => service.getLayer(a.project_id, a.layer)),
  );

  server.registerTool(
    "describe_motion",
    {
      title: "Describe motion",
      description:
        "What animates when, from the keyframes: per layer its visible frames and, per animated property, segments between keyframes with frames, seconds, start and end values and easing (linear, hold, bezier with its curve, spring with its settle frame). Filter by layer selector or a frame window. Nothing is rendered.",
      inputSchema: DescribeMotionInput,
      outputSchema: DescribeMotionOutput,
      annotations: READ,
    },
    guard(async ({ project_id, ...input }) => ({
      ...(await service.describeMotion(project_id, input)),
    })),
  );

  server.registerTool(
    "get_layer_schema",
    {
      title: "Get layer schema",
      description:
        "The exact JSON Schema of one layer type (without `id`), for building addLayer ops and add_layer calls.",
      inputSchema: z.object({ type: z.enum(LAYER_TYPES) }),
      outputSchema: GetLayerSchemaOutput,
      annotations: READ,
    },
    guard(async (a) => ({ type: a.type, schema: layerJsonSchema(a.type) })),
  );

  server.registerTool(
    "get_capabilities",
    {
      title: "Get capabilities",
      description:
        "What this build draws: each layer type and feature is renders, accepted (valid, left out of frames, with why) or unavailable (with when). Also render limits. Same as kynimo://capabilities.",
      inputSchema: z.object({}),
      outputSchema: GetCapabilitiesOutput,
      annotations: READ,
    },
    guard(async () => ({ ...capabilityManifest(SERVER) })),
  );

  server.registerTool(
    "get_write_outcome",
    {
      title: "Get write outcome",
      description:
        "Whether a write with this idempotency_key landed: applied (with its version), rejected (with errors), expired (too old to tell) or unknown (never arrived). Omit project_id to look up a create_project key.",
      inputSchema: z.object({
        project_id: ProjectIdSchema.optional(),
        idempotency_key: IdempotencyKeySchema,
      }),
      outputSchema: WriteOutcomeOutput,
      annotations: READ,
    },
    guard(async (a) => ({ ...(await service.getWriteOutcome(a.idempotency_key, a.project_id)) })),
  );

  // Feedback
  server.registerTool(
    "render_frames",
    {
      title: "Render frames",
      description:
        "Renders composition frames and returns them as PNG images, downscaled to max_size. Lists layers the renderer skipped and content drawn differently (font fallback), with the frames affected. Results are cached by document content.",
      inputSchema: RenderFramesInput,
      outputSchema: RenderFramesOutput,
      annotations: READ,
    },
    guardImages(async ({ project_id, ...input }) => service.renderFrames(project_id, input)),
  );

  server.registerTool(
    "render_contact_sheet",
    {
      title: "Render contact sheet",
      description:
        "Renders frames tiled row-major into one PNG image (`frames` lists them in cell order), to check a whole animation at a glance. Lists skipped layers and warnings like render_frames.",
      inputSchema: RenderContactSheetInput,
      outputSchema: RenderContactSheetOutput,
      annotations: READ,
    },
    guardImages(async ({ project_id, ...input }) => service.renderContactSheet(project_id, input)),
  );

  // Precise
  server.registerTool(
    "apply_ops",
    {
      title: "Apply operations",
      description:
        "Applies a batch of scene operations atomically and returns the new version. Ops: addLayer, updateLayer, removeLayer, setTransformTrack, reorderLayer, setParent, addMarker, removeMarker, addMask, updateMask, removeMask, setMatte, precompose. Errors name the failing op and field as a path (['ops', i, field]).",
      inputSchema: ApplyOpsInput,
      outputSchema: WriteOutput,
      annotations: DESTRUCTIVE,
    },
    guard(async (a) => ({ ...(await service.write(meta(a), { kind: "ops", ops: a.ops })) })),
  );

  server.registerTool(
    "add_layer",
    {
      title: "Add layer",
      description:
        "Adds one layer, filling the fields every layer shares (see `layer`). Same as an addLayer op in apply_ops.",
      inputSchema: AddLayerInput,
      outputSchema: WriteOutput,
      annotations: WRITE,
    },
    guard(async (a) => {
      const composition = await service.composition(a.project_id, a.composition);
      const op = {
        op: "addLayer",
        composition: a.composition,
        layer: withLayerDefaults(a.layer, composition),
        ...(a.id === undefined ? {} : { id: a.id }),
        ...(a.index === undefined ? {} : { index: a.index }),
      };
      return { ...(await service.write(meta(a), { kind: "ops", ops: [op] })) };
    }),
  );

  server.registerTool(
    "update_layer",
    {
      title: "Update layer",
      description:
        "Changes a layer's name, timing (inFrame, outFrame, startFrame) or render switches (hidden, solo).",
      inputSchema: UpdateLayerInput,
      outputSchema: WriteOutput,
      annotations: WRITE,
    },
    guard(async (a) => ({
      ...(await service.write(meta(a), {
        kind: "ops",
        ops: [{ op: "updateLayer", layer: a.layer, set: a.set }],
      })),
    })),
  );

  server.registerTool(
    "set_keyframes",
    {
      title: "Set keyframes",
      description:
        "Sets one transform property (anchorPoint, position, scale, rotation, skew, opacity) to a constant or to keyframes, replacing what was there.",
      inputSchema: SetKeyframesInput,
      outputSchema: WriteOutput,
      annotations: WRITE,
    },
    guard(async (a) => ({
      ...(await service.write(meta(a), {
        kind: "ops",
        ops: [{ op: "setTransformTrack", layer: a.layer, property: a.property, track: a.track }],
      })),
    })),
  );

  server.registerTool(
    "add_mask",
    {
      title: "Add mask",
      description:
        "Adds a mask to a drawing layer (not null or audio). Masks clip the layer in its own space and combine top-first by mode. Same as an addMask op; edit or remove masks with updateMask / removeMask in apply_ops.",
      inputSchema: AddMaskInput,
      outputSchema: WriteOutput,
      annotations: WRITE,
    },
    guard(async (a) => {
      const op = {
        op: "addMask",
        layer: a.layer,
        mask: {
          name: a.name ?? a.id ?? "Mask",
          mode: a.mode,
          inverted: a.inverted,
          path: a.path,
          feather: a.feather ?? { value: [0, 0] },
          opacity: a.opacity ?? { value: 1 },
          expansion: a.expansion ?? { value: 0 },
        },
        ...(a.id === undefined ? {} : { id: a.id }),
        ...(a.index === undefined ? {} : { index: a.index }),
      };
      return { ...(await service.write(meta(a), { kind: "ops", ops: [op] })) };
    }),
  );

  server.registerTool(
    "set_matte",
    {
      title: "Set track matte",
      description:
        "Shows a layer only where another layer of the same composition has alpha or brightness (luma), optionally inverted; null clears it. The source keeps its own visibility: hide it with update_layer if it should only act as the matte.",
      inputSchema: SetMatteInput,
      outputSchema: WriteOutput,
      annotations: WRITE,
    },
    guard(async (a) => ({
      ...(await service.write(meta(a), {
        kind: "ops",
        ops: [{ op: "setMatte", layer: a.layer, matte: a.matte }],
      })),
    })),
  );

  server.registerTool(
    "precompose",
    {
      title: "Precompose",
      description:
        "Moves layers of one composition into a new composition (same size, frame rate and duration, transparent) and replaces them with one precomp layer at the topmost one's position. The frame looks the same when the moved layers use the normal blend mode (others then blend inside the new composition, not with the layers below); the new layer can then be animated, masked or matted as a group. Returns the new composition in compositions_added.",
      inputSchema: PrecomposeInput,
      outputSchema: WriteOutput,
      annotations: WRITE,
    },
    guard(async (a) => {
      const op = {
        op: "precompose",
        layers: a.layers,
        ...(a.name === undefined ? {} : { name: a.name }),
        ...(a.composition_id === undefined ? {} : { id: a.composition_id }),
        ...(a.layer_id === undefined ? {} : { layerId: a.layer_id }),
      };
      return { ...(await service.write(meta(a), { kind: "ops", ops: [op] })) };
    }),
  );

  server.registerTool(
    "undo",
    {
      title: "Undo",
      description:
        "Reverts your own most recent write. Fails with a conflict, changing nothing, if a later edit touched the same properties.",
      inputSchema: UndoRedoInput,
      outputSchema: WriteOutput,
      annotations: DESTRUCTIVE,
    },
    guard(async (a) => ({ ...(await service.write(meta(a), { kind: "undo" })) })),
  );

  server.registerTool(
    "redo",
    {
      title: "Redo",
      description: "Re-applies the write you last undid, if the document still matches it.",
      inputSchema: UndoRedoInput,
      outputSchema: WriteOutput,
      annotations: DESTRUCTIVE,
    },
    guard(async (a) => ({ ...(await service.write(meta(a), { kind: "redo" })) })),
  );

  registerResources(server);

  return server;
}

const json = (uri: URL, value: unknown) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }],
});

/** Look-up data as MCP resources (ADR-0028). Tools cover the same data for clients that hide resources. */
function registerResources(server: McpServer): void {
  server.registerResource(
    "capabilities",
    RESOURCES.capabilities,
    {
      title: "Capability manifest",
      description:
        "What this build renders, accepts without rendering (and why), or lacks. Same as get_capabilities.",
      mimeType: "application/json",
    },
    (uri) => json(uri, capabilityManifest(SERVER)),
  );
  server.registerResource(
    "scene-schema",
    RESOURCES.scene,
    {
      title: "Scene document schema",
      description: `JSON Schema of a whole project document (format version ${SCENE_FORMAT_VERSION}).`,
      mimeType: "application/schema+json",
    },
    (uri) => json(uri, sceneJsonSchema()),
  );
  server.registerResource(
    "ops-schema",
    RESOURCES.ops,
    {
      title: "Scene operation schema",
      description: "JSON Schema of one scene operation: the item type of apply_ops.ops.",
      mimeType: "application/schema+json",
    },
    (uri) => json(uri, opJsonSchema()),
  );
  server.registerResource(
    "layer-schema",
    new ResourceTemplate(RESOURCES.layer, {
      list: () => ({
        resources: LAYER_TYPES.map((type) => ({
          uri: RESOURCES.layer.replace("{type}", type),
          name: `layer-schema-${type}`,
          title: `${type} layer schema`,
          mimeType: "application/schema+json",
        })),
      }),
      complete: { type: (prefix) => LAYER_TYPES.filter((t) => t.startsWith(prefix)) },
    }),
    {
      title: "Layer schema",
      description: "JSON Schema of one layer type without its id. Same as get_layer_schema.",
      mimeType: "application/schema+json",
    },
    (uri, { type }) => {
      const name = Array.isArray(type) ? type[0] : type;
      const known = LAYER_TYPES.find((t) => t === name);
      if (known === undefined)
        throw new McpError(
          ErrorCode.InvalidParams,
          `unknown layer type '${name}'; one of ${LAYER_TYPES.join(", ")}`,
        );
      return json(uri, layerJsonSchema(known));
    },
  );
}
