import { describe, expect, it } from "vitest";
import { STANDBY_AFTER_MS, nextBeat, parseBeat, shouldStandBy, type Beat } from "../src/fleet/beat.js";
import { NO_CONTROL, applyControl, parseControl, readControlFrom, type Control } from "../src/fleet/control.js";
import { ForecastDemand, staticDemand, type Forecast } from "../src/fleet/demand.js";
import { LinodeProvider } from "../src/fleet/linode.js";
import { reconcile } from "../src/fleet/reconcile.js";
import { DEFAULT_CONFIG } from "../src/fleet/slots.js";
import type { ServerState } from "../src/fleet/types.js";

const at = (iso: string) => new Date(iso);
// Monday 5 Oct 2026, 08:45 UTC = 09:45 school time: the 10:00 slot is 15 minutes away.
const NOW = at("2026-10-05T08:45:00Z");
const file = (over: Partial<Control> = {}): Control => ({ ...NO_CONTROL, version: 1, updatedAt: NOW.toISOString(), updatedBy: "office@school", ...over });

describe("reading the control file", () => {
  it("accepts a good file and bounds every number", () => {
    const c = parseControl({ version: 1, paused: false, skipDates: ["2026-12-25", "2026-12-24", "2026-12-25", "not-a-date", 5], boost: { classes: 99, until: "2099-01-01T00:00:00Z" }, spareClasses: 9, maxServers: 50, updatedBy: "x" }, NOW);
    expect(c.skipDates).toEqual(["2026-12-24", "2026-12-25"]);
    expect(c.boost).toEqual({ classes: 12, until: "2026-10-05T20:45:00.000Z" }); // 12 classes at most, 12 hours at most
    expect(c.spareClasses).toBeNull(); // 9 is out of range: ignored, not clamped
    expect(c.maxServers).toBeNull();
  });

  it("a missing, garbled or wrong-version file means NO instructions, never 'paused'", () => {
    expect(readControlFrom(null, NOW)).toEqual({ control: NO_CONTROL, problem: null });
    for (const raw of ["{not json", "[]", "null", JSON.stringify({ version: 2, paused: true }), JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, paused: "yes" })]) {
      const r = readControlFrom(raw, NOW);
      expect(r.control.paused).toBe(false);
      expect(r.problem).toMatch(/control file ignored/);
    }
  });

  it("a boost that has run out is ignored, and one with no valid time or count is dropped", () => {
    expect(parseControl({ version: 1, paused: false, boost: { classes: 0, until: "2026-10-05T10:00:00Z" } }, NOW).boost).toBeNull();
    expect(parseControl({ version: 1, paused: false, boost: { classes: 2, until: "tomorrow-ish" } }, NOW).boost).toBeNull();
  });
});

