# 0036 — Scripts: agents write TypeScript that compiles to scene operations

- Status: accepted (extends ADR-0012: a third way code enters, at authoring time; amends ADR-0012: the scene-building TypeScript SDK moves from "direction" to beta; settles the sandbox technology for code that runs once, leaving per-frame component code to M6)
- Date: 2026-11-09

## Context

ADR-0035 named the risk: models have seen enormous amounts of JavaScript, HTML and React and no Kynimo operations. Claude Motion and HyperFrames let the model write code it already knows. Kynimo asks it to emit operation JSON through many tool calls, guided by a tool listing of about 52 KB. Intent tools (M4) shorten the calls but keep the shape of the problem: layout arithmetic, loops and repeated structure are done by the model in its head, one call at a time.

Code-first tools pay for their fluency: the code is the video, so nothing is editable or checkable without a developer. ADR-0001 and ADR-0012 rule that out. ADR-0012 already lets code in as components and shaders, but those run every frame and exist for procedural elements. They don't help an agent build an ordinary scene of text, shapes and keyframes.

After Effects solved the same problem for people with scripting: a program drives the application and leaves ordinary layers behind.

## Decision

- **Scripts.** An agent sends a TypeScript program to `run_script`. It runs **once**, at authoring time, against a typed SDK (`kynimo`), and its only output is a batch of scene operations. The host validates the batch against the scene schemas and applies it as one `apply_ops` batch. What lands in the document is ordinary layers and keyframes: editable, undoable as one step, inspected by quality rules, with no trace of code in the render path.
- **Three code paths, one rule.** Scripts build ordinary scenes (authoring time). Components produce procedural or data-driven elements (every frame, ADR-0012). Shaders produce pixel looks (ADR-0012). All three end in scene-graph nodes or typed operations; nothing draws outside them. Scripts become the path agents are steered to first for anything larger than a few edits.
- **The SDK mirrors the operations.** Its surface is generated from the operation and layer schemas plus the intent helpers (`animate`, `stagger`, presets, token names of the pinned pack), so it can't drift from what the tools accept. Its type declarations are served as an MCP resource and summarised in the tool description. A script reads a snapshot of the document (compositions, layers by id, name or selector) and writes only by recording operations.
- **Contract.** `run_script` takes `project_id`, `base_version`, `idempotency_key`, `source`, an optional `seed` and `dry_run`. It returns the new version, the ids it created and the op count, or errors with line and column. `dry_run` returns the operations without applying them. The source is kept with the change record so a later session can read, change and re-run it; the document never depends on it.
- **Repeatable.** A script has no clock and no ambient randomness; `kynimo.random()` is seeded from the call. The same source, seed and document version always give the same batch, so a retry and a dry run mean what they say.
- **Sandbox: QuickJS compiled to WebAssembly** (`quickjs-emscripten`), proven in `spikes/script-sandbox`:
  - A fresh WebAssembly instance per script, never shared. A script that exhausts memory can abort its instance; nothing else lives there.
  - No host objects are exposed. `Date` and `Math.random` are removed before user code runs; there is no module loader, timer, network or filesystem to reach.
  - Limits: memory, stack, a CPU budget counted in interrupt-handler calls (not wall-clock time), source size and op count. Starting values are the spike's (32 MB, 512 KB, 5 000 ops); the feature sets final ones and declares them in the tool schema.
  - TypeScript is handled by erasing types. Syntax that needs code generation (`enum`, namespaces, parameter properties) is refused with a clear error. Nothing is type-checked at run time.
- **The SDK is not the security boundary.** The sandbox and the host-side validation of every op are.
- **Order.** `run_script` is an M4 item, after the intent tools it builds on. The milestone order of ADR-0035 doesn't change.

Considered and not adopted:

- **HTML/CSS or free canvas-drawing layers.** They would give "anything in JavaScript", but as pixels the editor and the quality rules can't see into, and HTML can't be rendered by our pipeline at all (ADR-0016). A sandboxed canvas "painter" node, like a shader generator written in JavaScript, stays possible under ADR-0012's rules; it waits for evidence from the brief suite that components and shaders leave a gap.
- **`isolated-vm`** (V8 isolates): Node only and a native addon, so it can't later run component code in the browser preview.
- **Workers or iframes:** browser only, and the clock and randomness are ambient.
- **Running scripts client-side** in the agent's own code-execution tool: not every MCP client has one, and the server must validate the result anyway.

## Consequences

- One tool call can replace dozens, and the model writes loops and arithmetic in a language it knows. Whether this actually improves results is the brief suite's first comparison: the same briefs with and without `run_script`.
- A second surface to keep correct. Generating the SDK from the schemas, and a test that every operation is reachable from it, are part of the feature.
- Agents will send untrusted code to our servers from the first day the tool exists. The limits, the per-script instance and op validation are Blocking review items, as for all sandboxed code.
- `quickjs-emscripten` becomes a runtime dependency of the MCP server (about 1 MB of WebAssembly, MIT). Its interpreter is slower than V8 by a wide margin, which doesn't matter for a script that runs once and has to be measured for per-frame components.
- M6's sandbox spike narrows to one question: can the same sandbox evaluate component code per frame, in the browser, fast enough. If not, components need a different isolation and ADR-0012's "same code in preview and workers" needs care.
- PRODUCT.md's "TypeScript SDK for building whole scenes in code" leaves the non-goals. A local CLI and a code panel in the editor stay direction.
