# Spec checklists

Paste the ones that apply into the implementer spec.

## New package

- Mirror `packages/intent`: `package.json` (`"type": "module"`, exports `./dist/index.js`, scripts build/typecheck/test), `tsconfig.json`, `tsconfig.build.json`. Nothing else enumerates packages.
- Add it to the package map table in `docs/ARCHITECTURE.md`.
- Each runtime dependency gets a justification in the report: size, transitive deps, maintenance. Check the transitive count; don't take "zero-dep" on trust.
- A package consumed by `packages/capture` tests is read from `dist`, so building it first matters when you run capture tests alone.

## MCP intent tool (apps/mcp)

- Register with `intentTool(name, title, description, Input, RequestSchema, expansion)` in `server.ts`, next to `add_effect`. The expansion is a pure `(doc, input) => { ops, resolved }`, so dry_run and idempotency come for free from `service.intent`.
- Inputs:
  - `schemas.ts`: `Input = z.object({ ...intentMeta, ... })`.
  - No tuples in listed schemas: `listing.test.ts` forbids `items:[`, so use `z.array(z.number()).length(2)`.
  - Keep descriptions to one short line.
- Errors:
  - Throw `IntentError(path, message)`; it surfaces as an `invalid` tool error at that path and writes nothing.
  - Messages name the limit and what to do instead.
- Replies:
  - Never echo bulk content (whole layers, contents trees) in `ops`, `resolved` or `expanded_ops`.
  - Put a size assertion on a large input in the tests.
- Ids: generate deterministically from existing project ids (e.g. `svg`, `svg-2`). Layer ids are project-wide.
- `capabilities.ts`: remove the `UNAVAILABLE` entry the feature replaces, and add the shipped entry; update `capabilities.test.ts`.
- Add one line to the server instructions string in `server.ts`, and update any error message that pointed users elsewhere.
- Listing budget: `server.test.ts` asserts the `tools/list` size. A write tool adds about 2 KB. If you must raise the budget, say so in the report, the ADR and the M8 roadmap line.
- Tests go in `server.intent.test.ts`: the happy path, defaults, dry_run (version unchanged), invalid input (path + version unchanged), idempotent replay. A replay returns `replayed` + `layers_added`, not `ops`/`resolved`.
- Docs: add the tool to `apps/mcp/README.md` and to the tools table in `docs/CAPABILITIES.md`.

## Untrusted input: importers, parsers, anything taking agent text

The reviewer found all of these in the SVG import; put them in the first spec.

- **Linear regexes only.**
  - No adjacent quantifiers that can match the same characters (`\s*,?\s*` → `\s*(?:,\s*)?`).
  - No lazy `.*?` between anchors and `\s*`.
  - No `\d+\.?\d*`: use the one shared `[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`.
  - Prefer hand-parsing delimiters (`indexOf`, `endsWith`) over regex.
  - Test each parser with about 400 KB of spaces or digits in one value, completing in under 1 s.
- **Finite output.** Run a final pass so every number in the output is `Number.isFinite`; otherwise throw a clear limit error. Overflow cases to test: `1e308` relative adds, `matrix(1e200 …)` decomposition, tiny viewBox/size → Infinity scale, a user-supplied scale factor.
- **Bounded work.** Cap size in bytes before parsing, element count, nesting depth (set the parser's own depth option to the same limit, and test limit−2 passes and limit+1 fails with the right number in the message), reference expansion (depth, count, cycles), and total output (vertices, items).
- **No entity expansion.** Reject `<!ENTITY` before parsing XML; keep only built-in and numeric entities.
- **Iterative walks** over input-shaped trees, or recursion bounded by a checked depth.
- **Bounded report text.** Truncate echoed ids and tags (about 60 chars), keep at most 5 examples per entry, and build labels lazily.
- **Nothing silently dropped.**
  - Use an allow-list of carried-or-harmless properties and attributes. Everything else goes in a generic `unsupported-property` report entry.
  - Report conditional or structural features you simplify, such as `switch`, viewport clipping and root transforms.
- **Determinism.** No Date, Math.random or locale formatting; round output (e.g. 6 significant digits); same input → deep-equal output.

## Fidelity against a reference renderer (imports and exports)

- In `packages/capture`, render the fixture with our pipeline and the same source natively in the pinned Chromium (`openCapturePage()` + `page.evaluate`, image on a white canvas; base64 from Node, not `btoa`).
- Compare RGBA two ways: the share of pixels with max channel diff > 48 (< 0.5%), and the mean abs diff (< 1.5).
- Fixtures must produce an empty fidelity report, so the comparison measures exact features only.
- On failure, write ours, native and diff PNGs to git-ignored `renders/`.
- Put the measured numbers in the ADR.

## Reference scene (ADR-0018, ADR-0023)

- `packages/capture/reference/<name>/`: `scene.json`, `reference.json` (description + frames), approved `frames/NNN.png`; add the name to `SCENES` in `src/reference.test.ts`.
- If the scene is derived from a source (an SVG, a script), keep the source next to it, plus a test that fails when `scene.json` is stale.
- Don't pick frames where everything is at opacity 0.
- Approve with `KYNIMO_UPDATE_GOLDEN=1 pnpm --filter @kynimo/capture test`. Open every PNG with Read and describe it in the report, and confirm no other reference frame or `golden/determinism.json` changed.

## Docs (last step)

- ADR `docs/decisions/NNNN-<slug>.md` from `0000-template.md`, in the style of the latest ADR:
  - decisions with their numbers and limits;
  - alternatives, one line each;
  - consequences and follow-ups.
- `docs/ROADMAP.md`:
  - tick the item with `→ ADR-NNNN: <one-line summary>` like its neighbours;
  - update the "Where we are" line.
- Delete the item's `docs/PLAN.md` section if it had one.
