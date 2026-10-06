import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "../storage.js";
import type { Demand } from "./demand.js";
import { RELEASE_KEY, type S3Settings } from "./release.js";
import type { FleetConfig } from "./types.js";

/**
 * The control file: how the school's office steers the fleet without anyone touching a server.
 *
 * The LMS admin page writes this small file into the private bucket; the scheduler reads it on every pass (every
 * five minutes). So "pause", "no classes on this date" or "start a server now" take effect within five minutes,
 * from a phone, with no deploy and no command line.
 *
 * SAFETY RULES (each is tested):
 *  - PAUSE stops new servers AND switches off every server that is not recording, at once (it used to only stop
 *    new ones, so running servers kept billing and the button looked dead). It never cuts a recording.
 *  - POWER OFF (`stopAllAt`) is the one deliberate exception: it deletes every server created before that moment,
 *    recording or not. It only counts for 60 minutes after it was pressed, so a stale value can never delete
 *    servers started later by an ordinary pass.
 *  - A missing, unreadable or garbled file means "no instructions", never "paused". A broken file cannot switch
 *    the recorder off by accident.
 *  - Every number is bounded, so a typo cannot rent twenty servers.
 */
export const CONTROL_KEY = RELEASE_KEY.replace("source-latest.tgz", "control.json");

export type Control = {
  version: 1;
  updatedAt: string;
  updatedBy: string;
  /** Create no new servers, and switch off every server that is not recording right now. */
  paused: boolean;
  pauseNote: string;
  /** School dates ("2026-12-25") on which the timetable is ignored: no servers are started for them. */
  skipDates: string[];
  /** Keep room for at least this many classes until `until` (an unplanned class, a tutor starting early, a test). */
  boost: { classes: number; until: string } | null;
  /** Override the spare-capacity and server-count settings. null = leave as configured. */
  spareClasses: number | null;
  maxServers: number | null;
  /** POWER OFF pressed at this moment (ISO): delete every server created before it, even one that is recording. null = never pressed. */
  stopAllAt: string | null;
};

export const NO_CONTROL: Control = { version: 1, updatedAt: "", updatedBy: "", paused: false, pauseNote: "", skipDates: [], boost: null, spareClasses: null, maxServers: null, stopAllAt: null };

/** How long a power-off request stays in force. After this it is history, not an instruction. */
export const STOP_ALL_WINDOW_MS = 60 * 60_000;

const MAX_BOOST_CLASSES = 12;
const MAX_BOOST_HOURS = 12;
const MAX_SKIP_DATES = 60;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const text = (value: unknown, max: number): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max) : "");

/**
 * Read a control file. Throws on anything that is not a control file (the caller treats that as "no
 * instructions"). Unknown fields are ignored; every known field is bounded.
 */
export function parseControl(value: unknown, now: Date): Control {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("control file is not an object");
  if (v.version !== 1) throw new Error(`unsupported control version ${String(v.version)}`);
  if (typeof v.paused !== "boolean") throw new Error("control file: paused must be true or false");

  const skipDates = Array.isArray(v.skipDates)
    ? [...new Set(v.skipDates.filter((d): d is string => typeof d === "string" && DATE.test(d) && Number.isFinite(Date.parse(`${d}T00:00:00Z`))))].sort().slice(0, MAX_SKIP_DATES)
    : [];

  let boost: Control["boost"] = null;
  const b = v.boost as { classes?: unknown; until?: unknown } | null | undefined;
  if (b && typeof b === "object") {
    const until = Date.parse(String(b.until));
    if (Number.isInteger(b.classes) && (b.classes as number) >= 1 && Number.isFinite(until)) {
      // Never longer than 12 hours from now, however far ahead the file says: a forgotten boost cannot run for ever.
      const cap = now.getTime() + MAX_BOOST_HOURS * 3_600_000;
      boost = { classes: Math.min(b.classes as number, MAX_BOOST_CLASSES), until: new Date(Math.min(until, cap)).toISOString() };
    }
  }

  const bounded = (x: unknown, lo: number, hi: number): number | null => (Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi ? (x as number) : null);
  return {
    version: 1,
    updatedAt: text(v.updatedAt, 40),
    updatedBy: text(v.updatedBy, 120),
    paused: v.paused,
    pauseNote: text(v.pauseNote, 200),
    skipDates,
    boost,
    spareClasses: bounded(v.spareClasses, 0, 5),
    maxServers: bounded(v.maxServers, 1, 12),
    stopAllAt: typeof v.stopAllAt === "string" && Number.isFinite(Date.parse(v.stopAllAt)) ? new Date(Date.parse(v.stopAllAt)).toISOString() : null,
  };
}

