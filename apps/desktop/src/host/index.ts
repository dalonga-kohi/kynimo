// Entry of the utility process main starts: the MCP server and the studio, behind messages.
import type { HostInit, HostRequest } from "../shared/protocol.js";
import { Host } from "./host.js";

const port = process.parentPort;
let host: Host | undefined;

const isInit = (m: unknown): m is HostInit =>
  typeof m === "object" && m !== null && (m as { type?: unknown }).type === "init";
const isRequest = (m: unknown): m is HostRequest =>
  typeof m === "object" &&
  m !== null &&
  typeof (m as { id?: unknown }).id === "number" &&
  typeof (m as { method?: unknown }).method === "string";

process.on("uncaughtException", (e) => process.stderr.write(`kynimo host: ${e.stack ?? e}\n`));
process.on("unhandledRejection", (e) => process.stderr.write(`kynimo host: ${String(e)}\n`));

port.on("message", ({ data }) => {
  if (isInit(data) && host === undefined) {
    host = new Host(data, (event) => port.postMessage(event));
  } else if (isRequest(data) && host !== undefined) {
    void host.dispatch(data).then((response) => port.postMessage(response));
  }
});
