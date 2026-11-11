# 0046 — Component model: typed props, evaluate, style-aware

- Status: accepted
- Date: 2026-11-11

## Context

ADR-0012 says code enters a document only as component instances with declared, typed props, and ADR-0033 and the scene format already carry a `component` layer (`componentId`, `componentVersion`, `props`). Nothing evaluated it: the engine passed it through and the renderer skipped it. M6 needs a component model before any component can be built: how props are declared and checked, what `evaluate` receives and returns, how a component reads the document's style, and how the result reaches the renderer without storing it. Everything stays deterministic (same document and frame, same pixels) and the engine must not learn about guideline packs.

## Decision

- **A new package `@kynimo/components`** holds the model, the registry and the host. `BUILT_IN_COMPONENTS` is empty for now; the first components, `add_component` and the catalog resource are the next M6 items.
- **Prop descriptors** (`PropDescriptorSchema`, a discriminated union on `type`): `number` (min, max, default), `point`, `color`, `string`, `boolean`, `enum` and `asset`. At most 64 props per component (`MAX_PROPS_PER_COMPONENT`); a prop name matches `^[a-z][a-zA-Z0-9]{0,63}$`; point axes and number bounds are within ±65536 (`MAX_POINT`); a string has `maxLength` 1 to 10000 and a default within it; an enum has 1 to 32 unique values, each 1 to 64 characters, and a default among them. `defineComponent` validates and deep-freezes a definition and names the failing path.
- **Animatable props.** A descriptor with `animatable: true` takes a plain value or `{ keyframes }`, sampled with the engine's interpolation at the instance's local frame. Other props take plain values only. Missing props take their defaults; unknown props, wrong types and out-of-range values are errors naming the layer and the prop.
- **Color roles.** A `color` prop is a hex color or `{ role }` (a role of the pinned pack), resolved against the pack the project pins (`project.style`), or Keynote when it pins none (ADR-0037). A project that pins a pack missing from the build is an error.
- **`evaluate(props, ctx)`** is pure and returns `{ width, height, layers, background? }`. `ctx` carries `frame` (the instance's local frame), `fps`, `durationFrames` (`outFrame - startFrame`), `width`, `height`, `seed`, `depth`, a `random()` and a `style` (colors, type scale, spacing, motion from the pack). `seed = hashWords(0, UTF-16 code units of the layer id)` and `random` is `mulberry32(seed) / 2^32`, a fresh stream per call, so a component never touches `Math.random` or a clock.
- **The output is a composition.** The host builds a one-composition project from the output (fps from the parent, `durationFrames` at least the local frame plus one) and validates it with `ProjectSchema`. The project's assets are only the image and video assets the output references plus every font asset (text may use an uploaded family). Precomp layers and audio layers are rejected: a component draws, it does not link other compositions or add sound. Components may output other component instances, nested at most 4 deep (`MAX_COMPONENT_DEPTH`); the error names the chain.
- **Engine hook, not engine knowledge.** `evaluateFrame(project, frame, compositionId, { components })` takes a `ComponentHost` (`evaluate(layer, ctx) → Composition`). The engine resolves the returned subtree like a precomp at the local frame and exposes it as `ResolvedComponentLayer.composition`; it is `null` without a host or before the instance starts. The engine has no dependency on packs or components.
- **Not memoized, charged per evaluation.** The result depends on the instance (its id seed and props), not on a composition id, so subtrees are never shared; every evaluation charges the frame evaluation budget (ADR-0015) like the layers it returns.
- **Drawn as a precomp.** The renderer plans a component layer whose `composition` is set exactly like a precomp showing it: same raster size, masks, effects, matte, blend mode, and it can be a matte source. A component layer with `composition === null` inside its time range is skipped with the reason `component layer was not evaluated (no component host)`. The renderer does not depend on `@kynimo/components`. The capture page and the MCP service create a host per project and pass it to every `evaluateFrame`; the MCP asset loader also walks evaluated frames so a component's images and fonts are loaded.
- **Ids.** A component id matches the scene `ID_PATTERN`, a version is semver, and a document pins both. Whether project-defined (custom) ids share a namespace with built-ins is left to the M6 definition tools.
- **Errors.** Unknown id or version, bad props, a failing `evaluate` and an invalid subtree throw `RangeError`s naming the component and layer, truncated to 200 or 300 characters; they reach tools as `render_failed`.

## Alternatives considered

- **zod schemas as the props declaration.** They cannot be serialized for an agent-facing catalog or checked for limits, defaults and animatability without extra metadata; descriptors are data.
- **Static-only output (no frame in `ctx`).** Simpler, but then a component could not derive layout from animated props; keyframed props need the local frame.
- **Component code in the engine.** The engine would depend on packs and on every component; the host hook keeps it free of both and lets M6's sandbox replace the host.
- **Storing the evaluated subtree in the document.** It would duplicate the source of truth and stop the instance from being edited through its props (ADR-0012); the subtree is derived at render time.

## Consequences

- Instances render end to end (engine, renderer, capture page, MCP renders) and are deterministic; a capture test compares a fixture component with the equivalent precomp byte for byte.
- No scene format change, no reference scene, no golden changes: there are no built-in components yet.
- Follow-ups:
  - The spring settle check is not applied to prop keyframes; the export scene's check covers it.
  - The first built-in components, `add_component` and `build_from_brief`, with write-time prop validation, and the component catalog resource.
  - The host re-parses a `ProjectSchema` per instance per frame; measure it when real components land.
  - The sandbox spike for custom component code, and the custom-id namespace.
