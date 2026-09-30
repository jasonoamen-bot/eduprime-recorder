// Tiny static server for the fake class page. Dev/test only.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
createServer(async (req, res) => {
  try {
    const html = await readFile(join(dir, "test-class.html"));
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  } catch {
    res.writeHead(500);
    res.end();
  }
}).listen(8080, "127.0.0.1");
