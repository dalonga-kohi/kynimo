@AGENTS.md

# Claude Code specifics

Everything shared with other agents lives in `AGENTS.md` (imported above). Only Claude Code–specific behavior goes here.

- **Questions:** use the `AskUserQuestion` tool for the "Ask, often" rule in AGENTS.md; recommendation first, marked "(Recommended)".
- **Orchestrator workflow.** The main session (Opus, `.claude/settings.json`) is the orchestrator: it shapes the feature with the user, reads the code it needs, makes the design decisions, branches, and owns the PR. It does not write the feature code itself. Every programming step goes to the **`implementer`** subagent (Sonnet, `.claude/agents/implementer.md`) with a written spec:
  - goal and scope of the step, and what is out of scope;
  - the decisions already made (data shapes, names, semantics, error behavior), so the implementer never has to design;
  - the files to read first and the existing feature to mirror;
  - the tests that must exist, and the commit message to use.

  Split large features into sequential steps (e.g. schema → engine → MCP surface → docs), one implementer run each, on the same branch. After each run, the orchestrator reads the diff and the report before starting the next step, and sends fixes back to the implementer rather than editing directly. Small fixes (a typo, a one-line doc change) the orchestrator may do itself.
- **Review step:** run the **`reviewer`** subagent (Opus, `.claude/agents/reviewer.md`) on the branch diff. It follows `docs/REVIEW.md`. It runs once per PR: its findings go back to the implementer as one fix spec, the orchestrator reads the fix diff and checks `pnpm check`, then opens the PR. No second review pass.
- **PR bodies:** invoke the **`pr`** skill (`.claude/skills/pr/SKILL.md`, from mattpocock/skills) before every `gh pr create`, and add the Review section AGENTS.md step 6 asks for.
- **Models:** orchestrator on Opus; implementer on Sonnet; reviewer on Opus.
- **Skills:** `apple-design`, `impeccable`, `ui-ux-pro-max` and `pr` in `.claude/skills/` load natively via the Skill tool.
- **Workflow skills (ours, not in `skills-lock.json`):**
  - `kynimo-next-item`: sync, find and shape the next roadmap item.
  - `kynimo-spec`: the implementer spec template, the step split, and the checklists for a new package, an MCP tool, untrusted-input hardening, reference scenes and docs.
  - `kynimo-ship`: one review pass, one fix pass, push, PR.

  Load them at those points instead of re-deriving the workflow.
- **Shell:** Windows 11 + PowerShell.
