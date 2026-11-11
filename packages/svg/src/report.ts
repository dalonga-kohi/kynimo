import type { FidelityEntry, FidelityKind } from "./types.js";
import { labelOf, type XNode } from "./xml.js";

const MAX_EXAMPLES = 5;

/** Collects fidelity entries, aggregated by (kind, feature). */
export class ReportCollector {
  private readonly entries = new Map<string, FidelityEntry>();

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

  sorted(): FidelityEntry[] {
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
