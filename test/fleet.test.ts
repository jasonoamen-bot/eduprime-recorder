import { describe, expect, it } from "vitest";
import { bestFleet, capacityOf, costPerHour } from "../src/fleet/plan.js";
import { reconcile } from "../src/fleet/reconcile.js";
import { simulate } from "../src/fleet/simulate.js";
import { DEFAULT_CONFIG, DEFAULT_TYPES, classesAt, parseClock, peakClasses, schoolClock } from "../src/fleet/slots.js";
import type { FleetConfig, ServerState } from "../src/fleet/types.js";

// Monday 5 Oct 2026. School time is UTC+1, so the 10:00 morning slot starts at 09:00 UTC.
const utc = (iso: string) => new Date(iso);
const monday = (hhmmUtc: string) => utc(`2026-10-05T${hhmmUtc}:00Z`);

let n = 0;
function server(over: Partial<ServerState> & { createdMinutesAgo?: number; now: Date }): ServerState {
  n += 1;
  const { createdMinutesAgo = 120, now, ...rest } = over;
  return { id: `s${n}`, label: `rec-${n}`, typeId: "g6-dedicated-8", status: "running", ip: "1.2.3.4", activeJobs: 0, createdAt: new Date(now.getTime() - createdMinutesAgo * 60_000), ...rest };
}

describe("school time and the timetable", () => {
  it("school time is UTC+1", () => {
    expect(schoolClock(monday("09:00"))).toMatchObject({ day: 1, minutes: 600, dateKey: "2026-10-05" });
    expect(schoolClock(utc("2026-10-05T23:30:00Z")).dateKey).toBe("2026-10-06"); // already tomorrow in Lagos
  });

  it("knows which classes run when", () => {
    expect(classesAt(monday("08:59"))).toBe(0);
    expect(classesAt(monday("09:00"))).toBe(5); // morning starts 10:00 Lagos
    expect(classesAt(monday("11:59"))).toBe(5);
    expect(classesAt(monday("12:00"))).toBe(2); // afternoon 13:00 Lagos
    expect(classesAt(monday("14:00"))).toBe(0); // gap until 17:00 Lagos
    expect(classesAt(monday("16:30"))).toBe(2); // evening
    expect(classesAt(utc("2026-10-10T09:30:00Z"))).toBe(3); // Saturday
    expect(classesAt(utc("2026-10-11T09:30:00Z"))).toBe(0); // Sunday
  });

  it("a closed day has no classes", () => {
    expect(classesAt(monday("09:30"), DEFAULT_CONFIG.slots, new Set(["2026-10-05"]))).toBe(0);
  });

  it("peak over a window looks ahead", () => {
    expect(peakClasses(monday("08:45"), monday("09:05"), DEFAULT_CONFIG.slots)).toBe(5);
    expect(peakClasses(monday("08:30"), monday("08:50"), DEFAULT_CONFIG.slots)).toBe(0);
  });

  it("parses clock times and refuses nonsense", () => {
    expect(parseClock("10:00")).toBe(600);
    expect(() => parseClock("ten")).toThrow();
  });
});

describe("the cheapest servers for N classes", () => {
  const t = DEFAULT_TYPES;
  it("zero classes needs nothing", () => expect(bestFleet(0, t)).toEqual({}));
  it("1 class: the smallest", () => expect(bestFleet(1, t)).toEqual({ "g6-dedicated-2": 1 }));
  it("2 classes: one 4-vCPU, not two 2-vCPU (same price, fewer machines)", () => expect(bestFleet(2, t)).toEqual({ "g6-dedicated-4": 1 }));
  it("5 classes: one 8-vCPU (cheaper than any mix)", () => expect(bestFleet(5, t)).toEqual({ "g6-dedicated-8": 1 }));
  it("7 classes: an 8-vCPU plus a 4-vCPU, cheaper than a 16-vCPU", () => {
    const fleet = bestFleet(7, t);
    expect(capacityOf(fleet, t)).toBeGreaterThanOrEqual(7);
    expect(costPerHour(fleet, t)).toBeCloseTo(0.324, 3);
  });
  it("always covers the need, for every count up to 30", () => {
    for (let c = 1; c <= 30; c++) expect(capacityOf(bestFleet(c, t), t)).toBeGreaterThanOrEqual(c);
  });
});