describe("what the control file does to the fleet", () => {
  const idle = (typeId: string, ageMinutes = 120): ServerState => ({ id: "s1", label: "rec-1", typeId, status: "running", ip: "1.2.3.4", activeJobs: 0, createdAt: new Date(NOW.getTime() - ageMinutes * 60_000) });
  const busy = (): ServerState => ({ ...idle("g6-dedicated-4"), activeJobs: 2 });

  it("nothing special: the 10:00 morning slot starts servers", () => {
    const applied = applyControl(DEFAULT_CONFIG, NO_CONTROL, NOW);
    const d = reconcile({ now: NOW, servers: [], config: applied.config, demand: applied.adjustDemand(staticDemand(applied.config)) });
    expect(d.actions.some((a) => a.kind === "create")).toBe(true);
  });

  it("PAUSED: no server is created, however many classes are due", () => {
    const applied = applyControl(DEFAULT_CONFIG, file({ paused: true, pauseNote: "billing check" }), NOW);
    const d = reconcile({ now: NOW, servers: [], config: applied.config, demand: applied.adjustDemand(staticDemand(applied.config)) });
    expect(d.actions.filter((a) => a.kind === "create")).toEqual([]);
    expect(applied.notes[0]).toMatch(/PAUSED by office@school \(billing check\)/);
  });

  it("PAUSED never deletes a server that is recording (the safety rule)", () => {
    const applied = applyControl(DEFAULT_CONFIG, file({ paused: true }), at("2026-10-05T22:00:00Z"));
    const d = reconcile({ now: at("2026-10-05T22:00:00Z"), servers: [busy()], config: applied.config, demand: applied.adjustDemand(staticDemand(applied.config)) });
    expect(d.actions.filter((a) => a.kind === "delete")).toEqual([]);
  });

  it("PAUSED still lets an idle server go when nothing is due (a pause can never leave money running)", () => {
    const late = at("2026-10-05T22:00:00Z");
    const applied = applyControl(DEFAULT_CONFIG, file({ paused: true }), late);
    const d = reconcile({ now: late, servers: [idle("g6-dedicated-4")], config: applied.config, demand: applied.adjustDemand(staticDemand(applied.config)) });
    expect(d.actions.filter((a) => a.kind === "delete")).toHaveLength(1);
  });

  it("BOOST starts a server on a quiet evening, and stops mattering when it expires", () => {
    const quiet = at("2026-10-05T22:00:00Z"); // 23:00 school time, no class
    const control = file({ boost: { classes: 2, until: "2026-10-06T00:00:00.000Z" } });
    const on = applyControl(DEFAULT_CONFIG, control, quiet);
    expect(reconcile({ now: quiet, servers: [], config: on.config, demand: on.adjustDemand(staticDemand(on.config)) }).actions.some((a) => a.kind === "create")).toBe(true);
    const later = at("2026-10-06T00:30:00Z");
    const off = applyControl(DEFAULT_CONFIG, control, later);
    expect(reconcile({ now: later, servers: [], config: off.config, demand: off.adjustDemand(staticDemand(off.config)) }).actions).toEqual([]);
  });

  it("limits from the file override the settings, within bounds", () => {
    const applied = applyControl(DEFAULT_CONFIG, file({ maxServers: 2, spareClasses: 0 }), NOW);
    expect(applied.config.maxServers).toBe(2);
    expect(applied.config.spareClasses).toBe(0);
  });

  it("skip dates remove timetable classes on that school date only", () => {
    const forecast: Forecast = {
      version: 1, generatedAt: NOW.toISOString(), from: NOW.toISOString(), to: "2026-10-07T08:45:00.000Z", bucketMinutes: 15, liveNow: 0, cohorts: 3,
      buckets: [
        { start: "2026-10-05T09:00:00Z", end: "2026-10-05T12:00:00Z", classes: 4 }, // Monday
        { start: "2026-10-06T09:00:00Z", end: "2026-10-06T12:00:00Z", classes: 5 }, // Tuesday
      ],
    };
    const demand = new ForecastDemand(forecast, ["2026-10-05"]);
    expect(demand.peak(at("2026-10-05T09:00:00Z"), at("2026-10-05T11:00:00Z"))).toBe(0);
    expect(demand.peak(at("2026-10-06T09:00:00Z"), at("2026-10-06T11:00:00Z"))).toBe(5);
  });

  it("a class that is LIVE on a skipped day is still recorded", () => {
    const forecast: Forecast = { version: 1, generatedAt: NOW.toISOString(), from: NOW.toISOString(), to: "2026-10-07T08:45:00.000Z", bucketMinutes: 15, liveNow: 1, cohorts: 3, buckets: [] };
    expect(new ForecastDemand(forecast, ["2026-10-05"]).peak(NOW, new Date(NOW.getTime() + 20 * 60_000))).toBe(1);
  });
});

describe("the standby scheduler", () => {
  const beat = (at: string, over: Partial<Beat> = {}): Beat => ({ at, role: "primary", holder: "p", acting: true, servers: 0, needSoon: 0, needLater: 0, actions: 0, failed: 0, timetable: "", paused: false, boosted: false, notes: [], recent: [], ...over });

  it("stands by while the primary is reporting in", () => {
    expect(shouldStandBy(beat("2026-10-05T08:40:00Z"), NOW).standBy).toBe(true);
  });
  it("takes over when the primary has been silent for 12 minutes", () => {
    expect(shouldStandBy(beat(new Date(NOW.getTime() - STANDBY_AFTER_MS + 1000).toISOString()), NOW).standBy).toBe(true);
    const r = shouldStandBy(beat(new Date(NOW.getTime() - STANDBY_AFTER_MS - 1000).toISOString()), NOW);
    expect(r.standBy).toBe(false);
    expect(r.why).toMatch(/TAKING OVER/);
  });
  it("acts if the primary has never reported (nothing to defer to)", () => {
    expect(shouldStandBy(null, NOW).standBy).toBe(false);
  });
  it("a heartbeat from the future (clock skew) counts as alive, so skew cannot cause a double take-over", () => {
    expect(shouldStandBy(beat("2026-10-05T08:50:00Z"), NOW).standBy).toBe(true);
  });
});

