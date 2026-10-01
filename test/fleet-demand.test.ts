import { describe, expect, it } from "vitest";
import { sign, verify } from "../src/auth.js";
import { ForecastDemand, fetchForecast, loadDemand, maxDemand, parseForecast, staticDemand, type Forecast } from "../src/fleet/demand.js";
import { reconcile } from "../src/fleet/reconcile.js";
import { simulate } from "../src/fleet/simulate.js";
import { DEFAULT_CONFIG } from "../src/fleet/slots.js";

const SECRET = "s".repeat(40);
const at = (iso: string) => new Date(iso);
// Monday 5 Oct 2026; school time is UTC+1, so the 10:00 slot starts at 09:00 UTC.
const NOW = at("2026-10-05T08:45:00Z");

function forecast(buckets: [string, string, number][], over: Partial<Forecast> = {}): Forecast {
  return {
    version: 1, generatedAt: NOW.toISOString(), from: NOW.toISOString(), to: "2026-10-07T08:45:00.000Z", bucketMinutes: 15,
    buckets: buckets.map(([start, end, classes]) => ({ start, end, classes })), liveNow: 0, cohorts: 8, ...over,
  };
}
const morning = ["2026-10-05T09:00:00Z", "2026-10-05T12:00:00Z"] as const;

describe("the signature scheme matches the LMS exactly", () => {
  it("a fixed test vector (the LMS repo asserts the same value)", () => {
    expect(sign(SECRET, "1790000000000", "hours=48")).toBe("sha256=f8ab0218f27e7c59fe58bc3b879f428abe421deb22eeb3b68a06f1b93ad5c784");
  });
});

describe("following the LMS forecast", () => {
  it("answers the questions the fleet asks: peak over a window, count at an instant", () => {
    const d = new ForecastDemand(forecast([[...morning, 5], ["2026-10-05T12:00:00Z", "2026-10-05T14:00:00Z", 2]]));
    expect(d.at(at("2026-10-05T10:00:00Z"))).toBe(5);
    expect(d.at(at("2026-10-05T12:30:00Z"))).toBe(2);
    expect(d.at(at("2026-10-05T15:00:00Z"))).toBe(0);
    expect(d.peak(at("2026-10-05T08:45:00Z"), at("2026-10-05T09:05:00Z"))).toBe(5); // the lead-time look-ahead
    expect(d.peak(at("2026-10-05T08:00:00Z"), at("2026-10-05T08:30:00Z"))).toBe(0);
  });

  it("a class live right now that nobody scheduled counts", () => {
    const d = new ForecastDemand(forecast([], { liveNow: 1 }));
    expect(d.peak(NOW, new Date(NOW.getTime() + 20 * 60_000))).toBe(1);
  });

  it("but not an hour later (it will have ended; the next forecast corrects it)", () => {
    const d = new ForecastDemand(forecast([], { liveNow: 1 }));
    expect(d.peak(new Date(NOW.getTime() + 60 * 60_000), new Date(NOW.getTime() + 80 * 60_000))).toBe(0);
  });
});

