/**
 * Emits TypeScript type declarations from the subset of JSON Schema that zod's
 * `toJSONSchema(schema, { reused: "ref", io: "input" })` produces for scene operations and intent
 * inputs: object / properties / required / additionalProperties, anyOf / oneOf / allOf, enum,
 * const, array / items / prefixItems, string / number / integer / boolean / null, `$ref` into
 * `$defs`. Anything else becomes `unknown`, so the output is always valid TypeScript.
 */

type Json = Record<string, unknown>;

export interface EmitRoot {
  /** Name of the emitted type. */
  name: string;
  /** Key of the root object schema's property this type is made from. */
  property: string;
  /** Doc comment for the type. */
  doc?: string;
}

export interface EmitOptions {
  roots: EmitRoot[];
  /** Type names already taken by hand-written declarations; generated names avoid them. */
  reserved?: string[];
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FLAT_WIDTH = 90;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const pascal = (key: string): string => {
  const words = key.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return /^[A-Za-z]/.test(name) ? name : `T${name}`;
};

/** True when `|` or `&` appears outside brackets and string literals. */
function hasTopLevelOperator(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c === '"') {
      for (i++; i < text.length && text.charAt(i) !== '"'; i++) {
        if (text.charAt(i) === "\\") i++;
      }
    } else if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if ((c === "|" || c === "&") && depth === 0) return true;
  }
  return false;
}

