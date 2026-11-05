# 0006 — Source-visible first, open core later

- Status: accepted (amended in place 2026-11-05: repository is public; originally "private first", hence the filename)
- Date: 2026-11-05

## Context

Open-sourcing the format and SDK can build trust and an ecosystem, but the boundary between open and paid parts, and the license, are hard to change once public.

## Decision

The repository is **public but unlicensed** during early development: anyone can read it, but no rights to use, copy or redistribute are granted (all rights reserved). Before public launch we decide the open-core split (likely: scene format + component SDK open; cloud, rendering, hosted MCP and premium guideline packs paid) and the license, recorded in a new ADR.

## Consequences

- Development is visible; never commit secrets, credentials, customer data or unreleased business details.
- Freedom to change the format and APIs without public compatibility commitments.
- Package boundaries should already be drawn so the likely open parts (`@kynimo/scene`, component SDK) don't depend on cloud-only code.
- Cloud-only code may later move to a private repository if the split requires it.
