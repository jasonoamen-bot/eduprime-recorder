import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "../storage.js";
import { RELEASE_KEY, type S3Settings } from "./release.js";

/**
 * The scheduler's heartbeat: a small file it rewrites after every pass, so "is it alive, and what has it been
 * doing?" can be answered from anywhere (the admin page, the command line, an alert) without logging in.
 *
 * Two schedulers can exist. The PRIMARY always acts. The STANDBY (a different server in a different region)
 * only acts when the primary has been silent for STANDBY_AFTER_MS: so one machine, one datacentre or one
 * cron job failing can never leave servers un-managed for long. Each writes its own file so the standby
 * can always see the primary's last word, even while acting itself.
 */
export const PRIMARY_BEAT_KEY = RELEASE_KEY.replace("source-latest.tgz", "scheduler-heartbeat.json");
export const STANDBY_BEAT_KEY = RELEASE_KEY.replace("source-latest.tgz", "scheduler-standby.json");

export const STANDBY_AFTER_MS = 12 * 60_000;
const MAX_RECENT = 40;

export type Role = "primary" | "standby";
export type LogLine = { at: string; text: string };

export type Beat = {
  at: string;
  role: Role;
  /** Which machine wrote it (its hostname), so two beats can be told apart. */
  holder: string;
  /** The standby is awake but leaving the work to the primary. */
  acting: boolean;
  servers: number;
  needSoon: number;
  needLater: number;
  actions: number;
  failed: number;
  timetable: string;
  paused: boolean;
  boosted: boolean;
  /** The settings in force that the office should know about (paused, boost, limits). */
  notes: string[];
  /** The last things the scheduler DID (started or removed a server, failed, was told something). Not every quiet pass. */
  recent: LogLine[];
};

export function parseBeat(value: unknown): Beat | null {
  const v = value as Partial<Beat> | null;
  if (!v || typeof v !== "object" || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    at: v.at,
    role: v.role === "standby" ? "standby" : "primary",
    holder: typeof v.holder === "string" ? v.holder.slice(0, 80) : "",
    acting: v.acting !== false,
    servers: num(v.servers), needSoon: num(v.needSoon), needLater: num(v.needLater), actions: num(v.actions), failed: num(v.failed),
    timetable: typeof v.timetable === "string" ? v.timetable.slice(0, 300) : "",
    paused: v.paused === true,
    boosted: v.boosted === true,
    notes: Array.isArray(v.notes) ? v.notes.filter((n): n is string => typeof n === "string").slice(0, 10).map((n) => n.slice(0, 300)) : [],
    recent: Array.isArray(v.recent)
      ? v.recent.filter((r): r is LogLine => !!r && typeof r.at === "string" && typeof r.text === "string").slice(-MAX_RECENT).map((r) => ({ at: r.at, text: r.text.slice(0, 300) }))
      : [],
  };
}

export const ageMs = (beat: Beat | null, now: Date): number | null => (beat ? now.getTime() - Date.parse(beat.at) : null);

/** Should this machine, as the STANDBY, leave this pass alone? Yes while the primary has spoken recently. */
export function shouldStandBy(primary: Beat | null, now: Date, afterMs: number = STANDBY_AFTER_MS): { standBy: boolean; why: string } {
  const age = ageMs(primary, now);
  if (age === null) return { standBy: false, why: "no primary heartbeat has ever been seen: acting" };
  // A beat from "the future" (clock skew) counts as fresh: only a clearly OLD beat means the primary is gone.
  if (age < afterMs) return { standBy: true, why: `primary last ran ${Math.max(0, Math.round(age / 1000))}s ago: standing by` };
  return { standBy: false, why: `primary silent for ${Math.round(age / 60_000)} min: STANDBY TAKING OVER` };
}

/** What happened in a pass, as short sentences for the log (nothing for a quiet pass). */
export function pass(input: { servers: number; actions: { text: string; ok: boolean; error?: string }[]; problems: string[] }): string[] {
  const lines: string[] = [];
  for (const a of input.actions) lines.push(a.ok ? a.text : `FAILED: ${a.text}${a.error ? ` (${a.error})` : ""}`);
  for (const p of input.problems) lines.push(p);
  return lines;
}

export function nextBeat(prev: Beat | null, now: Date, input: Omit<Beat, "at" | "recent"> & { events: string[] }): Beat {
  const { events, ...rest } = input;
  const at = now.toISOString();
  const previous = prev?.recent ?? [];
  // The same problem repeating every five minutes must not push everything else out of the log.
  const lastText = previous.length ? previous[previous.length - 1]!.text : null;
  const fresh = events.filter((text, i) => !(i === 0 && text === lastText && text.startsWith("control file ignored")));
  const recent = [...previous, ...fresh.map((text) => ({ at, text }))].slice(-MAX_RECENT);
  return { ...rest, at, recent };
}

const client = (s3: S3Settings) => createS3Client({ S3_REGION: s3.region, S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET: s3.secret });

export async function readBeat(s3: S3Settings, role: Role): Promise<Beat | null> {
  try {
    const out = await client(s3).send(new GetObjectCommand({ Bucket: s3.bucket, Key: role === "primary" ? PRIMARY_BEAT_KEY : STANDBY_BEAT_KEY }));
    return parseBeat(JSON.parse(await out.Body!.transformToString()));
  } catch {
    return null;
  }
}

export async function writeBeat(s3: S3Settings, beat: Beat): Promise<void> {
  await client(s3).send(new PutObjectCommand({ Bucket: s3.bucket, Key: beat.role === "primary" ? PRIMARY_BEAT_KEY : STANDBY_BEAT_KEY, Body: JSON.stringify(beat), ContentType: "application/json", CacheControl: "no-store" }));
}
