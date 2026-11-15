import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createApi } from "./api";
import { getConfig } from "./lib/config";
import { getDb } from "./lib/db";

getConfig();
const port = Number(process.env.PORT || 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT.");
const app = createApi();
const server = createServer(
  {
    requestTimeout: 15000,
    headersTimeout: 10000,
    keepAliveTimeout: 5000,
  },
  getRequestListener(app.fetch),
);
server.listen(port, "127.0.0.1", () => {
  console.info(
    JSON.stringify({ event: "api_listening", address: "127.0.0.1", port }),
  );
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 25000);
  deadline.unref();
  server.close(() => {
    void getDb()
      .end()
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
  server.closeIdleConnections();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
