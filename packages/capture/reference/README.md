# Reference scenes

Acceptance scenes whose frames a person has looked at and approved (ADR-0018, ADR-0023). CI renders every chosen frame in the pinned Chromium and compares it byte for byte with the approved PNG.

Each folder holds:

- `scene.json`: the document, in the real file format at the version it was written in.
- `reference.json`: what the scene covers, and the chosen `frames`.
- `assets/`: image and font files. Each asset's `uri` in the document is relative to the scene folder.
- `frames/<frame>.png`: the approved frames, with the frame number padded to three digits.

## When a frame changes

The test fails and writes the new frames to `renders/reference/<scene>/`. Look at them. If the change is intended, re-approve:

```bash
KYNIMO_UPDATE_GOLDEN=1 pnpm --filter @kynimo/capture test
```

This also rewrites `golden/determinism.json`. Look at every changed PNG before committing, and say in the PR why the frames moved.

## Adding a scene

Create the folder with `scene.json` and `reference.json`, add its name to `SCENES` in `src/reference.test.ts`, then run the command above and review the new frames.
