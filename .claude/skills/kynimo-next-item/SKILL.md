---
name: kynimo-next-item
description: Use when the user asks to sync with main and start "the next task/item" from the roadmap or plan (e.g. "implement the next M4 item"). Finds the item fast, reads only what it needs, and shapes it with the user before any code.
---

# Start the next roadmap item

Goal: get from "do the next thing" to an agreed design in a few calls without reading whole docs.

## 1. Sync (one call)

```bash
git status --short; git fetch origin main; git log --oneline -1 origin/main
```

- If the tree is dirty with work you don't recognise, stop and ask.
- If the session has a designated branch and it has no unmerged commits (`git log origin/main..HEAD` is empty, or the commits are already merged), reset it: `git checkout -B <branch> origin/main`.
- Otherwise branch per AGENTS.md (`feat/<slug>`).

## 2. Find the item (one call, no full-file reads)

```bash
sed -n 1,8p docs/ROADMAP.md                    # "Where we are" line
grep -n "^## M\|^- \[ \]" docs/ROADMAP.md | head -40
grep -n "^## " docs/PLAN.md                     # is there a plan section for it?
ls docs/decisions | tail -3                     # next ADR number
```

Skip items the user says to skip. Also skip these unless asked: items that need a real model or live clients (brief suite, deploy, "built only with MCP tools" reference scenes).

## 3. Read only what shapes the design

- The item's PLAN.md section, if one exists (`sed -n` the range).
- ADRs the roadmap line cites, and the latest ADR in the same area. Read the Decision section; skim the rest.
- `grep -n -i "<keyword>"` across `docs/CAPABILITIES.md`, `apps/mcp/src/capabilities.ts` (the `UNAVAILABLE` entry usually says what is missing) and `packages/*/src`.
- The closest shipped feature to mirror, usually the previous roadmap item. For a new MCP tool, read its `intentTool(...)` registration in `apps/mcp/src/server.ts` and its input schema in `apps/mcp/src/schemas.ts`.

Use `grep -n` plus `sed -n` ranges, not whole-file reads. Never `Read` a subagent output file.

## 4. Shape (one AskUserQuestion call)

- Restate the feature in 2–3 lines in chat.
- Ask at most 4 questions in one call, each with the recommendation first and marked "(Recommended)". The usual forks are:
  - where the code lives (new package or existing);
  - input shape;
  - dependency choice;
  - v1 scope (what is carried, what is reported or dropped).
- Decide small things yourself and say so.
- Don't ask about things the ADRs already decided.

Then create tasks (one per implementer step, plus "Review, fix, push, PR") and go to the `kynimo-spec` skill.