describe("reconcile: creating", () => {
  it("starts a server ahead of the morning slot, not before the lead time", () => {
    const early = monday("08:35"); // 20 min later is 08:55 UTC: still before 09:00
    expect(reconcile({ now: early, servers: [], config: DEFAULT_CONFIG }).actions).toEqual([]);
    const lead = monday("08:45");
    const decision = reconcile({ now: lead, servers: [], config: DEFAULT_CONFIG });
    expect(decision.need.create).toBe(5);
    expect(decision.actions).toEqual([expect.objectContaining({ kind: "create", typeId: "g6-dedicated-8" })]);
  });

  it("does not create when enough capacity already exists (even one still starting)", () => {
    const now = monday("08:45");
    const have = [server({ now, status: "provisioning", activeJobs: null, createdMinutesAgo: 3 })];
    expect(reconcile({ now, servers: have, config: DEFAULT_CONFIG }).actions).toEqual([]);
  });

  it("tops up only the shortfall", () => {
    const now = monday("08:45");
    const config: FleetConfig = { ...DEFAULT_CONFIG, slots: [{ name: "big", days: [1], start: "10:00", end: "13:00", classes: 7 }] };
    const have = [server({ now, typeId: "g6-dedicated-4" })]; // capacity 2
    const created = reconcile({ now, servers: have, config }).actions.filter((a) => a.kind === "create");
    expect(created.length).toBeGreaterThan(0);
    const total = capacityOf(Object.fromEntries(created.map((a) => [(a as { typeId: string }).typeId, 1])), DEFAULT_TYPES) + 2;
    expect(total).toBeGreaterThanOrEqual(7);
  });

  it("never exceeds the hard server cap, and says so", () => {
    const now = monday("08:45");
    const config: FleetConfig = { ...DEFAULT_CONFIG, maxServers: 2, slots: [{ name: "huge", days: [1], start: "10:00", end: "13:00", classes: 50 }] };
    const decision = reconcile({ now, servers: [], config });
    expect(decision.actions.filter((a) => a.kind === "create").length).toBeLessThanOrEqual(2);
    expect(decision.notes.join(" ")).toMatch(/WARNING/);
  });

  it("never creates more than the per-pass limit", () => {
    const now = monday("08:45");
    const config: FleetConfig = { ...DEFAULT_CONFIG, maxServers: 20, maxCreatesPerTick: 1, types: [DEFAULT_TYPES[0]!], slots: [{ name: "wide", days: [1], start: "10:00", end: "13:00", classes: 6 }] };
    expect(reconcile({ now, servers: [], config }).actions.filter((a) => a.kind === "create")).toHaveLength(1);
  });
});

describe("reconcile: deleting", () => {
  it("NEVER deletes a server that is recording, even with no classes due", () => {
    const now = monday("13:30");
    const busy = server({ now, activeJobs: 2 });
    expect(reconcile({ now, servers: [busy], config: DEFAULT_CONFIG }).actions).toEqual([]);
  });

  it("never deletes a server it could not ask", () => {
    const now = monday("13:30");
    const unknown = server({ now, activeJobs: null, createdMinutesAgo: 10 });
    expect(reconcile({ now, servers: [unknown], config: DEFAULT_CONFIG }).actions).toEqual([]);
  });

  it("deletes an idle server once no class is due within the keep window", () => {
    const now = monday("14:05"); // afternoon over (15:00 Lagos); evening is 17:00 Lagos = 16:00 UTC, 115 min away
    const decision = reconcile({ now, servers: [server({ now })], config: DEFAULT_CONFIG });
    expect(decision.actions).toEqual([expect.objectContaining({ kind: "delete" })]);
  });

  it("keeps an idle server that is needed again within the hour (no delete-and-recreate)", () => {
    const now = monday("15:20"); // evening starts 16:00 UTC: 40 min away
    expect(reconcile({ now, servers: [server({ now })], config: DEFAULT_CONFIG }).actions).toEqual([]);
  });

  it("keeps the morning server through to the afternoon slot", () => {
    const now = monday("12:00"); // morning just ended, afternoon (2 classes) starts at once
    expect(reconcile({ now, servers: [server({ now })], config: DEFAULT_CONFIG }).actions).toEqual([]);
  });

  it("drops the dearest idle server first when there is surplus", () => {
    const now = monday("12:00"); // need 2 classes
    const big = server({ now, typeId: "g6-dedicated-8" });
    const small = server({ now, typeId: "g6-dedicated-4" });
    const actions = reconcile({ now, servers: [small, big], config: DEFAULT_CONFIG }).actions;
    expect(actions).toEqual([expect.objectContaining({ kind: "delete", id: big.id })]);
  });

  it("does not delete and create in the same pass", () => {
    const now = monday("08:45");
    const old = server({ now, createdMinutesAgo: 9 * 60 }); // forgotten: deleted...
    const decision = reconcile({ now, servers: [old], config: DEFAULT_CONFIG });
    expect(decision.actions.map((a) => a.kind).sort()).toEqual(["create", "delete"]); // ...and replaced because a class is due
  });
});

