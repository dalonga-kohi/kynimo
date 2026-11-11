import type { ComponentDefinition } from "./define.js";

export interface ComponentRegistry {
  get(id: string, version: string): ComponentDefinition | undefined;
  /** Every definition, sorted by id, then by version (numerically). */
  list(): ComponentDefinition[];
}

const versionKey = (v: string) => v.split(".").map(Number) as [number, number, number];
const byVersion = (a: string, b: string) => {
  const [x, y] = [versionKey(a), versionKey(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

export function createComponentRegistry(defs: readonly ComponentDefinition[]): ComponentRegistry {
  const byKey = new Map<string, ComponentDefinition>();
  for (const def of defs) {
    const key = `${def.id}@${def.version}`;
    if (byKey.has(key))
      throw new Error(`duplicate component '${key}'; each id and version may be registered once`);
    byKey.set(key, def);
  }
  const sorted = [...byKey.values()].sort(
    (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || byVersion(a.version, b.version),
  );
  return {
    get: (id, version) => byKey.get(`${id}@${version}`),
    list: () => [...sorted],
  };
}

/** The component library that ships with Kynimo. Empty until the built-in components land. */
export const BUILT_IN_COMPONENTS: readonly ComponentDefinition[] = [];

export const builtInRegistry: ComponentRegistry = createComponentRegistry(BUILT_IN_COMPONENTS);