describe("a timetable change reaches the servers with nobody editing anything", () => {
  const withNone = (demand = staticDemand(DEFAULT_CONFIG)) => reconcile({ now: NOW, servers: [], config: DEFAULT_CONFIG, demand });

  it("sanity: the built-in timetable WOULD start a server for Monday morning", () => {
    expect(withNone().actions).toHaveLength(1);
  });

  it("a school holiday: the LMS forecast is empty, so no server is started", () => {
    expect(withNone(new ForecastDemand(forecast([]))).actions).toEqual([]);
  });

  it("a cohort moved to the afternoon: nothing at 10:00, a server ahead of 14:00 instead", () => {
    const moved = new ForecastDemand(forecast([["2026-10-05T13:00:00Z", "2026-10-05T15:00:00Z", 1]]));
    expect(withNone(moved).actions).toEqual([]); // 08:45: not yet
    const later = reconcile({ now: at("2026-10-05T12:45:00Z"), servers: [], config: DEFAULT_CONFIG, demand: moved });
    expect(later.actions).toEqual([expect.objectContaining({ kind: "create", typeId: "g6-dedicated-2" })]);
  });

  it("a bigger morning than the built-in guess: the fleet scales up to it", () => {
    const eight = new ForecastDemand(forecast([[...morning, 8]]));
    const decision = withNone(eight);
    expect(decision.need.create).toBe(8);
    expect(decision.actions.length).toBeGreaterThan(0);
  });

  it("a one-off extra class on a quiet afternoon: a server is started for it", () => {
    const extra = new ForecastDemand(forecast([["2026-10-05T14:30:00Z", "2026-10-05T16:00:00Z", 1]]));
    const decision = reconcile({ now: at("2026-10-05T14:15:00Z"), servers: [], config: DEFAULT_CONFIG, demand: extra });
    expect(decision.actions).toEqual([expect.objectContaining({ kind: "create" })]);
  });

  it("an unscheduled class that is live right now gets a server too", () => {
    const live = new ForecastDemand(forecast([], { liveNow: 1 }));
    expect(withNone(live).actions).toEqual([expect.objectContaining({ kind: "create" })]);
  });

  it("once the day's classes are cancelled, an idle server is released", () => {
    const idle = { id: "1", label: "rec-1", typeId: "g6-dedicated-8", status: "running" as const, ip: "1.1.1.1", createdAt: new Date(NOW.getTime() - 3_600_000), activeJobs: 0 };
    const decision = reconcile({ now: NOW, servers: [idle], config: DEFAULT_CONFIG, demand: new ForecastDemand(forecast([])) });
    expect(decision.actions).toEqual([expect.objectContaining({ kind: "delete" })]);
  });
});

describe("a week followed from the LMS forecast", () => {
  it("a short week with a closed day costs less than a full one, and every class is still covered", () => {
    const mornings = (days: number[]) => forecast(days.map((d) => [`2026-10-${String(d).padStart(2, "0")}T09:00:00Z`, `2026-10-${String(d).padStart(2, "0")}T12:00:00Z`, 5] as [string, string, number]), { to: "2026-10-12T00:00:00Z" });
    const run = (days: number[]) => simulate({ config: DEFAULT_CONFIG, from: at("2026-10-05T00:00:00Z"), days: 7, demand: new ForecastDemand(mornings(days)) });
    const full = run([5, 6, 7, 8, 9]);
    const short = run([5, 6, 8, 9]); // Wednesday closed
    expect(full.uncoveredClassMinutes).toBe(0);
    expect(short.uncoveredClassMinutes).toBe(0);
    expect(short.usd).toBeLessThan(full.usd);
    expect(short.leftover).toBe(0);
  });
});

describe("checking what the LMS says", () => {
  it("accepts a good forecast", () => {
    expect(parseForecast(forecast([[...morning, 5]]), NOW).buckets).toHaveLength(1);
  });

  it.each([
    ["a stale one", forecast([], { generatedAt: "2026-10-05T07:00:00Z" })],
    ["a future one (clock skew)", forecast([], { generatedAt: "2026-10-05T10:00:00Z" })],
    ["the wrong version", { ...forecast([]), version: 2 }],
    ["an impossible class count", forecast([[...morning, 999]])],
    ["a negative class count", forecast([[...morning, -1]])],
    ["a bucket that ends before it starts", forecast([["2026-10-05T12:00:00Z", "2026-10-05T09:00:00Z", 1]])],
    ["a bucket with a garbage time", forecast([["soon", "later", 1]])],
    ["an impossible live count", forecast([], { liveNow: 500 })],
    ["no buckets list", { ...forecast([]), buckets: "none" }],
  ])("refuses %s", (_name, bad) => {
    expect(() => parseForecast(bad, NOW)).toThrow();
  });

  it("refuses something that is not an object at all", () => {
    expect(() => parseForecast(null, NOW)).toThrow();
    expect(() => parseForecast("<html>", NOW)).toThrow();
  });
});

