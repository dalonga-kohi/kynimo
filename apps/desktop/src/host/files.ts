import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let counter = 0;

/** Writes through a temporary file in the same folder, so a reader never sees half a file. */
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${counter++}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export const atomicWriteJson = (file: string, value: unknown): Promise<void> =>
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);

/** Copies through a temporary file, then renames it into place. */
export async function atomicCopy(source: string, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${counter++}.tmp`;
  try {
    await copyFile(source, tmp);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** The parsed JSON file, undefined when it is missing; throws when it is not valid JSON. */
export async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return undefined;
    throw e;
  }
  return JSON.parse(text);
}
