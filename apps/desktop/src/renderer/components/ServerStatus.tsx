import type { StudioStatus } from "../../shared/api.js";

/** "127.0.0.1:8787" from the endpoint URL. */
export function hostPort(status: StudioStatus): string {
  if (status.endpoint !== undefined) {
    try {
      return new URL(status.endpoint).host;
    } catch {
      // Fall through to the port.
    }
  }
  return status.port === undefined ? "127.0.0.1" : `127.0.0.1:${status.port}`;
}

/** The server's state in the app bar: address, connected client, failure or start-up. */
export function ServerStatus({ status }: { status: StudioStatus | undefined }) {
  if (status === undefined || status.server === "starting")
    return (
      <div className="status" role="status">
        <span className="status__dot" style={{ background: "var(--color-text-faint)" }} />
        <span className="status__text">Starting…</span>
      </div>
    );
  if (status.server === "failed")
    return (
      <div className="status" role="status">
        <span className="status__dot" style={{ background: "var(--color-danger)" }} />
        <span className="status__text">Server stopped</span>
      </div>
    );
  if (status.client !== undefined)
    return (
      <div className="status" role="status">
        <span className="status__dot" style={{ background: "var(--color-success)" }} />
        <span className="status__text">{status.client.name} connected</span>
      </div>
    );
  return (
    <div className="status" role="status">
      <span className="status__dot" style={{ background: "var(--color-success)" }} />
      <span className="status__text status__text--mono">{hostPort(status)}</span>
    </div>
  );
}
