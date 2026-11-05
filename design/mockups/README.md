# Kynimo web mockups

Static HTML mockups of the landing page and the main workspace, in the Screening Room direction (tokens mirror the Paper file "Kynimo — Design"). They're design references for the real `apps/web` build, not production code.

## Open them

The pages load shared CSS and JS, so they need a local server (opening the files directly won't load the assets):

```bash
pnpm dlx serve@14.2.4 design/mockups -l 4321
```

Then open <http://localhost:4321/landing> and <http://localhost:4321/workspace>. In Claude Code's desktop app, the `mockups` entry in `.claude/launch.json` starts the same server.

## What's in them

- `landing.html`: Persuade surface. The hero shows an assistant building a launch video live: layers and clips land, the frame resolves from ordered dither to colour through shutter slits, checks fail, the agent fixes them. Below that: the loop on a scroll-linked timeline, the quality report with before/after, an editable scene you can type into, four style packs on one project, and connect steps per client.
- `workspace.html`: Operate surface. A Paper-style live canvas: you talk to the agent in your MCP client (for example Claude Code), and the workspace shows its tool calls, what it's editing, and the findings pinned to elements and frames. Your selection is shared with the agent. Scrub the timeline (space, ← →, Shift for 10 frames), click a layer or a finding pin, edit text and position in the Inspector.
- `assets/kynimo-composition.js`: a small stand-in for the engine. A scene document (scenes → layers → keyframe tracks), a deterministic per-frame canvas renderer, critically damped and bouncy springs, guideline packs, the ordered dither and the shutter-slit wipe. Both pages render the same document.

Reduced motion: no autoplay, typing or wipes. Pages render their final state and controls still work.

## Synthetic content to replace

- "Relay 2.0" and everything in its video (product, features, relay.dev) is fictional.
- `https://mcp.kynimo.com/mcp` is a placeholder endpoint. The Claude, ChatGPT and Cursor setup steps need checking against each client's current UI.
- The track "Brightside — 120 BPM" and its waveform are generated.
- Fonts load from Google Fonts here. Production should self-host Archivo, Geist and Geist Mono.
