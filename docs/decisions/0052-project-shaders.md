# 0052 — Project shader authoring

- Status: accepted (extends ADR-0012 and ADR-0045)
- Date: 2026-11-12

## Context

M6 needs editable custom generators and effects that agents can publish over MCP. Each scene version must keep rendering with the shader it pins. The same shader must fit the WebGL compositor and its CPU reference. ADR-0051 gates custom component publication on an evaluator that meets the isolation and browser performance requirements.

## Decision

- Scene format 10 adds a `custom-shader` variant to the generator and effect unions. The migration preserves the contents of older documents. Each instance pins a project-local shader id and exact semver and carries its own animatable uniform tracks. Scene writes validate the kind, uniform names, and the type of every keyframe against that pin. Instances use ordinary scene operations and undo history.
- `define_shader` uses a client-supplied idempotency key. The store commits the definition and the key outcome together in memory, on disk, and in Postgres. It keeps definitions across scene revisions. Publishing the same version with the same content is idempotent. A different title, source, kind or uniform descriptor requires a new version. SHA-256 covers these fields in canonical JSON, and the server verifies the hash when it loads definitions. Each project can keep up to 64 versions. Custom ids begin with `custom-`.
- `list_definitions` and the project shader catalog expose the ids, versions, hashes, kinds, and uniform descriptors. The global catalog describes the authoring interface and the built-ins.
- The language accepts a bounded GLSL ES 3.00 body with initialized `float` and vector locals and a final `vec4` return. It provides scalar and vector arithmetic, swizzles, selected math functions, and an effect-only `sampleInput` function. A parser and type checker emit trusted high-precision GLSL and a CPU reference from the same expression graph. The generated code has a fixed interface, with no extensions, user-defined functions, loops, or indirect texture access.
- A shader sees its layer-local frame, composition fps, target resolution, pixel position, normalized coordinates, a stable seed derived from document and layer ids, and declared uniforms. Effects can read one source texture through clamped, nearest texel sampling at LOD 0. Shader colors are straight sRGB. The compositor clamps the returned channels and premultiplies RGB for blending. Padded effect targets use their full raster dimensions for shader coordinates.
- The source limit is 4,096 characters and 192 tokens. A shader can declare eight uniforms and read at most four input texels per pixel. Arithmetic results are bounded to ±1,000,000 and division clamps the divisor magnitude to at least 0.000001. A server validates each new program on pinned Chromium with SwiftShader in a separate browser process, with a 10-second launch timeout and a five-second compile/link deadline. At most two validations run at once per server. Validation runs outside the project write lock. The server rechecks the key and version before committing and lets clients retry with the same key after a worker failure. The compositor charges 128 million custom shader work units across the frame, counting each emitted scalar value and charging an extra eight units per texture read, before dispatching each pass. The CPU reference applies the same cap and rounds shader intermediates to float32 to match GLSL highp.
- The compact tool-list budget rises from 97 KB to 105 KB and the capability manifest budget from 10 KB to 10.5 KB. The per-tool budget stays at 4.5 KB.
- Capture and export receive only the definitions pinned by the document. Caches remain project-scoped, and the immutable pins participate in the document hash.

## Consequences

Generators and single-input effects work in MCP frame capture, contact sheets, and export. Shader transitions with two inputs and the per-frame evaluator needed by `define_component` remain separate roadmap items.
