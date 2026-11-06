# 0012 — Code authoring: components and shaders as scene-graph nodes

- Status: accepted (extends ADR-0001: how code enters the scene graph; amends ADR-0008: adds a `code` MCP tool group)
- Date: 2026-11-06

## Context

Agents are good at writing code, and some motion (generative patterns, data-driven layouts, custom transitions, shader looks) is much easier to express in code than as keyframes. Code-first tools (Remotion, Motion Canvas) show the demand, but there the code _is_ the video: the result can't be edited visually, inspected by quality checks, or changed without a developer. ADR-0001 keeps the scene graph as the single source of truth, and code has to fit inside that promise, not around it.

## Decision

- **Code is a first-class way to build, next to components and keyframes.** Agents and users can author motion in code. Code enters a document only as scene-graph nodes (component instances, shader effects, shader generator layers) with declared, typed props; nothing draws outside those nodes.
- **Code-authored components.** A custom component is TypeScript with a declared, typed props schema and a deterministic `evaluate(props, ctx) → layer subtree`, where `ctx` holds the layer-local frame, the composition fps, the resolved style tokens and a seeded RNG derived from the document. **`evaluate` runs every frame** and returns a static layer subtree for that frame; the subtree is derived at render time, never stored. The document stores only the instance and its props, so the instance is edited, undone and diffed through its props (which are animatable like any property), and quality rules inspect the evaluated subtree at the frames they sample.
- **Custom shaders.** Users and agents can author GLSL ES 3.00 fragment shaders with declared, typed, animatable uniforms (the shader's "props"). A shader is applied as an effect (on a layer or an adjustment layer; a transition effect gets two inputs) or used as a generator layer (backgrounds, textures). Its inputs are fixed: the input texture(s) for effects, the layer-local frame, the composition fps, the output resolution, a seed derived from the document, and its declared uniforms. Kynimo also ships a built-in shader library.
- **Over MCP**, agents submit source with `define_component` and `define_shader`. Source is validated (schema, compile, sandbox rules) and stored at project level as a definition: the caller gives a semver version, and **a stored version is immutable** (re-defining it with different source is rejected). The store records each version's content hash. Documents pin a definition by id + version, like guideline packs; because versions are immutable, id + version identifies the exact source, so publishing a new version never changes an existing document's pixels. Custom definition ids live in a project namespace that can't collide with built-in ids (exact id shape decided in M6).
- **Sandboxed, bounded and deterministic.** Component code gets no host, filesystem, network, secret, clock or unseeded random access, and runs under CPU-time and memory budgets per frame. Shaders get only the inputs above, never wall-clock time, and are validated on submit against fixed limits (language version, allowed extensions, bounded loops, texture and instruction limits, compile timeout); a shader that exceeds its draw budget fails the render with a validation error instead of hanging a worker or the editor's GPU. Exact sandbox technology and the shader validation rules are decided in the M6 spike ADR.
- **Not v1:** a TypeScript SDK for building whole scenes in code, a code panel in the web editor, and a local CLI / dev mode. These are recorded as direction.
- Free-form code that draws pixels outside the scene graph (Remotion-style), and free-form JavaScript expressions, stay out (ADR-0001, ADR-0008).

## Consequences

- "Agents and users can create with code" becomes true without giving up editability: a code-authored element is a component or shader instance with editable props.
- The component model, the sandbox and the definition store become core M6 work. Custom GLSL needs the GPU renderer path (ADR-0013).
- Quality rules can inspect a component's evaluated layers. A shader's output is pixels only, so only frame-based rules (contrast, safe areas on rendered frames) apply to it.
- Every definition version must stay renderable for as long as any document version pins it. "Deleting" a definition only hides it from catalogs while it is still pinned. If definitions are ever shared across projects, the pin may need the content hash too; that's a schema change with a migration.
- Shader determinism has to be proven on the pinned software rasterizer in workers: `highp` precision required, derivative (`dFdx`/`dFdy`) and texture LOD behavior pinned, no reads of undefined texels. The browser preview stays visually equivalent, not bit-identical.
