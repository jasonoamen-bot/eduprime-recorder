import { describe, expect, it } from "vitest";
import { buildUserData, withMaxJobs } from "../src/fleet/bootstrap.js";
import { buildDirectory, serverIdFromIp, type ServerHealth } from "../src/fleet/directory.js";
import { httpHealth } from "../src/fleet/health.js";
import { FakeProvider } from "../src/fleet/provider.js";
import { tick } from "../src/fleet/runner.js";
import { DEFAULT_CONFIG } from "../src/fleet/slots.js";
import { LEGACY_CONFIG } from "./legacy-config.js";
import type { ServerState } from "../src/fleet/types.js";

const NOW = new Date("2026-10-05T14:05:00Z"); // a quiet gap: servers are about to be deleted

function state(over: Partial<ServerState> & { id: string; ip: string | null }): ServerState {
  return { label: `rec-${over.id}`, typeId: "g6-dedicated-8", status: "running", createdAt: new Date(NOW.getTime() - 3_600_000), activeJobs: 0, ...over };
}

describe("server ids", () => {
  it("are the IPv4 address in hex", () => {
    expect(serverIdFromIp("172.104.156.47")).toBe("ac689c2f");
    expect(serverIdFromIp("0.0.0.1")).toBe("00000001");
  });
  it("refuse anything that is not an IPv4 address", () => {
    for (const bad of ["", "1.2.3", "1.2.3.4.5", "1.2.3.999", "a.b.c.d", "::1"]) expect(() => serverIdFromIp(bad), bad).toThrow();
  });
});

describe("the directory of servers open for recording", () => {
  const health = (entries: Record<string, ServerHealth>) => new Map(Object.entries(entries));

  it("lists running servers that answered, with their address and free room", () => {
    const d = buildDirectory([state({ id: "1", ip: "10.0.0.1" })], health({ "1": { active: 2, capacity: 5 } }), new Set(), NOW);
    expect(d).toEqual({ version: 1, updatedAt: NOW.toISOString(), servers: [{ id: "0a000001", url: "http://10.0.0.1:8787", capacity: 5, active: 2 }] });
  });

  it("leaves out servers still starting, ones with no address, and ones that did not answer", () => {
    const d = buildDirectory(
      [state({ id: "1", ip: "10.0.0.1", status: "provisioning" }), state({ id: "2", ip: null }), state({ id: "3", ip: "10.0.0.3" }), state({ id: "4", ip: "10.0.0.4" })],
      health({ "4": { active: 0, capacity: 5 } }), new Set(), NOW,
    );
    expect(d.servers.map((s) => s.url)).toEqual(["http://10.0.0.4:8787"]);
  });

  it("leaves out a server that is about to be deleted", () => {
    const d = buildDirectory([state({ id: "1", ip: "10.0.0.1" }), state({ id: "2", ip: "10.0.0.2" })], health({ "1": { active: 0, capacity: 5 }, "2": { active: 0, capacity: 5 } }), new Set(["1"]), NOW);
    expect(d.servers.map((s) => s.id)).toEqual(["0a000002"]);
  });

  it("an empty fleet is a valid, empty directory (stale entries must disappear)", () => {
    expect(buildDirectory([], new Map(), new Set(), NOW).servers).toEqual([]);
  });
});

describe("each server accepts only what its size can take", () => {
  it("replaces the shared limit with this server's own", () => {
    const env = "RECORDER_SHARED_SECRET=" + "a".repeat(40) + "\nMAX_CONCURRENT_JOBS=5\nS3_BUCKET=b\n";
    const out = withMaxJobs(env, 1);
    expect(out.match(/MAX_CONCURRENT_JOBS=/g)).toHaveLength(1);
    expect(out).toContain("MAX_CONCURRENT_JOBS=1");
    expect(out).toContain("S3_BUCKET=b");
  });
  it("adds it when the file had none, and refuses nonsense limits", () => {
    expect(withMaxJobs("A=1", 3)).toBe("A=1\nMAX_CONCURRENT_JOBS=3\n");
    for (const bad of [0, -1, 1.5, 99]) expect(() => withMaxJobs("A=1", bad), String(bad)).toThrow();
  });
  it("lands in the first-boot text for that server", () => {
    const secret = "RECORDER_SHARED_SECRET=" + "a".repeat(40);
    const text = buildUserData({ recorderEnv: withMaxJobs(secret, 2), sourceUrl: "https://x.example/s.tgz" });
    const encoded = /content: (\S+)/.exec(text)![1]!;
    expect(Buffer.from(encoded, "base64").toString()).toContain("MAX_CONCURRENT_JOBS=2");
  });
});

describe("health answers", () => {
  const reply = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
  it("reads recordings going and the limit", async () => {
    expect(await httpHealth("1.2.3.4", 8787, reply({ ok: true, active: 1, capacity: 5 }))).toEqual({ active: 1, capacity: 5 });
  });
  it("is null when the answer is incomplete or the server is down", async () => {
    expect(await httpHealth("1.2.3.4", 8787, reply({ ok: true, active: 1 }))).toBeNull();
    expect(await httpHealth("1.2.3.4", 8787, (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe("the runner takes servers out of the directory BEFORE deleting them", () => {
  it("calls the hook first, with the servers about to go, then acts", async () => {
    const provider = new FakeProvider(() => new Date("2026-10-05T07:00:00Z"));
    const s = await provider.create({ typeId: "g6-dedicated-8", label: "rec-1", userData: "x" });
    provider.servers[0] = { ...s, status: "running", ip: "1.2.3.4" };
    const order: string[] = [];
    const original = provider.remove.bind(provider);
    provider.remove = async (id) => { order.push("delete"); return original(id); };
    await tick({
      provider, probe: async () => 0, config: LEGACY_CONFIG, apply: true, userData: () => "x", now: NOW,
      beforeApply: async ({ decision }) => { order.push(`hook sees ${decision.actions.filter((a) => a.kind === "delete").length} delete(s)`); },
    });
    expect(order).toEqual(["hook sees 1 delete(s)", "delete"]);
  });

  it("a failing hook never stops the deletion", async () => {
    const provider = new FakeProvider(() => new Date("2026-10-05T07:00:00Z"));
    const s = await provider.create({ typeId: "g6-dedicated-8", label: "rec-1", userData: "x" });
    provider.servers[0] = { ...s, status: "running", ip: "1.2.3.4" };
    await tick({ provider, probe: async () => 0, config: LEGACY_CONFIG, apply: true, userData: () => "x", now: NOW, beforeApply: async () => { throw new Error("bucket down"); } });
    expect(provider.removed).toEqual([s.id]);
  });

  it("is not called at all in a dry run", async () => {
    let called = false;
    await tick({ provider: new FakeProvider(), probe: async () => 0, config: LEGACY_CONFIG, apply: false, userData: () => "x", now: NOW, beforeApply: async () => { called = true; } });
    expect(called).toBe(false);
  });

  it("tells userData which size each new server is", async () => {
    const provider = new FakeProvider();
    const sizes: string[] = [];
    await tick({ provider, probe: async () => 0, config: LEGACY_CONFIG, apply: true, now: new Date("2026-10-05T08:45:00Z"), userData: ({ typeId }) => { sizes.push(typeId); return "x"; } });
    expect(sizes).toEqual(["g6-dedicated-8"]);
  });
});
