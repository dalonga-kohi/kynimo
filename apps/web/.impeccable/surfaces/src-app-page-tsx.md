---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: ["src/app/beta/page.tsx"]
---

Scope: Kynimo landing (Persuade) and its `/beta` download page. Redesigned on 2026-11-10 at the user's request: fewer pseudo-demos, one coherent composition, direct copy. Reworked on 2026-11-14 for the Windows desktop beta: Kynimo is a desktop app that hosts the engine locally, not a cloud server. The palette, Mona Sans / Geist Mono, the K mark and the dither field are kept. The scroll-as-playhead concept was offered and declined; its 3D layer stack was kept.

Audience: developers, indie founders and marketers who already work with an AI agent. Action: try the Windows beta (the hero button opens `/beta`, which has the download). Proof: one scene drawn live, the layers it is made of, real MCP tool names, the desktop app, the depth of the engine.

## Direction contract

THESIS: A calm, centered dark landing where each section shows one true thing about the product once. No repeated fail-to-pass demos, no fake tool logs, no status dots.

OWN-WORLD: Warm near-blacks #0C0B0A / #171513 / #221F1C, screen-white #EDE8DF, dust #A39C90, marquee yellow #F5C842 as the only light (primary action, playhead, hover accents, the glow that follows the pointer over the hero). Mona Sans wide and heavy for display; Geist Mono only for code, tool names, frame numbers, timecode and thresholds. Hairlines, not cards. Motion-study echo (stroboscopic trail that closes into one sharp frame) on the hero's first line and the closing K mark.

STORY: Hero says what it is (motion graphics for your AI agent), plays one scene with its timeline, and offers one action: Try the beta. "Not a clip. A project." has no pinned scroll (tried on 2026-11-14 and dropped: awkward to scroll). The frame comes apart into five layers by itself as it enters the screen, beside the scene's layers panel: pointing at a layer lifts it out while the others step back, and one button changes the title and nothing else. What the agent does is a player: the step's name and tools beside a stage that draws that step on the hero's own scene, over a six-clip track that fills like a playhead (plays by itself, a click picks a step). The desktop app: it runs on your machine, real screenshots of three app screens behind a switcher, three facts in a hairline row. Features: six live studies, one per engine feature, in the page's palette. Questions. Close: the K mark settles, "Every frame, on purpose.", Try the beta. The `/beta` page is a single left-aligned column: headline, one download button, three install steps, what is in the beta, what is not. No frame-number labels, no eyebrows.

FIRST VIEWPORT: Centered two-line headline "Motion graphics / for your AI agent." over a centered dither field that lights up in yellow near the mouse, three lines of subcopy, one yellow action (Try the beta) and one text link (See how it works). The scene player starts inside the first viewport, tilted back, and sits up as it scrolls in.

FORM: Centered category landing with no scroll-jacking; the layers scene opens on view and is driven by its panel. Code-led. seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
