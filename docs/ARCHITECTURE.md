# Kynimo — Architecture

Status: **initial direction**. Each section firms up as the feature that needs it is built; decisions land as ADRs in [decisions/](decisions/).

## System overview

```mermaid
flowchart LR
  subgraph Clients
    A1[Claude / ChatGPT / coding agents]
    W[Kynimo web app]
  end

  subgraph Cloud[Kynimo Cloud]
    MCP[MCP server<br/>remote, OAuth]
    API[Project API]
    OPS[Scene operations<br/>@kynimo/scene]
    STORE[(Project store<br/>versioned scene docs)]
    Q[Render job queue]
    R[Renderer workers<br/>headless Chromium]
    QC[Quality checks<br/>@kynimo/guidelines]
    OBJ[(Object storage<br/>frames, exports, assets)]
  end

  A1 -- MCP tools --> MCP
  W -- HTTP --> API
  MCP --> OPS
  API --> OPS
  OPS <--> STORE
  MCP -- preview / export --> Q
  API -- export --> Q
  Q --> R
  R --> OBJ
  MCP -- check --> QC
  QC -- reads --> STORE
  R -- reads --> STORE
```

Every write — from an agent, the web app or code — goes through the same **scene operations** layer and produces a new document version. Rendering and quality checks only ever read a specific document version.

## The four pillars

Capability target: the 2D core of After Effects, all of it reachable over MCP; the editor stays simple (ADR-0008, [CAPABILITIES.md](CAPABILITIES.md)).

### 1. Scene format — `@kynimo/scene`

- Versioned JSON scene graph: `Project → Composition[] → Layer[]` (shape, text, image, video, solid, null, precomp, adjustment, audio, component instance; parenting and masks/mattes between layers), each with animatable properties and keyframe tracks, plus a guideline pack reference pinned by version. A scene is a composition placed in the main composition's sequence; precomp layers reference compositions by id, with no cycles. Audio is audio layers; beat markers live on them. See [CAPABILITIES.md](CAPABILITIES.md#document-model).
- Schema-validated (runtime schemas + inferred TS types). `SCENE_FORMAT_VERSION` + migrations for every change.
- **Typed operations** (`addLayer`, `setKeyframes`, `applyPreset`, `retimeScene`, …) are the only way to mutate a document. They're pure: `(doc, op) → doc'` plus a change record, which gives undo, history and conflict detection for free.
- Time model: integer frames at the composition frame rate; seconds only at the API edge.

### 2. Guidelines — `@kynimo/guidelines`

- **Tokens:** color, typography, spacing, grid, safe areas; motion tokens (durations, springs as damping + response, easing curves, stagger rhythms).
- **Rules:** choreography and quality checks expressed as code over the scene graph + rendered frames, e.g. minimum on-screen time per word, maximum concurrent motions, contrast, safe-area bounds, token-only easing.
- **Output:** a machine-readable quality report (rule id, severity, location in the scene graph, suggested fix) that agents act on.
- Packs are data (versioned), so new styles and custom brand packs don't require code changes.

### 3. Components — `@kynimo/components`

- Typed props schema + defaults + a deterministic `evaluate(props, frame, style) → layer subtree` function.
- Components read the active guideline, so the same component looks right in every style.
- Built-in library first; custom components (user-authored TS) run in a sandbox with no host, filesystem, network or secret access.

### 4. Renderer — `@kynimo/renderer`

- v1: the scene is evaluated per frame and drawn in the browser (Canvas/SVG/DOM); the **same code** runs in the web preview and in headless Chromium workers for frames and exports (ADR-0004).
- Deterministic: fixed fonts and assets, seeded randomness, no wall-clock time.
- Encoding to MP4/WebM/GIF via FFmpeg in workers.

## Agent layer — `apps/mcp`

- Remote MCP server (Streamable HTTP) with OAuth; a local stdio mode for development.
- Tool groups (project, read, precise, intent, style, feedback, output) and design principles (batched `apply_ops`, selectors, compact reads, motion summaries, optimistic concurrency) are in [CAPABILITIES.md](CAPABILITIES.md#mcp-surface).
- Every tool: schema-validated input/output, returns the new document version, backward compatible.

## Web app — `apps/web`

Simple editor in v1: sign in, project list, viewer with timeline scrubbing, layer list, inspector, basic keyframe editing and share links, all on the same scene operations. It shows agent edits live. Later: frame-pinned comments that feed back to the agent.

## Package map (target)

| Path                  | Package                                                                                         | Created in       |
| --------------------- | ----------------------------------------------------------------------------------------------- | ---------------- |
| `packages/scene`      | `@kynimo/scene` — schema, types, operations, migrations                                         | M1 (stub exists) |
| `packages/engine`     | `@kynimo/engine` — timeline, interpolation, springs, behaviors, text animators, shape operators | M1               |
| `packages/renderer`   | `@kynimo/renderer` — frame drawing + headless capture                                           | M2               |
| `apps/mcp`            | MCP server                                                                                      | M3               |
| `packages/guidelines` | `@kynimo/guidelines` — tokens, packs, quality rules                                             | M5               |
| `packages/components` | `@kynimo/components` — built-in library + SDK                                                   | M6               |
| `apps/worker`         | render/export workers                                                                           | M7               |
| `apps/web`            | web app (Next.js on Vercel, ADR-0007) — placeholder exists                                      | M8               |

## Invariants

See [AGENTS.md](../AGENTS.md#architecture-invariants-reviewers-block-on-these): scene graph is the single source of truth · deterministic rendering · versioned schema with migrations · typed, backward-compatible MCP contracts · sandboxed custom components · quality enforced in code.

## Open questions (settled in the feature that needs them)

| Question                                                                            | Decide in |
| ----------------------------------------------------------------------------------- | --------- |
| ~~Runtime schema library~~ → Zod 4 (ADR-0009)                                       | done      |
| Drawing backend for v1 (must handle mattes, blend modes, effects deterministically) | M2        |
| Hosting for API/MCP and workers                                                     | M3 / M7   |
| Database for project store (Postgres flavor)                                        | M3        |
| Auth / OAuth provider                                                               | M3        |
| Job queue                                                                           | M7        |
| Object storage (M3, assets) + CDN for previews (M7)                                 | M3 / M7   |
| ~~Web framework~~ → Next.js on Vercel (ADR-0007)                                    | done      |
