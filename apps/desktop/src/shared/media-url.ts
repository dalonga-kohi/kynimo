export const MEDIA_SCHEME = "kynimo-media";

export type MediaKind = "thumb" | "preview";

export interface MediaRequest {
  kind: MediaKind;
  id: string;
  version: number;
}

// The store's id format (PROJECT_ID_PATTERN in @kynimo/mcp). The renderer never names a path.
const PROJECT_ID = /^p-[a-f0-9]{32}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;

export const mediaUrl = (kind: MediaKind, id: string, version: number): string =>
  `${MEDIA_SCHEME}://${kind}/${encodeURIComponent(id)}/${version}`;

/** Reads a `kynimo-media://thumb|preview/<id>/<version>` URL; anything else is undefined. */
export function parseMediaUrl(raw: string): MediaRequest | undefined {
  // A valid URL never needs these; URL parsing would resolve some of them away and accept the rest.
  if (/\.\.|%2e|%2f|%5c|\\/i.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${MEDIA_SCHEME}:`) return undefined;
  if (url.hostname !== "thumb" && url.hostname !== "preview") return undefined;
  if (url.username !== "" || url.password !== "" || url.port !== "") return undefined;
  const parts = url.pathname.split("/");
  if (parts.length !== 3 || parts[0] !== "") return undefined;
  const [, id, version] = parts;
  if (id === undefined || version === undefined) return undefined;
  // Tested as received: an encoded slash or dot stays encoded and fails the pattern.
  if (!PROJECT_ID.test(id) || !VERSION.test(version)) return undefined;
  return { kind: url.hostname, id, version: Number(version) };
}
