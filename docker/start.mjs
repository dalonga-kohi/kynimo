// Container entry for the Kynimo MCP server. Picks the server's flags from the environment:
//
// - KYNIMO_OAUTH_ISSUER set: the deployed shape. Streamable HTTP with OAuth on every interface;
//   KYNIMO_PUBLIC_URL and KYNIMO_DATABASE_URL are the server's own requirements (ADR-0033).
// - otherwise: local use. One account, no sign-in, projects in /data unless a database is set.
//
// Without OAuth the server only listens on loopback, by design: it serves everyone as one
// account. Docker cannot publish a container's loopback, so this script forwards the container's
// own network address to it. Who can reach that address is then decided by how the port is
// published: docker-compose.yml publishes it on the host's 127.0.0.1 only.
import { createConnection, createServer } from "node:net";
import { networkInterfaces } from "node:os";

const port = Number(process.env.PORT || 8787);
const oauth = Boolean(process.env.KYNIMO_OAUTH_ISSUER);
const args = ["--http", "--port", String(port)];

if (oauth) {
  args.push("--host", "0.0.0.0");
} else {
  args.push("--no-auth", "--host", "127.0.0.1");
  if (!process.env.KYNIMO_DATABASE_URL) args.push("--dir", process.env.KYNIMO_DATA_DIR || "/data");
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a !== undefined && !a.internal && a.family === "IPv4")
    .map((a) => a.address);
  for (const address of addresses) {
    const forward = createServer((socket) => {
      const upstream = createConnection({ host: "127.0.0.1", port });
      socket.pipe(upstream).pipe(socket);
      const end = () => {
        socket.destroy();
        upstream.destroy();
      };
      socket.on("error", end);
      upstream.on("error", end);
    });
    forward.on("error", (e) => {
      process.stderr.write(`kynimo-mcp: cannot forward ${address}:${port}: ${e.message}\n`);
      process.exit(1);
    });
    // Unreferenced: the forwarder never keeps the process alive once the server has stopped.
    forward.listen(port, address).unref();
  }
}

process.argv.splice(2, process.argv.length, ...args, ...process.argv.slice(2));
await import("../apps/mcp/dist/main.js");
