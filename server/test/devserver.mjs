import { createServer } from "node:http";
import worker from "../src/index.js";
import { createD1 } from "./d1shim.mjs";
const env = { DB: createD1(new URL("../migrations", import.meta.url).pathname), ALLOWED_ORIGINS: "http://127.0.0.1:8799" };
createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request("http://127.0.0.1:8787" + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : body }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, "127.0.0.1", () => console.log("api on 8787"));
