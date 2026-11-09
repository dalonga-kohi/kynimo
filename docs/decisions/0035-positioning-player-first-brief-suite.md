# 0035 — Positioning, player before editor, self-authored packs, the brief suite

- Status: accepted (amends ADR-0008 and ADR-0018: the human surface starts as a player, and the editor may grow past "simple" after beta; amends ADR-0002: adds a `review` tool group)
- Date: 2026-11-09

## Context

Anthropic released Claude Motion (beta, Team and Enterprise plans) in October 2026: Claude writes an animation as code in a chat artifact, the user edits by asking or in a light editor, and exports MP4. HyperFrames and Remotion with agent skills do the same job with HTML or React for coding agents. "An agent makes a motion video" is no longer a product by itself.

A product review on 2026-11-09, with M0–M3 nearly done, found four gaps between the plan and that market:

1. The docs never said why someone picks Kynimo over those tools.
2. Nothing measures whether a model can make a good video with the tools. Engine tests prove frames are correct, not that agents succeed.
3. PRODUCT.md assumed a professional motion designer would author the first guideline packs. Nobody is lined up.
4. The human surface was a simple editor at the very end (M8). The user sees nothing of their own until then except images in the chat.

## Decision

- **Positioning.** Kynimo is the specialised motion tool for everyone: any plan, any MCP client, with real motion depth (After Effects-grade layers, text animators, mattes, video, audio, beat sync), style packs with a quality report, and a structured document a person can finish in an After Effects-like workflow. PRODUCT.md keeps a dated comparison table.
- **Milestone order stays** (M4 depth → M5 guidelines → M6 components → M7 export → M8). The owner confirmed it knowing that no finished video exists before M7. Two tripwires are recorded in PRODUCT.md: pull a thin MP4 export forward if M4–M6 slip, and move components ahead of guidelines if the brief suite shows agents doing clearly better through code.
- **The brief suite.** A fixed set of briefs that a real model runs against the MCP server, with a report per run (completion, tool calls, rejected calls, tokens, contact sheets). It starts in M4 right after the intent tools and judges every later milestone that adds agent-facing tools. It runs on demand, outside CI, and only through MCP.
- **Packs are authored by us.** Tokens and rules come from published motion systems and frame-by-frame analysis of reference videos; each rule cites its source and is tuned on the brief suite. An outside motion designer's critique is a gate before public launch.
- **Player before editor.** M8 becomes the player and review surface: a share page on the shared renderer with scrubbing and live agent edits, frame-pinned comments the agent reads through `list_comments` / `resolve_comment`, and an in-chat player where the client renders MCP UI (client support is spiked first and gets its own ADR). The private beta opens after M8. The editor becomes M9, built during the beta. It starts with ADR-0008's simple scope plus ADR-0018's timing finish, and may grow toward an After Effects-like workflow; each step past simple is chosen from beta usage.
- **Listing budget.** `tools/list` stays under 60 KB as M4–M8 add tools.

## Consequences

- The private beta ships without an editing UI. "Humans finish" means comments and chat until M9, which weakens the one-liner for a while. That is accepted: the alternative was no human surface until the editor was done.
- Milestones can now fail on agent results with every test green. That is the point.
- The brief suite costs model tokens per run and its results vary between runs; reports compare trends, not single runs.
- Pack quality rests on us and on citations until the designer critique. Rules without a source don't ship.
- The comparison table goes stale fast. It carries its check date and is re-checked before each launch step.
- "A full After Effects-style editor" moves from non-goal to post-beta direction, which is a large future surface. It is not committed work.
