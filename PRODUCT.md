# Kynimo — Product

## One-liner

**Motion graphics that agents create and humans finish.** An agent-first, cloud-hosted motion engine: any AI assistant connects over MCP, builds motion videos from components, keyframes **or code** on top of style guidelines, checks its own work, and exports a finished, fully editable video.

## The problem

- AI video generators (Sora, Veo, …) output pixels: you can't change a word, a color or a timing without regenerating.
- Code-first motion tools (Remotion, Motion Canvas) are editable only by developers, and AI-written animation code looks generic: linear easing, uniform timing, no hierarchy. Kynimo keeps code but puts it inside the editable scene graph: code-authored components and shaders read the guidelines, are edited through their props, and are quality-checked (shaders on rendered frames only) (ADR-0012).
- Professional tools (After Effects, Cavalry) are powerful but slow to learn and not built for agents.

## Who it's for (first)

Developers, indie founders and marketers who need **product launch videos, UI promos, social clips and explainer snippets**, already work with an AI assistant, and don't know or want After Effects.

## The core loop

```
Agent ──MCP──▶ Kynimo Cloud
  1. Pick a style      → guideline pack: brand, motion personality, typography
  2. Build             → scenes, components, text, keyframes, your media,
                         or code (custom components + shaders), all in the scene graph
  3. Render preview    → frames returned as images the agent can see
  4. Check             → automatic quality report against the guidelines
  5. Fix               → targeted edits
  6. Export            → MP4 / WebM / GIF + shareable preview link
```

**Flawless execution is enforced by the system, not hoped for from the model.** Guidelines are encoded as tokens and rules; the quality report tells the agent exactly what to fix.

## The four pillars

1. **Scene format** — a versioned JSON scene graph: compositions, scenes, layers, component instances, keyframes, style reference. The single source of truth and the reason everything stays editable.
2. **Guidelines** — complete motion design systems: visual tokens (color, type, spacing, grid, safe areas), motion tokens (durations, springs, easings, stagger rhythms), choreography rules, and automated quality checks (readability time, simultaneous motion, contrast, safe areas, token-only easing). Shipped as style packs ("Keynote", "Editorial", "Brutalist", "Playful SaaS", custom brand packs).
3. **Components and code** — reusable, typed building blocks (kinetic type, logo reveals, device mockups, charts, lower thirds, transitions, backgrounds) that read the active guideline. **Agents and users write their own in code:** custom components in TypeScript and custom shaders in GLSL, sandboxed, with declared, animatable props. Code enters the document only as component or shader nodes with editable props, so it stays editable and quality-checked (ADR-0012).
4. **Render cloud** — deterministic rendering: fast preview frames for the agent's check step, background export jobs, preview links.

## v1 scope

- Short-form motion graphics: **5–60 seconds**.
- **After Effects-grade 2D engine** (beta subset): precomps, parenting, shape operators, text animators, bezier/spring keyframes, masks, mattes, blend modes, core effects, seeded behaviors. Full list: [docs/CAPABILITIES.md](docs/CAPABILITIES.md) (ADR-0008).
- Every engine capability reachable over MCP through batched, intent-aware tools.
- **Code authoring:** agents define custom components (TypeScript) and shaders (GLSL) over MCP (`define_component`, `define_shader`); built-in shader library for 2D effects, backgrounds and transitions (ADR-0012).
- **Your own media:** photos, video (screen recordings, footage), SVG vectors and custom fonts (ADR-0013).
- Remote MCP server usable from any MCP client, with OAuth sign-in.
- Built-in guideline packs + component library v1.
- Preview frames, quality report, MP4 / WebM / GIF export, shareable preview links.
- Music track with beat markers (motion timed to the beat).
- Simple web editor on the same operations: sign in, project list, viewer, timeline, layers, inspector, basic keyframe editing, share links. Usable on its own; most users will work through their assistant.

## Non-goals (for now)

- Component/template marketplace.
- Multi-agent orchestration.
- A full After Effects-style editor UI (the engine is AE-grade; the editor stays simple).
- Long-form "motion movies" (the format supports chaining scenes; we prove quality on short pieces first).
- Voiceover generation, live/interactive runtime output.
- Not in v1, planned for v1.x (ADR-0013): 3D compositing (3D layers, cameras, lights), glTF 3D models with shader materials, Lottie import.
- Not in v1, direction only (ADR-0012): a TypeScript SDK for building whole scenes in code, a code panel in the editor, a local CLI.

## Business model (direction)

Open core, decided before public launch: the scene format and component SDK may be open-sourced for trust and ecosystem; the cloud (hosted MCP, rendering, storage, premium guideline packs) is the paid product, priced on render minutes plus plan tiers. Until then the repository is **public but unlicensed** (all rights reserved; see ADR-0006).

## Assumptions to confirm

- "Universal" means: works with any MCP-compatible client through one remote, cloud-hosted server.
- Short-form first; longer motion movies in a later phase.
- A professional motion designer will help author the first guideline packs.

## Brand

- Name: **Kynimo** (from _kinetic_ + Latin _animo_). Pronunciation to be fixed on the landing page.
- Visual identity and design language: to be created in Paper and captured in `DESIGN.md`.
