import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildUserData } from "../src/fleet/bootstrap.js";
import { LinodeProvider } from "../src/fleet/linode.js";
import { FakeProvider } from "../src/fleet/provider.js";
import { acquireLock } from "../src/fleet/lock.js";
import { tick } from "../src/fleet/runner.js";
import { DEFAULT_CONFIG } from "../src/fleet/slots.js";
import { httpProbe } from "../src/fleet/health.js";

const TOKEN = "t".repeat(64);

/** A pretend Linode: records every request and answers from a small in-memory table. */
function pretendLinode(instances: { id: number; label: string; type: string; status: string; ipv4: string[]; created: string; tags: string[] }[]) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const path = new URL(url).pathname.replace("/v4", "");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (method === "GET" && path === "/linode/instances") return json(200, { data: instances });
    const one = /^\/linode\/instances\/(\d+)$/.exec(path);
    if (one && method === "GET") { const i = instances.find((x) => x.id === Number(one[1])); return i ? json(200, i) : json(404, { errors: [{ reason: "Not found" }] }); }
    if (one && method === "DELETE") return json(200, {});
    if (method === "POST" && path === "/linode/instances") {
      const body = JSON.parse(String(init.body));
      return json(200, { id: 999, label: body.label, type: body.type, status: "provisioning", ipv4: ["203.0.113.9"], created: "2026-10-05T08:45:00", tags: body.tags });
    }
    return json(500, { errors: [{ reason: "unexpected" }] });
  }) as typeof fetch;
  return { calls, fakeFetch };
}

const mine = { id: 1, label: "rec-a", type: "g6-dedicated-8", status: "running", ipv4: ["1.1.1.1"], created: "2026-10-05T08:00:00", tags: ["eduprime-recorder"] };
const notMine = { id: 2, label: "jason-website", type: "g6-standard-1", status: "running", ipv4: ["2.2.2.2"], created: "2025-01-01T00:00:00", tags: ["production"] };

describe("Linode provider", () => {
  it("refuses a missing or short token", () => {
    expect(() => new LinodeProvider({ token: "" })).toThrow();
    expect(() => new LinodeProvider({ token: "short" })).toThrow();
  });

  it("lists only servers carrying our tag, and sends the token as a header", async () => {
    const { calls, fakeFetch } = pretendLinode([mine, notMine]);
    const servers = await new LinodeProvider({ token: TOKEN, fetch: fakeFetch }).list();
    expect(servers.map((s) => s.label)).toEqual(["rec-a"]);
    expect(servers[0]).toMatchObject({ id: "1", typeId: "g6-dedicated-8", status: "running", ip: "1.1.1.1" });
    expect(servers[0]!.createdAt.toISOString()).toBe("2026-10-05T08:00:00.000Z"); // Linode sends UTC without a "Z"
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(calls[0]!.headers["X-Filter"]!)).toEqual({ tags: "eduprime-recorder" });
  });

  it("creates a server in Frankfurt with our tag, the first-boot text, and no token inside it", async () => {
    const { calls, fakeFetch } = pretendLinode([]);
    const server = await new LinodeProvider({ token: TOKEN, fetch: fakeFetch }).create({ typeId: "g6-dedicated-4", label: "rec-x", userData: "#cloud-config\nhello" });
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ region: "eu-central", type: "g6-dedicated-4", image: "linode/ubuntu24.04", tags: ["eduprime-recorder"], booted: true });
    expect(Buffer.from((body.metadata as { user_data: string }).user_data, "base64").toString()).toBe("#cloud-config\nhello");
    expect(String(body.root_pass).length).toBeGreaterThan(20);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(server).toMatchObject({ id: "999", status: "provisioning", ip: "203.0.113.9" });
  });

  it("deletes one of ours", async () => {
    const { calls, fakeFetch } = pretendLinode([mine]);
    await new LinodeProvider({ token: TOKEN, fetch: fakeFetch }).remove("1");
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
  });

  it("REFUSES to delete a server that is not ours, and never issues the DELETE", async () => {
    const { calls, fakeFetch } = pretendLinode([notMine]);
    await expect(new LinodeProvider({ token: TOKEN, fetch: fakeFetch }).remove("2")).rejects.toThrow(/not ours/);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("refuses a non-numeric id", async () => {
    const { fakeFetch } = pretendLinode([]);
    await expect(new LinodeProvider({ token: TOKEN, fetch: fakeFetch }).remove("../account")).rejects.toThrow(/not a Linode id/);
  });

  it("an API error never leaks the token", async () => {
    const failing = (async () => new Response(JSON.stringify({ errors: [{ reason: "Invalid OAuth Token" }] }), { status: 401 })) as unknown as typeof fetch;
    let message = "";
    await new LinodeProvider({ token: TOKEN, fetch: failing }).list().catch((e: Error) => { message = e.message; });
    expect(message).toMatch(/401.*Invalid OAuth Token/);
    expect(message).not.toContain(TOKEN);
  });
});

