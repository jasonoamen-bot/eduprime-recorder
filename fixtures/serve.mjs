// Tiny static server for the test pages (the fake class page and the LiveKit viewer stand-in).
// Dev/test only: started by the entrypoint when SERVE_FIXTURES=1. Never enabled in production.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

createServer(async (req, res) => {
  try {
    let path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/") path = "/test-class.html"; // the original fake page stays the default
    // Stay inside this folder: no ../ tricks.
    const file = normalize(join(dir, path));
    if (!file.startsWith(dir + sep) || file.endsWith("serve.mjs") || file.endsWith("publisher-run.mjs")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(8080, "127.0.0.1");
