import { Converter } from "./convert.js";
import type { SvgImportResult } from "./types.js";
import { parseSvg } from "./xml.js";

export {
  type FidelityEntry,
  type FidelityKind,
  SVG_LIMITS,
  SvgImportError,
  type SvgImportErrorCode,
  type SvgImportReport,
  type SvgImportResult,
} from "./types.js";

/**
 * Converts SVG text into shape-layer contents plus a fidelity report. Pure and deterministic.
 * Throws `SvgImportError` for input it refuses; everything else it cannot carry is in the report.
 */
export function importSvg(source: string): SvgImportResult {
  return new Converter(parseSvg(source)).convert();
}
