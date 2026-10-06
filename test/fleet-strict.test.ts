import { describe, expect, it } from "vitest";
import { applyControl, parseControl, NO_CONTROL, STOP_ALL_WINDOW_MS, type Control } from "../src/fleet/control.js";
import { reconcile } from "../src/fleet/reconcile.js";
import { ForecastDemand, type Forecast } from "../src/fleet/demand.js";
import { DEFAULT_CONFIG } from "../src/fleet/slots.js";
import type { ServerState } from "../src/fleet/types.js";

const at = (iso: string) => new Date(iso);
let n = 0;
function server(now: Date, over: Partial<ServerState> & { ageMin?: number } = {}): ServerState {
  n += 1;
  const { ageMin = 120, ...rest } = over;
  return { id: `s${n}`, label: `rec-${n}`, typeId: "g6-dedicated-4", status: "running", ip: "1.2.3.4", activeJobs: 0, createdAt: new Date(now.getTime() - ageMin * 60_000), ...rest };
}
const control = (over: Partial<Control>): Control => ({ ...NO_CONTROL, version: 1, ...over });

// A forecast with classes now: `classes` classes from 09:00Z to 12:00Z (10:00-13:00 school time).
function forecastWith(generatedAt: Date, classes: number, liveNow = 0): Forecast {
  return {
    version: 1,
    generatedAt: generatedAt.toISOString(),
    from: generatedAt.toISOString(),
    to: new Date(generatedAt.getTime() + 36e5).toISOString(),
    bucketMinutes: 15,
    buckets: classes > 0 ? [{ start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T12:00:00.000Z", classes }] : [],
    liveNow,
    cohorts: classes,
  };
}

describe("the defaults are strict", () => {
  it("a server starts 10 minutes ahead, not 20; an idle one is not kept for an hour; no spare server", () => {
    expect(DEFAULT_CONFIG.leadMinutes).toBe(10);
    expect(DEFAULT_CONFIG.keepMinutes).toBe(10);
    expect(DEFAULT_CONFIG.spareClasses).toBe(0);
  });

  it("nothing is started 15 minutes before a class any more, but is 10 minutes before", () => {
    const demand = new ForecastDemand(forecastWith(at("2026-10-06T08:40:00Z"), 2));
    // 08:45Z: the class at 09:00Z is 15 min away -> not yet.
    expect(reconcile({ now: at("2026-10-06T08:45:00Z"), servers: [], config: DEFAULT_CONFIG, demand }).actions).toEqual([]);
    // 08:50Z: 10 min away -> start.
    expect(reconcile({ now: at("2026-10-06T08:50:00Z"), servers: [], config: DEFAULT_CONFIG, demand }).actions.some((a) => a.kind === "create")).toBe(true);
  });

  it("an idle server goes as soon as no class is due within the lead time (it used to wait up to an hour)", () => {
    const now = at("2026-10-06T14:00:00Z"); // between slots
    const demand = new ForecastDemand(forecastWith(at("2026-10-06T13:55:00Z"), 0));
    const decision = reconcile({ now, servers: [server(now)], config: DEFAULT_CONFIG, demand });
    expect(decision.actions).toEqual([expect.objectContaining({ kind: "delete" })]);
  });
});

describe("PAUSE switches servers off; it does not just stop new ones", () => {
  const now = at("2026-10-06T09:30:00Z"); // a class period is on, classes due
  const demand = new ForecastDemand(forecastWith(at("2026-10-06T09:28:00Z"), 4, 2));
  const paused = () => applyControl(DEFAULT_CONFIG, control({ paused: true, updatedBy: "Mary" }), now);

  it("drain is on, and the note says idle servers are switched off", () => {
    const applied = paused();
    expect(applied.config.drain).toBe(true);
    expect(applied.config.maxCreatesPerTick).toBe(0);
    expect(applied.notes.join(" ")).toMatch(/idle servers are switched off now/);
  });

  it("an IDLE server is deleted straight away even though classes are scheduled (this was the bug)", () => {
    const idle = server(now);
    // Two classes scheduled, one server that covers them. Before: it was "needed" and stayed billing.
    const small = new ForecastDemand(forecastWith(at("2026-10-06T09:28:00Z"), 2, 1));
    expect(reconcile({ now, servers: [idle], config: DEFAULT_CONFIG, demand: small }).actions).toEqual([]);
    // Now: the pause switches it off.
    const decision = reconcile({ now, servers: [idle], config: paused().config, demand: small });
    expect(decision.actions).toEqual([expect.objectContaining({ kind: "delete", id: idle.id, reason: expect.stringMatching(/paused/) })]);
  });

  it("a server still starting is switched off too: it cannot be recording anything", () => {
    const starting = server(now, { status: "provisioning", ip: null, activeJobs: null, ageMin: 3 });
    expect(reconcile({ now, servers: [starting], config: paused().config, demand }).actions).toEqual([expect.objectContaining({ kind: "delete", id: starting.id })]);
  });

  it("but a server that is RECORDING a class is never cut by a pause", () => {
    const recording = server(now, { activeJobs: 2 });
    const unknown = server(now, { activeJobs: null, ageMin: 5 });
    expect(reconcile({ now, servers: [recording, unknown], config: paused().config, demand }).actions).toEqual([]);
  });

  it("nothing new is created while paused, however many classes are due", () => {
    expect(reconcile({ now, servers: [], config: paused().config, demand }).actions).toEqual([]);
  });

  it("a recording server goes the moment it falls idle (the next pass)", () => {
    const finished = server(now, { activeJobs: 0 });
    expect(reconcile({ now, servers: [finished], config: paused().config, demand }).actions.map((a) => a.kind)).toEqual(["delete"]);
  });
});

describe("POWER OFF is the one thing that cuts a recording", () => {
  const now = at("2026-10-06T09:30:00Z");
  const demand = new ForecastDemand(forecastWith(at("2026-10-06T09:28:00Z"), 4, 2));
  const pressed = (when: string) => applyControl(DEFAULT_CONFIG, control({ paused: true, stopAllAt: when, updatedBy: "Mary" }), now);

  it("deletes every server created before it, even one recording, and says what it cut", () => {
    const recording = server(now, { activeJobs: 2 });
    const idle = server(now);
    const decision = reconcile({ now, servers: [recording, idle], config: pressed("2026-10-06T09:29:00Z").config, demand });
    expect(decision.actions.map((a) => a.kind)).toEqual(["delete", "delete"]);
    expect(decision.actions[0]).toMatchObject({ reason: expect.stringMatching(/powered off.*cut 2 recordings/) });
  });

  it("does NOT touch a server created AFTER the button was pressed (a later ordinary pass is not wiped)", () => {
    const later = server(now, { ageMin: 0, activeJobs: 1 });
    const config = pressed("2026-10-06T09:00:00Z").config;
    expect(reconcile({ now, servers: [later], config, demand }).actions).toEqual([]);
  });

  it("a stale request (older than an hour) is history, not an instruction", () => {
    const applied = applyControl(DEFAULT_CONFIG, control({ stopAllAt: new Date(now.getTime() - STOP_ALL_WINDOW_MS - 60_000).toISOString() }), now);
    expect(applied.config.stopAllBefore).toBeUndefined();
  });

  it("a request from the future is ignored", () => {
    const applied = applyControl(DEFAULT_CONFIG, control({ stopAllAt: new Date(now.getTime() + 3 * 3600_000).toISOString() }), now);
    expect(applied.config.stopAllBefore).toBeUndefined();
  });

  it("reads and bounds the field; garbage means 'never pressed'", () => {
    const base = { version: 1, paused: false };
    expect(parseControl({ ...base, stopAllAt: "2026-10-06T09:29:00Z" }, now).stopAllAt).toBe("2026-10-06T09:29:00.000Z");
    expect(parseControl({ ...base, stopAllAt: "soon" }, now).stopAllAt).toBeNull();
    expect(parseControl({ ...base }, now).stopAllAt).toBeNull();
    expect(NO_CONTROL.stopAllAt).toBeNull();
  });
});

describe("a class nobody opens costs 15 minutes, not an hour (5 to detect + 10 grace)", () => {
  // The LMS forecast stops counting a class 15 minutes after its start if no room opened (CONFIRM_GRACE_MINUTES).
  it("once the forecast drops the no-show class, the idle server is deleted on the next pass", () => {
    const now = at("2026-10-06T09:16:00Z"); // 16 min after a 09:00Z class start; the forecast has clipped it
    const demand = new ForecastDemand({
      ...forecastWith(at("2026-10-06T09:15:00Z"), 0),
      buckets: [{ start: "2026-10-06T09:00:00.000Z", end: "2026-10-06T09:15:00.000Z", classes: 2 }],
    });
    const idle = server(now, { ageMin: 26 });
    expect(reconcile({ now, servers: [idle], config: DEFAULT_CONFIG, demand }).actions).toEqual([expect.objectContaining({ kind: "delete", id: idle.id })]);
  });
});