describe("the heartbeat and its log", () => {
  const base = { role: "primary" as const, holder: "p", acting: true, servers: 1, needSoon: 2, needLater: 2, actions: 0, failed: 0, timetable: "x", paused: false, boosted: false, notes: [] as string[] };

  it("keeps only the last 40 lines, newest last", () => {
    let b: Beat | null = null;
    for (let i = 0; i < 60; i++) b = nextBeat(b, new Date(NOW.getTime() + i * 60_000), { ...base, events: [`event ${i}`] });
    expect(b!.recent).toHaveLength(40);
    expect(b!.recent[39]!.text).toBe("event 59");
    expect(b!.recent[0]!.text).toBe("event 20");
  });

  it("a quiet pass adds nothing to the log", () => {
    const first = nextBeat(null, NOW, { ...base, events: ["started g6-dedicated-4"] });
    const second = nextBeat(first, new Date(NOW.getTime() + 300_000), { ...base, events: [] });
    expect(second.recent).toHaveLength(1);
    expect(second.at).not.toBe(first.at);
  });

  it("the same control-file problem repeating every pass is logged once", () => {
    let b = nextBeat(null, NOW, { ...base, events: ["control file ignored: bad"] });
    b = nextBeat(b, new Date(NOW.getTime() + 300_000), { ...base, events: ["control file ignored: bad"] });
    expect(b.recent).toHaveLength(1);
  });

  it("reads an old-format heartbeat (no role, no log) without breaking", () => {
    const b = parseBeat({ at: "2026-10-05T08:40:00Z", servers: 1, needSoon: 0, needLater: 0, actions: 0, failed: 0, timetable: "t" });
    expect(b).toMatchObject({ role: "primary", paused: false, recent: [], acting: true });
    expect(parseBeat({ at: "garbage" })).toBeNull();
    expect(parseBeat(null)).toBeNull();
  });
});

describe("creating a server when a region will not take it", () => {
  const TOKEN = "t".repeat(64);
  function linode(refuse: Record<string, number>) {
    const regions: string[] = [];
    const fakeFetch = (async (_url: string, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body));
      regions.push(body.region);
      const status = refuse[body.region];
      if (status) return new Response(JSON.stringify({ errors: [{ reason: `region ${body.region} says no` }] }), { status });
      return new Response(JSON.stringify({ id: 7, label: body.label, type: body.type, status: "provisioning", ipv4: ["203.0.113.7"], created: "2026-10-05T08:45:00", tags: body.tags }), { status: 200 });
    }) as typeof fetch;
    return { regions, fakeFetch };
  }
  const spec = { typeId: "g6-dedicated-4", label: "rec-x", userData: "#cloud-config" };

  it("uses the first region when it works", async () => {
    const { regions, fakeFetch } = linode({});
    await new LinodeProvider({ token: TOKEN, fetch: fakeFetch, fallbackRegions: ["eu-west"] }).create(spec);
    expect(regions).toEqual(["eu-central"]);
  });
  it("moves on to the next region when one is full or down", async () => {
    const { regions, fakeFetch } = linode({ "eu-central": 400 });
    const s = await new LinodeProvider({ token: TOKEN, fetch: fakeFetch, fallbackRegions: ["eu-west", "us-east"] }).create(spec);
    expect(regions).toEqual(["eu-central", "eu-west"]);
    expect(s.id).toBe("7");
  });
  it("a rejected token stops at once: no point asking every region with a bad key", async () => {
    const { regions, fakeFetch } = linode({ "eu-central": 401 });
    await expect(new LinodeProvider({ token: TOKEN, fetch: fakeFetch, fallbackRegions: ["eu-west"] }).create(spec)).rejects.toThrow(/401/);
    expect(regions).toEqual(["eu-central"]);
  });
  it("when every region refuses, the error says what each one said", async () => {
    const { fakeFetch } = linode({ "eu-central": 400, "eu-west": 500 });
    await expect(new LinodeProvider({ token: TOKEN, fetch: fakeFetch, fallbackRegions: ["eu-west"] }).create(spec)).rejects.toThrow(/no region would take the server.*eu-central.*eu-west/);
  });
});

describe("the control file written by the LMS", () => {
  it("reads the example the LMS repository asserts (the two repositories agree on the shape)", () => {
    const shared = '{"version":1,"updatedAt":"2026-10-05T08:45:00.000Z","updatedBy":"Mary","paused":true,"pauseNote":"checking the bill","skipDates":["2026-12-24","2026-12-25"],"boost":{"classes":2,"until":"2026-10-05T11:45:00.000Z"},"spareClasses":null,"maxServers":4}';
    expect(parseControl(JSON.parse(shared), at("2026-10-05T08:45:00Z"))).toEqual({
      version: 1, updatedAt: "2026-10-05T08:45:00.000Z", updatedBy: "Mary", paused: true, pauseNote: "checking the bill",
      skipDates: ["2026-12-24", "2026-12-25"], boost: { classes: 2, until: "2026-10-05T11:45:00.000Z" }, spareClasses: null, maxServers: 4,
    });
  });
});