describe("reconcile: sweeping the broken and the forgotten", () => {
  const now = monday("14:05");
  it("deletes a server stuck starting", () => {
    const stuck = server({ now, status: "provisioning", activeJobs: null, createdMinutesAgo: 40 });
    expect(reconcile({ now, servers: [stuck], config: DEFAULT_CONFIG }).actions).toEqual([expect.objectContaining({ kind: "delete", reason: expect.stringMatching(/stuck/) })]);
  });
  it("leaves a server that is only just starting", () => {
    const fresh = server({ now: monday("08:45"), status: "provisioning", activeJobs: null, createdMinutesAgo: 4 });
    expect(reconcile({ now: monday("08:45"), servers: [fresh], config: DEFAULT_CONFIG }).actions).toEqual([]);
  });
  it("deletes a running server whose recorder never answers", () => {
    const broken = server({ now, activeJobs: null, createdMinutesAgo: 45 });
    expect(reconcile({ now, servers: [broken], config: DEFAULT_CONFIG }).actions).toEqual([expect.objectContaining({ kind: "delete", reason: expect.stringMatching(/unhealthy/) })]);
  });
  it("deletes an idle server older than the age limit even when classes are due", () => {
    const morning = monday("09:30");
    const forgotten = server({ now: morning, createdMinutesAgo: 9 * 60 });
    expect(reconcile({ now: morning, servers: [forgotten], config: DEFAULT_CONFIG }).actions.some((a) => a.kind === "delete")).toBe(true);
  });
  it("but never an old server that is busy", () => {
    const morning = monday("09:30");
    const busy = server({ now: morning, createdMinutesAgo: 9 * 60, activeJobs: 3 });
    expect(reconcile({ now: morning, servers: [busy], config: DEFAULT_CONFIG }).actions).toEqual([]);
  });
});

describe("a simulated month", () => {
  const month = simulate({ config: DEFAULT_CONFIG, from: utc("2026-10-05T00:00:00Z"), days: 28 }); // 4 whole weeks from a Monday

  it("never leaves a class without a recorder (every class is covered)", () => {
    expect(month.uncoveredClassMinutes).toBe(0);
  });
  it("ends with no servers left running", () => {
    expect(month.leftover).toBe(0);
  });
  it("never needs more than the planned fleet", () => {
    expect(month.peakServers).toBeLessThanOrEqual(2);
  });
  it("costs far less than recording through LiveKit (about $125 a month) and than an always-on server", () => {
    const perMonth = month.usd * (30 / 28);
    expect(perMonth).toBeGreaterThan(5);
    expect(perMonth).toBeLessThan(80);
  });
  it("a closed day costs nothing", () => {
    const week = simulate({ config: { ...DEFAULT_CONFIG, skipDates: ["2026-10-07"] }, from: utc("2026-10-05T00:00:00Z"), days: 7 });
    expect(week.byDay.find((d) => d.date === "2026-10-07")?.usd ?? 0).toBe(0);
  });
});

describe("reconcile: spare capacity", () => {
  const spare = { ...DEFAULT_CONFIG, spareClasses: 1 };
  it("plans one class of headroom on top of the timetable", () => {
    const decision = reconcile({ now: monday("08:45"), servers: [], config: spare });
    expect(decision.need.create).toBe(6); // 5 scheduled + 1 spare
    const classes = decision.actions.reduce((sum, a) => sum + (a.kind === "create" ? DEFAULT_TYPES.find((t) => t.id === a.typeId)!.classes : 0), 0);
    expect(classes).toBeGreaterThanOrEqual(6);
  });
  it("costs nothing when no class is expected: no spare server is kept for an empty day", () => {
    expect(reconcile({ now: monday("03:00"), servers: [], config: spare })).toMatchObject({ actions: [], need: { create: 0, keep: 0 } });
  });
  it("default is no spare, as before", () => {
    expect(DEFAULT_CONFIG.spareClasses).toBe(0);
  });
});