describe("first-boot text", () => {
  const env = `RECORDER_SHARED_SECRET=${"a".repeat(64)}\nS3_BUCKET=easyway-recordings\n`;
  const ok = { recorderEnv: env, sourceUrl: "https://s3.example.com/source.tgz?X-Amz-Signature=abc" };

  it("is valid-looking cloud-init that installs docker, firewalls, builds and starts the recorder", () => {
    const text = buildUserData(ok);
    expect(text.startsWith("#cloud-config\n")).toBe(true);
    for (const piece of ["get.docker.com", "ufw --force enable", "docker build -f Dockerfile.server", "docker compose up -d", "chown -R 1001:1001"]) expect(text).toContain(piece);
  });

  it("carries the settings file encoded, not in the clear", () => {
    const text = buildUserData(ok);
    expect(text).not.toContain("RECORDER_SHARED_SECRET");
    expect(text).toContain(Buffer.from(env).toString("base64"));
  });

  it("refuses an insecure link, a weak secret, and the Linode token", () => {
    expect(() => buildUserData({ ...ok, sourceUrl: "http://x" })).toThrow(/https/);
    expect(() => buildUserData({ ...ok, recorderEnv: "RECORDER_SHARED_SECRET=short" })).toThrow(/32\+/);
    expect(() => buildUserData({ ...ok, recorderEnv: env + "LINODE_TOKEN=abc" })).toThrow(/Linode token/);
  });

  it("adds a debugging key only when given", () => {
    expect(buildUserData(ok)).not.toContain("ssh_authorized_keys");
    expect(buildUserData({ ...ok, sshPublicKey: "ssh-ed25519 AAAA test" })).toContain("ssh-ed25519 AAAA test");
  });
});

describe("one pass of the runner", () => {
  const morning = new Date("2026-10-05T08:45:00Z"); // 20 min before the 10:00 school-time slot
  const userData = () => "#cloud-config\n";

  it("a dry run looks but changes nothing", async () => {
    const provider = new FakeProvider();
    const report = await tick({ provider, probe: async () => 0, config: DEFAULT_CONFIG, apply: false, userData, now: morning });
    expect(report.decision.actions).toHaveLength(1);
    expect(report.executed).toEqual([]);
    expect(provider.created).toHaveLength(0);
  });

  it("with apply it creates what the timetable needs", async () => {
    const provider = new FakeProvider(() => morning);
    const report = await tick({ provider, probe: async () => 0, config: DEFAULT_CONFIG, apply: true, userData, now: morning });
    expect(report.executed).toEqual([expect.objectContaining({ ok: true })]);
    expect(provider.created).toEqual([expect.objectContaining({ typeId: "g6-dedicated-8" })]);
  });

  it("asks each running server what it is doing, and does not delete a busy one", async () => {
    const provider = new FakeProvider(() => new Date("2026-10-05T07:00:00Z"));
    const s = await provider.create({ typeId: "g6-dedicated-8", label: "rec-1", userData: "x" });
    provider.servers[0] = { ...s, status: "running", ip: "1.2.3.4" };
    const quiet = new Date("2026-10-05T14:05:00Z"); // no class for an hour+
    const busy = await tick({ provider, probe: async () => 3, config: DEFAULT_CONFIG, apply: true, userData, now: quiet });
    expect(busy.decision.actions).toEqual([]);
    const idle = await tick({ provider, probe: async () => 0, config: DEFAULT_CONFIG, apply: true, userData, now: quiet });
    expect(idle.executed).toEqual([expect.objectContaining({ ok: true })]);
    expect(provider.removed).toEqual([s.id]);
  });

  it("one failing action does not stop the others", async () => {
    const provider = new FakeProvider(() => new Date("2026-10-05T07:00:00Z"));
    const a = await provider.create({ typeId: "g6-dedicated-4", label: "rec-a", userData: "x" });
    const b = await provider.create({ typeId: "g6-dedicated-4", label: "rec-b", userData: "x" });
    provider.servers = provider.servers.map((s) => ({ ...s, status: "running" as const, ip: "1.1.1.1" }));
    provider.failRemove.add(a.id);
    const report = await tick({ provider, probe: async () => 0, config: DEFAULT_CONFIG, apply: true, userData, now: new Date("2026-10-05T14:05:00Z") });
    expect(report.executed.map((e) => e.ok).sort()).toEqual([false, true]);
    expect(provider.removed).toEqual([b.id]);
  });

  it("a server that does not answer is treated as unknown, never as idle", async () => {
    const provider = new FakeProvider(() => new Date("2026-10-05T14:00:00Z"));
    const s = await provider.create({ typeId: "g6-dedicated-8", label: "rec-1", userData: "x" });
    provider.servers[0] = { ...s, status: "running", ip: "1.2.3.4" };
    const report = await tick({ provider, probe: async () => null, config: DEFAULT_CONFIG, apply: true, userData, now: new Date("2026-10-05T14:05:00Z") });
    expect(provider.removed).toEqual([]); // young and silent: left alone
    expect(report.decision.notes.join(" ")).toMatch(/not answering/);
  });
});

describe("health probe", () => {
  it("reads the number of recordings in progress", async () => {
    const ok = (async () => new Response(JSON.stringify({ ok: true, active: 2, capacity: 5 }))) as unknown as typeof fetch;
    expect(await httpProbe(8787, ok)("1.2.3.4")).toBe(2);
  });
  it("returns null on any failure", async () => {
    expect(await httpProbe(8787, (async () => { throw new Error("refused"); }) as unknown as typeof fetch)("1.2.3.4")).toBeNull();
    expect(await httpProbe(8787, (async () => new Response("no", { status: 500 })) as unknown as typeof fetch)("1.2.3.4")).toBeNull();
    expect(await httpProbe(8787, (async () => new Response(JSON.stringify({ ok: true }))) as unknown as typeof fetch)("1.2.3.4")).toBeNull();
  });
});

describe("overlap lock", () => {
  it("a second pass is refused while the first holds the lock, and a stale lock is ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    try {
      const path = join(dir, "x.lock");
      const release = acquireLock(path, 10, 1_000_000)!;
      expect(release).toBeTypeOf("function");
      expect(acquireLock(path, 10, 1_000_000 + 60_000)).toBeNull(); // one minute later: still held
      expect(acquireLock(path, 10, 1_000_000 + 11 * 60_000)).toBeTypeOf("function"); // 11 minutes: crashed pass, take over
      release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
