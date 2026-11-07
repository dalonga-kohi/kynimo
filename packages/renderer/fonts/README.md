# Bundled fonts

Every build ships these fonts, pinned by SHA-256 in `src/fonts.ts` (`BUNDLED_FONTS`). Documents name them by family (ADR-0019), so the list is part of the scene format: families can be added, never removed or renamed.

| Family    | File            | Source (google/fonts, `main`, fetched 2026-11-07) | License                                                |
| --------- | --------------- | ------------------------------------------------- | ------------------------------------------------------ |
| Inter     | `inter.ttf`     | `ofl/inter/Inter[opsz,wght].ttf`                  | SIL OFL 1.1 ([`inter-OFL.txt`](inter-OFL.txt))         |
| Noto Sans | `noto-sans.ttf` | `ofl/notosans/NotoSans[wdth,wght].ttf`            | SIL OFL 1.1 ([`noto-sans-OFL.txt`](noto-sans-OFL.txt)) |

Noto Sans is the fallback: it draws Latin, Greek and Cyrillic characters a document's font lacks.

Replacing a file changes pixels. Update its hash in `src/fonts.ts` in the same PR, and look at the text tests and reference frames it affects.
