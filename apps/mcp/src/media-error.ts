import { dirname } from "node:path";

export class MediaError extends Error {
  override name = "MediaError";
}

/**
 * FFmpeg's last error lines, with the temp directory's path replaced so it never reaches a
 * client. `args` holds the paths FFmpeg was given.
 */
export function detailOf(stderr: string, args: readonly string[]): string {
  let text = stderr.trim().split("\n").slice(-3).join("; ");
  for (const a of args)
    if (a.includes("kynimo-media-")) text = text.split(dirname(a)).join("<upload>");
  text = text.slice(0, 500);
  return text ? `: ${text}` : "";
}
