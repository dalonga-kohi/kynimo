---
name: kynimo-ship
description: Use when all implementer steps of a feature are committed and it is time to review, fix, push and open the PR (AGENTS.md steps 4–7). One review pass, one fix pass, then ship.
---

# Review, fix, ship

## 1. Review (once per PR)

Run the `reviewer` subagent in the background. Its prompt should name:

- the branch and `git diff origin/main...HEAD`;
- a one-paragraph feature summary;
- decisions already accepted, so it doesn't re-raise them (budget raises, follow-ups, known non-goals);
- focus areas: for anything taking untrusted text, ask for measured hostile-input checks (ReDoS, non-finite numbers, unbounded output, silent drops).

## 2. One fix spec

- Verify that the findings are concrete: file:line plus a measurement. Then send **every Blocking and Should-fix item, plus cheap nits**, to the implementer as one spec.
- Decide each fix's semantics in the spec, so the implementer doesn't design. Tell it to stop and report if a reference frame changes.
- If you disagree with a finding, ask the user. Don't skip it silently.
- No second review pass, however large the fixes.

## 3. Check the fix pass

```bash
git log --oneline origin/main..HEAD; git diff --stat <before-fix>..HEAD
git diff <before-fix>..HEAD -- packages/capture/reference   # must be empty unless explained
pnpm check
```

## 4. Ship

- `git fetch origin main`; rebase if main moved, then re-run `pnpm check`.
- `git push -u origin <branch>`, retrying with backoff on network errors only.
- Load the `pr` skill and write Summary, Evidence (test counts, measured numbers, the reference PNGs looked at), Merge Danger (new deps, budget raises, shared config touched) and a **Review** section (verdict, each Blocking/Should-fix item and how it was fixed).
- Open the PR with `mcp__github__create_pull_request` (load it via ToolSearch); `gh` is not available in cloud sessions. End the body with the attribution footer from the system reminder.
- Ask before merging, and offer to watch the PR (`subscribe_pr_activity`).

## Report to the user

A few lines:

- what shipped and the PR link;
- the measured evidence;
- what the review caught;
- the follow-ups noted, not done.