/** The control file, or NO_CONTROL when it is missing, unreadable or garbled. `problem` says why, for the log. */
export function readControlFrom(raw: string | null, now: Date): { control: Control; problem: string | null } {
  if (raw === null) return { control: NO_CONTROL, problem: null };
  try {
    return { control: parseControl(JSON.parse(raw), now), problem: null };
  } catch (error) {
    return { control: NO_CONTROL, problem: `control file ignored: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type Applied = {
  config: FleetConfig;
  /** Wrap the demand so a boost raises the floor. */
  adjustDemand: (demand: Demand) => Demand;
  skipDates: string[];
  notes: string[];
};

export function applyControl(config: FleetConfig, control: Control, now: Date): Applied {
  const notes: string[] = [];
  let next: FleetConfig = { ...config };
  if (control.paused) {
    // Drain: nothing new, and everything not recording is switched off now.
    next = { ...next, maxCreatesPerTick: 0, drain: true };
    notes.push(`PAUSED${control.updatedBy ? ` by ${control.updatedBy}` : ""}${control.pauseNote ? ` (${control.pauseNote})` : ""}: no new servers; idle servers are switched off now; a server recording a class stays until it ends`);
  }
  // POWER OFF: only while the request is recent (and not from the future, which would be a clock or a typo problem).
  if (control.stopAllAt) {
    const at = Date.parse(control.stopAllAt);
    if (at <= now.getTime() + 5 * 60_000 && now.getTime() - at <= STOP_ALL_WINDOW_MS) {
      next = { ...next, stopAllBefore: new Date(Math.min(at, now.getTime())), drain: true, maxCreatesPerTick: 0 };
      notes.push(`POWER OFF pressed${control.updatedBy ? ` by ${control.updatedBy}` : ""}: every server is being deleted, including any that is recording`);
    }
  }
  if (control.spareClasses !== null) { next = { ...next, spareClasses: control.spareClasses }; notes.push(`spare capacity set to ${control.spareClasses} class(es)`); }
  if (control.maxServers !== null) { next = { ...next, maxServers: control.maxServers }; notes.push(`server limit set to ${control.maxServers}`); }
  if (control.skipDates.length) { next = { ...next, skipDates: [...new Set([...next.skipDates, ...control.skipDates])] }; }

  const boost = control.boost && Date.parse(control.boost.until) > now.getTime() ? control.boost : null;
  if (boost) notes.push(`BOOST: room for ${boost.classes} class(es) until ${boost.until}`);
  const until = boost ? Date.parse(boost.until) : 0;
  const adjustDemand = (demand: Demand): Demand =>
    boost
      ? {
          // The boost covers any window that starts before it ends.
          peak: (from, to) => Math.max(demand.peak(from, to), from.getTime() < until ? boost.classes : 0),
          at: (t) => Math.max(demand.at(t), t.getTime() < until ? boost.classes : 0),
        }
      : demand;
  return { config: next, adjustDemand, skipDates: control.skipDates, notes };
}

/* -------------------------------------------------------------------------- */
/* Bucket I/O                                                                 */
/* -------------------------------------------------------------------------- */

const client = (s3: S3Settings) => createS3Client({ S3_REGION: s3.region, S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET: s3.secret });

export async function readControl(s3: S3Settings, now: Date = new Date()): Promise<{ control: Control; problem: string | null }> {
  let raw: string | null = null;
  try {
    const out = await client(s3).send(new GetObjectCommand({ Bucket: s3.bucket, Key: CONTROL_KEY }));
    raw = await out.Body!.transformToString();
  } catch (error) {
    const code = (error as { name?: string }).name;
    // No file yet is normal. Any other failure is reported but still means "no instructions".
    return { control: NO_CONTROL, problem: code === "NoSuchKey" || code === "NotFound" ? null : `could not read the control file (${code ?? "error"})` };
  }
  return readControlFrom(raw, now);
}

export async function writeControl(s3: S3Settings, control: Control): Promise<void> {
  await client(s3).send(new PutObjectCommand({ Bucket: s3.bucket, Key: CONTROL_KEY, Body: JSON.stringify(control), ContentType: "application/json", CacheControl: "no-store" }));
}
