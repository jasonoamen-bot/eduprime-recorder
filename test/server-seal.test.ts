import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { sign, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "../src/auth.js";
import { createApp } from "../src/server.js";
import { sealToken } from "../src/seal.js";
import type { Config } from "../src/config.js";
import type { JobManager } from "../src/manager.js";

const secret = "s".repeat(40);
const plain = "eyJhbGciOiJIUzI1NiJ9.eyJ2aWRlbyI6e319.signature-part-here";
const silent = { info() {}, warn() {}, error() {}, child() { return silent; } } as never;
const config = { RECORDER_SHARED_SECRET: secret, ALLOWED_PAGE_ORIGINS: ["https://lms.example"], ALLOWED_CALLBACK_ORIGINS: ["https://lms.example"] } as unknown as Config;

let server: Server | undefined;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

async function post(token: string) {
  const seen: string[] = [];
  const manager = { activeCount: 0, capacity: 1, submit: (request: { token: string; jobId: string }) => { seen.push(request.token); return { created: true, job: { request, status: "queued", createdAt: "now" } }; } } as unknown as JobManager;
  server = createApp(config, manager, silent);
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  const body = JSON.stringify({ jobId: "s0a000001-abcdef0123456789", roomName: "r", pageUrl: "https://lms.example/live/egress-template", livekitUrl: "wss://lk.example", token, objectKey: "recordings/x.mp4" });
  const timestamp = String(Date.now());
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/jobs`, { method: "POST", body, headers: { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: sign(secret, timestamp, body) } });
  return { status: response.status, seen };
}

describe("the server and sealed room tokens", () => {
  it("opens a sealed token before the job starts", async () => {
    const r = await post(sealToken(secret, "s0a000001-abcdef0123456789", plain));
    expect(r.status).toBe(202);
    expect(r.seen).toEqual([plain]);
  });
  it("still accepts a plain token (an LMS that has not been updated yet)", async () => {
    const r = await post(plain);
    expect(r.status).toBe(202);
    expect(r.seen).toEqual([plain]);
  });
  it("rejects a sealed token made for another job", async () => {
    const r = await post(sealToken(secret, "s0a000002-abcdef0123456789", plain));
    expect(r.status).toBe(400);
    expect(r.seen).toEqual([]);
  });
});
