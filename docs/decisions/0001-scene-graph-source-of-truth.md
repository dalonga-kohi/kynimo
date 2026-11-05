# 0001 — The scene graph is the single source of truth

- Status: accepted
- Date: 2026-11-05

## Context

Kynimo's promise is that every animation stays editable no matter who made it: an agent, code or (later) a human in an editor. Tools that let AI generate free-form animation code (e.g. React/Remotion components) produce output that a visual tool can't reliably inspect or modify afterwards.

## Decision

A versioned JSON scene graph is the only representation of a project. The MCP server, web app and code all mutate it through one shared set of typed, pure operations. Rendering and quality checks read a specific document version. Custom behavior enters only as components with declared, typed props that the scene graph instantiates.

## Consequences

- Editability, history, undo, diffing and conflict detection come from the document model.
- Agents get a structured, inspectable project instead of opaque code.
- Expressiveness is bounded by the format and the component model; anything new needs a schema change or a component.
- Schema evolution needs discipline: version bumps and migrations for every change.
