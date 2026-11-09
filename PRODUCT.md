# Kynimo — Product

## One-liner

**Motion graphics that agents create and humans finish.** An agent-first, cloud-hosted motion engine: any AI assistant connects over MCP, builds motion videos from components, keyframes **or code** on top of style guidelines, checks its own work, and exports a finished, fully editable video.

## The problem

- AI video generators (Sora, Veo, …) output pixels: you can't change a word, a color or a timing without regenerating.
- Code-first motion tools (Remotion, Motion Canvas) are editable only by developers, and AI-written animation code looks generic: linear easing, uniform timing, no hierarchy. Kynimo keeps code but puts it inside the editable scene graph: code-authored components and shaders read the guidelines, are edited through their props, and are quality-checked (shaders on rendered frames only) (ADR-0012).
- Professional tools (After Effects, Cavalry) are powerful but slow to learn and not built for agents.

## Where Kynimo stands

Checked November 2026; re-check before each launch step (ADR-0035).

| Alternative | What it is | Where Kynimo has to win |
| --- | --- | --- |
| **Claude Motion** (Anthropic, beta, Team and Enterprise plans) | Claude writes the animation as code inside a chat artifact; edit by asking or in a light editor; MP4 export. Zero setup. | Open to everyone on any plan and any MCP client. A specialised motion engine instead of a general artifact: real layers, keyframes, mattes, text animators, your video and audio, beat sync. A structured document a human can finish in an After Effects-like workflow. Style packs and a quality report. |
| **HyperFrames, Remotion + agent skills** | The agent writes HTML or React; a framework renders it. Models already know these languages well. | The result is editable by non-developers, checked against guidelines, and hosted: nothing to install, no project to maintain. |
| **After Effects, Cavalry** | Professional tools. | No learning curve: the assistant drives; the human only finishes. |

The honest trade: code-first tools start ahead on first-draft quality, because models have seen far more HTML and React than Kynimo operations. Kynimo closes that gap with intent tools, presets, components and guidelines (M4–M6), and has to prove it with the brief suite (below), not assume it.

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

## How we know it works

The first customer of every tool is a model. Engine tests prove frames are correct; they don't prove an agent can make a good video. So we keep a **brief suite**: a fixed set of realistic briefs (launch teaser, feature promo, kinetic quote, logo sting, social clip with footage) that a real model runs through the MCP server, start to finish. For each run we record whether it finished, tool calls, errors and retries, tokens, and the frames, which a person looks at. Milestones from M4 on are judged against it (ROADMAP.md).

Targets for the private beta:

- A first watchable draft from one brief in under 5 minutes and under 40 tool calls, with no human help.
- Fewer than 1 in 10 tool calls rejected; every rejection names its fix.
- Zero blocking findings in the quality report on the exported video.
- A person changes a word, a color and a timing in under a minute each, without regenerating anything.

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
- **Player first** (ADR-0035): the video plays where the user already is. An in-chat player in clients that render MCP UI, and a share page with scrubbing and frame-pinned comments that go back to the agent.
- **Editor second**, on the same operations: sign in, project list, viewer, timeline, layers, inspector, basic keyframe editing, an easing/spring and motion-path timing editor (ADR-0018). It starts simple and grows toward an After Effects-like workflow as beta users show what they finish by hand.

## Non-goals (for now)

- Component/template marketplace.
- Multi-agent orchestration.
- A full After Effects-style editor UI in v1 (the engine is AE-grade; the editor starts simple and grows toward that workflow after beta, ADR-0035).
- Long-form "motion movies" (the format supports chaining scenes; we prove quality on short pieces first).
- Voiceover generation, live/interactive runtime output.
- Not in v1, planned for v1.x (ADR-0013): 3D compositing (3D layers, cameras, lights), glTF 3D models with shader materials, Lottie import.
- Not in v1, direction only (ADR-0012): a TypeScript SDK for building whole scenes in code, a code panel in the editor, a local CLI.

## Business model (direction)

Open core, decided before public launch: the scene format and component SDK may be open-sourced for trust and ecosystem; the cloud (hosted MCP, rendering, storage, premium guideline packs) is the paid product, priced on render minutes plus plan tiers. Until then the repository is **public but unlicensed** (all rights reserved; see ADR-0006).

## Assumptions to confirm

- "Universal" means: works with any MCP-compatible client through one remote, cloud-hosted server.
- Short-form first; longer motion movies in a later phase.
- ~~A professional motion designer will help author the first guideline packs.~~ No designer is lined up. We author the first packs ourselves from published motion systems and analysis of reference videos, tested on the brief suite; an outside motion designer's critique is a gate before public launch, not a dependency for starting (ADR-0035).

## Risks we carry knowingly

- **No finished video until M7.** Export ships after motion depth, guidelines and components (order confirmed 2026-11-09). Until then nobody outside can use the product end to end, so the brief suite and rendered frames are our only evidence. If M4–M6 slip, pull a thin MP4 export forward first.
- **Custom format versus code.** If the brief suite shows agents doing clearly better through `define_component` than through operations and intent tools, move the component model (M6) ahead of guidelines (M5).
- **Tool listing weight.** `tools/list` is about 52 KB (ADR-0030) before M4–M7 add some twenty tools. Budget: the listing never grows past 60 KB; detail moves to on-demand schemas and resources.
- **A model vendor ships this for free.** Claude Motion can reach every plan at any time. Depth, any-client reach and the editable document are the defence; "available where Claude Motion isn't" is not.
- **Render cost.** Headless Chromium on a software rasterizer is slow per frame. Measure seconds per rendered second at the deploy item, before pricing on render minutes.

## Brand

- Name: **Kynimo** (from _kinetic_ + Latin _animo_). Pronunciation to be fixed on the landing page.
- Visual identity and design language: to be created in Paper and captured in `DESIGN.md`.
