import { createHash } from "node:crypto";

/** Canonical JSON (sorted keys), so equal values hash equally regardless of key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Hex SHA-256 of a value's canonical JSON. */
export const fingerprint = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
