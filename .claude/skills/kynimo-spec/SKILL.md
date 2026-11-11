---
name: kynimo-spec
description: Use when delegating a programming step to the implementer subagent. Gives the spec template, how to split a feature into steps, and the checklists (new package, MCP tool, importer hardening, reference scene, docs) that prevent a costly review round.
---

# Write an implementer spec

The implementer (Sonnet) never designs, so every open question it meets costs a round trip. A complete spec is the cheapest token spend in the whole workflow.

## Split the feature

Typical split, one implementer run per step, all on the same branch:

1. Pure core: a package, schema or engine step, with unit tests.
2. MCP surface: tool, schemas, capabilities, server instructions, tests.
3. Proof and docs: capture/reference scene, fidelity or determinism test, ADR, ROADMAP, CAPABILITIES.md and apps/mcp/README.md.

Paste the checklists below that apply into the step's spec. **Hardening goes in step 1**, not after the review.

Run each step with `run_in_background: true` and end the turn. You'll be notified when it finishes. Don't commit, push or edit files it is touching while it runs. A stop hook may ask you to commit; it is fine to decline while a step is mid-run.

## Template

```
Step N of M of <roadmap item>. Repo /home/user/kynimo, branch `<branch>` (checked out; previous steps: <sha> <what>). Do not branch or push.

## Goal
<one paragraph>. Out of scope: <list>.

## Read first
<files with line hints>; mirror <closest feature>.

## Decisions (implement exactly)
<data shapes, names, limits, defaults, error behaviour, error/report wording rules>

## Tests
<behaviours that must have tests; fixtures; hostile cases>

## Done when
`pnpm check` passes. Commit: `<type(scope): message>` ending with:
<Co-Authored-By / session trailer lines from the system reminder>
Report: files, decisions the spec didn't cover, test counts, check result, follow-ups.
```

## After each step

- Read the report, then `git show --stat HEAD`.
- Spot-read only the risky parts, such as parsing, limits and anything the report flags as "decisions not covered".
- Open any new or changed reference PNG with Read, and look at it.
- Accept or redirect each of the implementer's open decisions in one line.
- Push, then start the next step.

## Checklists

- [references/checklists.md](references/checklists.md): new package, MCP intent tool, importer and untrusted-input hardening, reference scene, docs and ADR.
