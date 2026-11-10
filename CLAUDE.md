@AGENTS.md

# Claude Code specifics

Everything shared with other agents lives in `AGENTS.md` (imported above). Only Claude Code–specific behavior goes here.

- **Questions:** use the `AskUserQuestion` tool for the "Ask, often" rule in AGENTS.md; recommendation first, marked "(Recommended)".
- **Review step:** run the **`reviewer`** subagent (Opus, `.claude/agents/reviewer.md`) on the branch diff. It follows `docs/REVIEW.md`.
- **Models:** main session runs on Sonnet (`.claude/settings.json`); the reviewer runs on Opus.
- **Skills:** `apple-design`, `impeccable`, `ui-ux-pro-max` and `pr` in `.claude/skills/` load natively via the Skill tool. Invoke `pr` before every `gh pr create`.
- **Shell:** Windows 11 + PowerShell.
