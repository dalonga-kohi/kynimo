# 0006 — Private first, open core later

- Status: accepted
- Date: 2026-11-05

## Context

Open-sourcing the format and SDK can build trust and an ecosystem, but the boundary between open and paid parts, and the license, are hard to change once public.

## Decision

The repository stays private with no license file during early development. Before public launch we decide the open-core split (likely: scene format + component SDK open; cloud, rendering, hosted MCP and premium guideline packs paid) and the license, recorded in a new ADR.

## Consequences

- Freedom to change the format and APIs without public compatibility commitments.
- Package boundaries should already be drawn so the likely open parts (`@kynimo/scene`, component SDK) don't depend on cloud-only code.
