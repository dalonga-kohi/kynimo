// Container health: the server accepts connections on its port. Exits 0 when it does.
import { createConnection } from "node:net";

const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.PORT || 8787) });
socket.setTimeout(3000);
socket.on("connect", () => {
  socket.destroy();
  process.exit(0);
});
for (const event of ["error", "timeout"]) socket.on(event, () => process.exit(1));