describe("asking the LMS", () => {
  const url = "https://lms.example/api/recorder/forecast";

  it("signs the query so the LMS accepts it, and sends nothing secret", async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined;
    const fake = (async (u: string, init: RequestInit) => {
      seen = { url: u, headers: init.headers as Record<string, string> };
      return new Response(JSON.stringify(forecast([])));
    }) as unknown as typeof fetch;
    await fetchForecast({ url, secret: SECRET, hours: 24, now: NOW, fetch: fake });
    expect(seen!.url).toBe(`${url}?hours=24`);
    expect(seen!.headers["x-recorder-timestamp"]).toBe(String(NOW.getTime()));
    expect(verify({ secret: SECRET, timestamp: seen!.headers["x-recorder-timestamp"], signature: seen!.headers["x-recorder-signature"], body: "hours=24", now: NOW.getTime() })).toEqual({ ok: true });
    expect(JSON.stringify(seen!.headers)).not.toContain(SECRET);
  });

  it("reports an HTTP error plainly", async () => {
    const fake = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(fetchForecast({ url, secret: SECRET, now: NOW, fetch: fake })).rejects.toThrow(/HTTP 401/);
  });
});

describe("choosing the demand for a pass", () => {
  const url = "https://lms.example/api/recorder/forecast";
  const good = (async () => new Response(JSON.stringify(forecast([]), null, 0))) as unknown as typeof fetch;

  it("normally follows the LMS", async () => {
    const loaded = await loadDemand({ config: DEFAULT_CONFIG, forecastUrl: url, secret: SECRET, now: NOW, fetch: good });
    expect(loaded.source).toBe("lms");
    expect(loaded.demand.peak(NOW, new Date(NOW.getTime() + 20 * 60_000))).toBe(0); // the LMS says: no classes
  });

  it("falls back to the built-in timetable when the LMS is down, and says so", async () => {
    const down = (async () => { throw new Error("connect ECONNREFUSED"); }) as unknown as typeof fetch;
    const loaded = await loadDemand({ config: DEFAULT_CONFIG, forecastUrl: url, secret: SECRET, now: NOW, fetch: down });
    expect(loaded.source).toBe("static");
    expect(loaded.note).toMatch(/unavailable.*ECONNREFUSED/);
    expect(loaded.demand.peak(NOW, new Date(NOW.getTime() + 20 * 60_000))).toBe(5); // the built-in morning
  });

  it("falls back when the LMS sends rubbish, instead of believing it", async () => {
    const junk = (async () => new Response(JSON.stringify({ hello: "world" }))) as unknown as typeof fetch;
    expect((await loadDemand({ config: DEFAULT_CONFIG, forecastUrl: url, secret: SECRET, now: NOW, fetch: junk })).source).toBe("static");
  });

  it("with no LMS address configured, uses the built-in timetable without trying the network", async () => {
    let calls = 0;
    const spy = (async () => { calls += 1; return new Response("{}"); }) as unknown as typeof fetch;
    const loaded = await loadDemand({ config: DEFAULT_CONFIG, now: NOW, fetch: spy });
    expect(loaded.source).toBe("static");
    expect(calls).toBe(0);
  });

  it("static mode never asks the LMS", async () => {
    let calls = 0;
    const spy = (async () => { calls += 1; return new Response("{}"); }) as unknown as typeof fetch;
    await loadDemand({ config: DEFAULT_CONFIG, mode: "static", forecastUrl: url, secret: SECRET, now: NOW, fetch: spy });
    expect(calls).toBe(0);
  });

  it("max mode is never below the built-in timetable (the cautious setting)", async () => {
    const loaded = await loadDemand({ config: DEFAULT_CONFIG, mode: "max", forecastUrl: url, secret: SECRET, now: NOW, fetch: good });
    expect(loaded.source).toBe("max");
    expect(loaded.demand.peak(NOW, new Date(NOW.getTime() + 20 * 60_000))).toBe(5); // LMS says 0, built-in says 5
  });

  it("maxDemand takes the larger of two", () => {
    const a = new ForecastDemand(forecast([[...morning, 7]]));
    expect(maxDemand(a, staticDemand(DEFAULT_CONFIG)).at(at("2026-10-05T10:00:00Z"))).toBe(7);
  });
});
