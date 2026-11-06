# 0012 — Code authoring: components and shaders that compile to the scene graph

- Status: accepted (extends ADR-0001: how code enters the scene graph)
- Date: 2026-11-06

## Context

Agents are good at writing code, and some motion (generative patterns, data-driven layouts, custom transitions, shader looks) is much easier to express in code than as keyframes. Code-first tools (Remotion, Motion Canvas) show the demand, but there the code _is_ the video: the result can't be edited visually, inspected by quality checks, or changed without a developer. ADR-0001 keeps the scene graph as the single source of truth, and code has to fit inside that promise, not around it.

## Decision

- **Code is a first-class way to build, next to components and keyframes.** Agents and users can author motion in code, and everything they write still produces scene-graph content.
- **Code-authored components.** A custom component is TypeScript with a declared, typed props schema and a deterministic `evaluate(props, frame, style) → layer subtree`. Its output is ordinary layers, keyframes and effects, so it previews, quality-checks, undoes and edits like built-in content. Props are animatable like any other property.
- **Custom shaders.** Users and agents can author GLSL fragment shaders with declared, typed, animatable uniforms (the shader's "props"). A shader is applied as an effect (on a layer or an adjustment layer) or used as a generator layer (backgrounds, textures). Kynimo also ships a built-in shader library.
- **Over MCP**, agents submit source with `define_component` and `define_shader`. Source is validated (schema, compile, sandbox rules) and stored at project level as a versioned, content-hashed definition. Documents pin a definition by id + version, like guideline packs, so publishing a new version never changes an existing document's pixels.
- **Sandboxed and deterministic.** Component code gets no host, filesystem, network, secret, clock or unseeded random access. Shaders get `frame`, resolution and declared uniforms only, no wall-clock time. Exact sandbox technology is decided in the M6 spike ADR.
- **Not v1:** a TypeScript SDK for building whole scenes in code, a code panel in the web editor, and a local CLI / dev mode. These are recorded as direction.
- Free-form code that draws pixels outside the scene graph (Remotion-style), and free-form JavaScript expressions, stay out (ADR-0001, ADR-0008).

## Consequences

- "Agents and users can create with code" becomes true without giving up editability: a code-authored element is a component or shader instance with editable props.
- The component model, the sandbox and the definition store become core M6 work. Custom GLSL needs the GPU renderer path (ADR-0013).
- Quality rules can inspect a component's output layers. A shader's output is pixels only, so only frame-based rules (contrast, safe areas on rendered frames) apply to it.
- Every definition version must stay renderable for as long as documents pin it. Deleting a definition must not break documents (they keep the pinned source).
- Shader determinism has to be proven on the pinned software rasterizer in workers (precision, no derivatives across undefined state); the browser preview stays visually equivalent, not bit-identical.
