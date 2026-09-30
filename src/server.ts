import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from "./auth.js";
import type { Config } from "./config.js";
import { checkOrigins, jobRequestSchema, publicView } from "./job.js";
import type { Logger } from "./log.js";
import { AtCapacityError, type JobManager } from "./manager.js";

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function createApp(config: Config, manager: JobManager, log: Logger): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://recorder");
        const method = req.method ?? "GET";

        // Health is open on purpose: load balancers and uptime monitors need it.
        if (method === "GET" && url.pathname === "/healthz") {
          return send(res, 200, { ok: true, active: manager.activeCount, capacity: manager.capacity });
        }

        // Everything else must be signed by the LMS.
        const body = method === "POST" ? await readBody(req) : "";
        const auth = verify({
          secret: config.RECORDER_SHARED_SECRET,
          timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined,
          signature: req.headers[SIGNATURE_HEADER] as string | undefined,
          body,
        });
        if (!auth.ok) {
          log.warn("rejected request", { path: url.pathname, reason: auth.reason });
          return send(res, 401, { error: "unauthorized" });
        }

        if (method === "POST" && url.pathname === "/v1/jobs") {
          let json: unknown;
          try {
            json = JSON.parse(body);
          } catch {
            return send(res, 400, { error: "invalid json" });
          }
          const parsed = jobRequestSchema.safeParse(json);
          if (!parsed.success) return send(res, 400, { error: "invalid request", issues: parsed.error.issues.map((i) => i.message) });
          const denied = checkOrigins(parsed.data, config);
          if (denied) return send(res, 403, { error: denied });
          try {
            const { job, created } = manager.submit(parsed.data);
            return send(res, created ? 202 : 200, { created, job: publicView(job) });
          } catch (error) {
            if (error instanceof AtCapacityError) {
              // The LMS treats this as "use the fallback recorder for this class".
              return send(res, 503, { error: "at_capacity", active: manager.activeCount, capacity: manager.capacity });
            }
            throw error;
          }
        }

        const stopMatch = url.pathname.match(/^\/v1\/jobs\/([\w-]+)\/stop$/);
        if (method === "POST" && stopMatch) {
          return send(res, manager.stop(stopMatch[1]!) ? 202 : 404, { stopping: manager.get(stopMatch[1]!) !== undefined });
        }

        const getMatch = url.pathname.match(/^\/v1\/jobs\/([\w-]+)$/);
        if (method === "GET" && getMatch) {
          const job = manager.get(getMatch[1]!);
          return job ? send(res, 200, { job: publicView(job) }) : send(res, 404, { error: "not found" });
        }

        return send(res, 404, { error: "not found" });
      } catch (error) {
        log.error("request failed", { error: String(error) });
        if (!res.headersSent) send(res, 500, { error: "internal error" });
      }
    })();
  });
}