const refName = (ref: string): string => ref.replace(/^#\/\$defs\//, "");

const MAX_ALIAS_HOPS = 20;

const comment = (text: string, indent: string): string => {
  const clean = text.replace(/\*\//g, "* /").trim();
  if (clean === "") return "";
  const lines = clean.split("\n").map((l) => l.trim());
  return lines.length === 1
    ? `${indent}/** ${lines[0]} */\n`
    : `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join("\n")}\n${indent} */\n`;
};

/** Emits the declarations for the given roots. Output is deterministic. */
export function emitTypes(schema: Json, options: EmitOptions): string {
  const defs = isObj(schema.$defs) ? (schema.$defs as Record<string, Json>) : {};
  const rootProps = isObj(schema.properties) ? (schema.properties as Record<string, Json>) : {};

  /** A def that is only a reference to another def stands for that one. */
  const target = (id: string): string => {
    let current = id;
    for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
      const def = defs[current];
      if (!isObj(def) || typeof def.$ref !== "string" || Object.keys(def).length !== 1) break;
      current = refName(def.$ref);
    }
    return current;
  };

  // Names: roots first, then each def after the property that first reaches it.
  const taken = new Set<string>([...(options.reserved ?? []), ...options.roots.map((r) => r.name)]);
  const names = new Map<string, string>();
  const claim = (hint: string): string => {
    const base = pascal(hint);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
    taken.add(name);
    return name;
  };
  const visited = new Set<string>();
  const nameDefs = (node: unknown, hint: string): void => {
    if (Array.isArray(node)) {
      for (const n of node) nameDefs(n, hint);
      return;
    }
    if (!isObj(node)) return;
    if (typeof node.$ref === "string") {
      const id = target(refName(node.$ref));
      if (visited.has(id)) return;
      visited.add(id);
      if (!names.has(id)) names.set(id, claim(hint));
      nameDefs(defs[id], hint);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "properties" && isObj(value)) {
        for (const [prop, sub] of Object.entries(value)) nameDefs(sub, prop);
      } else if (key === "items" || key === "prefixItems" || key === "additionalProperties") {
        nameDefs(value, hint);
      } else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
        nameDefs(value, hint);
      }
    }
  };
  for (const root of options.roots) {
    const prop = rootProps[root.property];
    if (prop === undefined) throw new Error(`emitTypes: no property '${root.property}' in schema`);
    if (typeof prop.$ref === "string") {
      const id = target(refName(prop.$ref));
      if (!names.has(id)) names.set(id, root.name);
    }
    nameDefs(prop, root.name);
  }

  // Defs that are a short plain type are written in place instead of named.
  const hasRef = (node: unknown): boolean =>
    Array.isArray(node)
      ? node.some(hasRef)
      : isObj(node)
        ? "$ref" in node || Object.values(node).some(hasRef)
        : false;
  const inline = new Map<string, string>();
  const rootRefs = new Set(
    options.roots.flatMap((r) => {
      const ref = rootProps[r.property]?.$ref;
      return typeof ref === "string" ? [target(refName(ref))] : [];
    }),
  );
  for (const [id, def] of Object.entries(defs)) {
    if (hasRef(def) || rootRefs.has(id)) continue;
    const text = render(def, "");
    if (text.length <= 60 && !/[{\n]/.test(text) && typeof def.description !== "string") {
      inline.set(id, text);
    }
  }

  const used: string[] = [];
  const usedSet = new Set<string>();

  function ref(id: string): string {
    const text = inline.get(id);
    if (text !== undefined) return text;
    const name = names.get(id) ?? claim(id);
    names.set(id, name);
    if (!usedSet.has(id)) {
      usedSet.add(id);
      used.push(id);
    }
    return name;
  }

  function render(node: unknown, indent: string): string {
    if (node === true || (isObj(node) && Object.keys(node).length === 0)) return "unknown";
    if (!isObj(node)) return "unknown";
    if (typeof node.$ref === "string") return ref(target(refName(node.$ref)));
    if ("const" in node) return JSON.stringify(node.const) ?? "unknown";
    if (Array.isArray(node.enum)) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
    for (const key of ["anyOf", "oneOf"] as const) {
      const list = node[key];
      if (Array.isArray(list)) return union(list.map((n) => render(n, indent)));
    }
    if (Array.isArray(node.allOf)) {
      return node.allOf.map((n) => wrap(render(n, indent))).join(" & ");
    }
    if (isObj(node.not)) return Object.keys(node.not).length === 0 ? "never" : "unknown";
    const type = node.type;
    if (Array.isArray(type)) {
      return union(type.map((t) => render({ ...node, type: t }, indent)));
    }
    switch (type) {
      case "string":
        return "string";
      case "number":
      case "integer":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array":
        return renderArray(node, indent);
      case "object":
        return renderObject(node, indent);
      default:
        if (isObj(node.properties)) return renderObject(node, indent);
        return "unknown";
    }
  }

  /** Parentheses around a union or intersection so it can be an array element or an operand. */
  function wrap(text: string): string {
    return hasTopLevelOperator(text) ? `(${text})` : text;
  }

  function union(parts: string[]): string {
    const out = [...new Set(parts)];
    if (out.includes("unknown")) return "unknown";
    return out.length === 0 ? "never" : out.join(" | ");
  }

  function renderArray(node: Json, indent: string): string {
    if (Array.isArray(node.prefixItems)) {
      const items = node.prefixItems.map((n) => render(n, indent));
      if (isObj(node.items) && Object.keys(node.items).length > 0) {
        items.push(`...${wrap(render(node.items, indent))}[]`);
      }
      return `[${items.join(", ")}]`;
    }
    return `${wrap(render(node.items ?? {}, indent))}[]`;
  }

  function renderObject(node: Json, indent: string): string {
    const props = isObj(node.properties) ? (node.properties as Record<string, Json>) : {};
    const required = new Set(
      Array.isArray(node.required) ? node.required.filter((r) => typeof r === "string") : [],
    );
    const inner = `${indent}  `;
    const members: { text: string; doc: string }[] = [];
    for (const [key, sub] of Object.entries(props)) {
      const k = IDENT.test(key) ? key : JSON.stringify(key);
      const doc = isObj(sub) && typeof sub.description === "string" ? sub.description : "";
      members.push({ text: `${k}${required.has(key) ? "" : "?"}: ${render(sub, inner)}`, doc });
    }
    const extra = node.additionalProperties;
    if (extra === true || isObj(extra)) {
      members.push({ text: `[key: string]: ${render(extra, inner)}`, doc: "" });
    } else if (members.length === 0 && extra !== false) {
      members.push({ text: "[key: string]: unknown", doc: "" });
    }
    if (members.length === 0) return "Record<string, never>";
    const flat = `{ ${members.map((m) => m.text).join("; ")} }`;
    if (flat.length <= FLAT_WIDTH && !flat.includes("\n") && members.every((m) => m.doc === "")) {
      return flat;
    }
    const body = members.map((m) => `${comment(m.doc, inner)}${inner}${m.text};`);
    return `{\n${body.join("\n")}\n${indent}}`;
  }

  interface Entry {
    name: string;
    doc: string;
    body: string;
    root: boolean;
  }
  const list: Entry[] = [];
  const emitted = new Set<string>();
  for (const root of options.roots) {
    const prop = rootProps[root.property] as Json;
    const doc = root.doc ?? (typeof prop.description === "string" ? prop.description : "");
    const id = typeof prop.$ref === "string" ? target(refName(prop.$ref)) : undefined;
    const body = id !== undefined ? (defs[id] ?? {}) : prop;
    if (id !== undefined && !usedSet.has(id)) {
      usedSet.add(id);
      emitted.add(id);
    }
    list.push({ name: root.name, doc, body: render(body, ""), root: true });
  }
  // Rendering one def can reference more, so loop until the list is stable.
  for (let i = 0; i < used.length; i++) {
    const id = used[i] as string;
    if (emitted.has(id)) continue;
    emitted.add(id);
    const name = names.get(id) as string;
    if (options.roots.some((r) => r.name === name)) continue;
    const def = defs[id] ?? {};
    const doc = typeof def.description === "string" ? def.description : "";
    list.push({ name, doc, body: render(def, ""), root: false });
  }

  // Zod gives every reuse of an equal schema its own def. Merge types with the same body, and
  // types that are only another type's name, until nothing changes.
  const rename = (from: string, to: string): void => {
    const word = new RegExp(`\\b${from}\\b`, "g");
    for (const e of list) e.body = e.body.replace(word, to);
  };
  for (let again = true; again; ) {
    again = false;
    const byBody = new Map<string, string>();
    for (const [index, e] of list.entries()) {
      if (e.root) continue;
      const alias = /^[A-Z][A-Za-z0-9]*$/.test(e.body) ? e.body : undefined;
      const twin = byBody.get(`${e.doc}\n${e.body}`);
      const into = alias ?? twin;
      if (into !== undefined && into !== e.name) {
        list.splice(index, 1);
        rename(e.name, into);
        again = true;
        break;
      }
      byBody.set(`${e.doc}\n${e.body}`, e.name);
    }
  }
  return `${list.map((e) => `${comment(e.doc, "")}type ${e.name} = ${e.body};`).join("\n\n")}\n`;
}
