import type { FidelityEntry, FidelityKind } from "./types.js";
import { labelOf, type XNode } from "./xml.js";

const MAX_EXAMPLES = 5;
const MAX_PROPERTY_NAMES = 10;

/** Collects fidelity entries, aggregated by (kind, feature). */
export class ReportCollector {
  private readonly entries = new Map<string, FidelityEntry>();
  private readonly properties = new Set<string>();

  /** The label is only built while the entry still has room for examples. */
  add(kind: FidelityKind, feature: string, node: XNode | undefined, detail: string): void {
    const key = `${kind}\u0000${feature}`;
    let entry = this.entries.get(key);
    if (entry === undefined) {
      entry = { kind, feature, count: 0, elements: [], detail };
      this.entries.set(key, entry);
    }
    entry.count++;
    if (node !== undefined && entry.elements.length < MAX_EXAMPLES) {
      const label = labelOf(node);
      if (!entry.elements.includes(label)) entry.elements.push(label);
    }
  }

  /** `dropped / unsupported-property` for one property; the detail lists up to 10 distinct names. */
  addProperty(node: XNode, name: string): void {
    const shown = name.length > 40 ? `${name.slice(0, 40)}…` : name;
    if (this.properties.size < 1000) this.properties.add(shown);
    this.add("dropped", "unsupported-property", node, "");
  }

  sorted(): FidelityEntry[] {
    const all = [...this.properties];
    const names = all.slice(0, MAX_PROPERTY_NAMES).join(", ");
    const more =
      all.length > MAX_PROPERTY_NAMES ? ` and ${all.length - MAX_PROPERTY_NAMES} more` : "";
    for (const e of this.entries.values()) {
      if (e.feature !== "unsupported-property") continue;
      e.detail = `Style properties are not applied, so the shapes draw without them: ${names}${more}. Recreate the look with layer settings (blend mode, opacity) or separate shapes.`;
    }
    return [...this.entries.values()].sort((a, b) =>
      a.kind !== b.kind
        ? a.kind < b.kind
          ? -1
          : 1
        : a.feature < b.feature
          ? -1
          : a.feature > b.feature
            ? 1
            : 0,
    );
  }
}
