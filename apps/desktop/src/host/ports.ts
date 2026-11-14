/** 8787 first (the documented port), then the next ten, then any free port. */
export const DEFAULT_PORTS: readonly number[] = [
  8787, 8788, 8789, 8790, 8791, 8792, 8793, 8794, 8795, 8796, 8797, 0,
];

/**
 * Calls `start` with each port in turn while the port is in use; any other failure, or running
 * out of ports, rejects with that error.
 */
export async function startOnFirstFreePort<T>(
  ports: readonly number[],
  start: (port: number) => Promise<T>,
): Promise<T> {
  let last: unknown = new Error("no port to try");
  for (const port of ports) {
    try {
      return await start(port);
    } catch (e) {
      if ((e as { code?: unknown } | null)?.code !== "EADDRINUSE") throw e;
      last = e;
    }
  }
  throw last;
}
