import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "../auth.js";
import { classesAt, peakClasses } from "./slots.js";
import type { FleetConfig } from "./types.js";

/**
 * How many classes will be live, and when: the ONE thing the fleet needs to know to decide how many servers
 * to run. Two sources:
 *
 *  - the LMS (the real timetable: moves, cancellations, closed days, extra classes, private lessons, and
 *    classes live right now), asked fresh on every pass; and
 *  - the built-in timetable in slots.ts, a fallback for when the LMS cannot be reached.
 *
 * So changing the timetable in the LMS is all it takes: the next pass follows it.
 */
export interface Demand {
  /** The most classes at once at any moment in [from, to]. */
  peak(from: Date, to: Date): number;
  /** Classes at one instant. */
  at(t: Date): number;
}

export function staticDemand(config: Pick<FleetConfig, "slots" | "skipDates">): Demand {
  const skip = new Set(config.skipDates);
  return {
    peak: (from, to) => peakClasses(from, to, config.slots, skip),
    at: (t) => classesAt(t, config.slots, skip),
  };
}

/** What the LMS's /api/recorder/forecast returns (see prototype/src/lib/recording-forecast.ts). */
export type Forecast = {
  version: 1;
  generatedAt: string;
  from: string;
  to: string;
  bucketMinutes: number;
  buckets: { start: string; end: string; classes: number }[];
  liveNow: number;
  cohorts: number;
};

/** More simultaneous classes than this is a bug in whatever produced it, not a real school day. */
export const MAX_SANE_CLASSES = 40;
const FRESH_MS = 15 * 60_000;
/** A class live this very moment, unscheduled, still needs a recorder for the next little while. */
const LIVE_NOW_HOLD_MS = 10 * 60_000;

export class ForecastDemand implements Demand {
  private readonly buckets: { start: number; end: number; classes: number }[];
  private readonly asOf: number;
  private readonly liveNow: number;

  constructor(forecast: Forecast) {
    this.buckets = forecast.buckets.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end), classes: b.classes }));
    this.asOf = Date.parse(forecast.generatedAt);
    this.liveNow = forecast.liveNow;
  }

  peak(from: Date, to: Date): number {
    const a = from.getTime();
    const b = Math.max(to.getTime(), a);
    let most = 0;
    for (const bucket of this.buckets) if (bucket.start <= b && bucket.end > a) most = Math.max(most, bucket.classes);
    // A class running right now that nobody scheduled counts for the next few minutes.
    if (a <= this.asOf + LIVE_NOW_HOLD_MS && b >= this.asOf) most = Math.max(most, this.liveNow);
    return most;
  }

  at(t: Date): number {
    const x = t.getTime();
    let most = 0;
    for (const bucket of this.buckets) if (bucket.start <= x && bucket.end > x) most = Math.max(most, bucket.classes);
    return most;
  }
}

/** The larger of two demands: for the cautious "max" mode. */
export function maxDemand(a: Demand, b: Demand): Demand {
  return { peak: (from, to) => Math.max(a.peak(from, to), b.peak(from, to)), at: (t) => Math.max(a.at(t), b.at(t)) };
}

/** Check an answer from the LMS and refuse anything that is garbled, silly or stale. */
export function parseForecast(value: unknown, now: Date): Forecast {
  const f = value as Partial<Forecast> | null;
  if (!f || typeof f !== "object") throw new Error("forecast is not an object");
  if (f.version !== 1) throw new Error(`unsupported forecast version ${String(f.version)}`);
  const generated = Date.parse(String(f.generatedAt));
  if (!Number.isFinite(generated)) throw new Error("forecast has no valid generation time");
  if (Math.abs(now.getTime() - generated) > FRESH_MS) throw new Error("forecast is stale (generated more than 15 minutes from now)");
  if (!Array.isArray(f.buckets)) throw new Error("forecast has no buckets");
  for (const b of f.buckets) {
    const start = Date.parse(String(b?.start));
    const end = Date.parse(String(b?.end));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("forecast has a bucket with bad times");
    if (!Number.isInteger(b.classes) || b.classes < 0 || b.classes > MAX_SANE_CLASSES) throw new Error(`forecast has an impossible class count (${String(b.classes)})`);
  }
  if (!Number.isInteger(f.liveNow) || (f.liveNow as number) < 0 || (f.liveNow as number) > MAX_SANE_CLASSES) throw new Error("forecast has an impossible live-now count");
  return f as Forecast;
}

/** Ask the LMS for the forecast. The request is signed over its own query, so it cannot be altered or replayed. */
export async function fetchForecast(opts: { url: string; secret: string; hours?: number; now?: Date; fetch?: typeof fetch }): Promise<Forecast> {
  const now = opts.now ?? new Date();
  const http = opts.fetch ?? fetch;
  const query = `hours=${opts.hours ?? 48}`;
  const timestamp = String(now.getTime());
  const response = await http(`${opts.url.replace(/\?.*$/, "")}?${query}`, {
    headers: { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: sign(opts.secret, timestamp, query) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`the LMS answered HTTP ${response.status}`);
  return parseForecast(await response.json(), now);
}

export type DemandMode = "lms" | "static" | "max";

export type LoadedDemand = { demand: Demand; source: "lms" | "static" | "max"; note: string };

/**
 * Pick the demand for this pass. Normal mode asks the LMS and falls back to the built-in timetable when it
 * cannot (so a deploy or an outage at the school never leaves classes without servers).
 */
export async function loadDemand(opts: {
  config: FleetConfig;
  mode?: DemandMode;
  forecastUrl?: string;
  secret?: string;
  now?: Date;
  fetch?: typeof fetch;
}): Promise<LoadedDemand> {
  const fallback = staticDemand(opts.config);
  const mode = opts.mode ?? "lms";
  if (mode === "static" || !opts.forecastUrl || !opts.secret) {
    return { demand: fallback, source: "static", note: mode === "static" ? "using the built-in timetable (mode: static)" : "no LMS forecast address configured: using the built-in timetable" };
  }
  try {
    const forecast = await fetchForecast({ url: opts.forecastUrl, secret: opts.secret, now: opts.now, fetch: opts.fetch });
    const lms = new ForecastDemand(forecast);
    const detail = `${forecast.buckets.length} class period(s) in the next ${Math.round((Date.parse(forecast.to) - Date.parse(forecast.from)) / 3_600_000)} h, ${forecast.liveNow} live now, ${forecast.cohorts} cohorts`;
    if (mode === "max") return { demand: maxDemand(lms, fallback), source: "max", note: `LMS timetable (${detail}), never below the built-in one` };
    return { demand: lms, source: "lms", note: `following the LMS timetable (${detail})` };
  } catch (error) {
    return { demand: fallback, source: "static", note: `LMS forecast unavailable (${error instanceof Error ? error.message : String(error)}): using the built-in timetable` };
  }
}
