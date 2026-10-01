import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "../storage.js";
import { RELEASE_KEY, type S3Settings } from "./release.js";
import { schoolClock } from "./slots.js";

/**
 * What the recorder servers have cost: a running total the scheduler keeps in the bucket, one small file, so the
 * admin page can show "today" and "this month" without anyone logging in to Linode.
 *
 * It is an ESTIMATE: each pass adds (price of the servers seen) x (time since the last pass). Linode bills by the
 * started hour and its invoice is the final word; this exists so a runaway bill is noticed the same day.
 * Days and months are school (Lagos) days and months.
 */
export const SPEND_KEY = RELEASE_KEY.replace("source-latest.tgz", "spend.json");

export type Spend = {
  version: 1;
  month: string;
  monthUsd: number;
  day: string;
  dayUsd: number;
  serverHoursMonth: number;
  updatedAt: string;
};

/** A gap longer than this (the scheduler was down) is counted as only this much: it is an estimate, not an invoice. */
const MAX_GAP_MS = 15 * 60_000;

export function parseSpend(value: unknown): Spend | null {
  const v = value as Partial<Spend> | null;
  if (!v || typeof v !== "object" || v.version !== 1) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  if (typeof v.month !== "string" || typeof v.day !== "string" || !Number.isFinite(Date.parse(String(v.updatedAt)))) return null;
  return { version: 1, month: v.month, monthUsd: num(v.monthUsd), day: v.day, dayUsd: num(v.dayUsd), serverHoursMonth: num(v.serverHoursMonth), updatedAt: String(v.updatedAt) };
}

/** Add one pass. `servers` is how many were running and `usdPerHour` what they cost together. */
export function addSpend(prev: Spend | null, now: Date, servers: number, usdPerHour: number): Spend {
  const clock = schoolClock(now);
  const month = clock.dateKey.slice(0, 7);
  const gap = prev ? Math.min(Math.max(0, now.getTime() - Date.parse(prev.updatedAt)), MAX_GAP_MS) : 0;
  const hours = gap / 3_600_000;
  const usd = usdPerHour * hours;
  const sameMonth = prev?.month === month;
  const sameDay = prev?.day === clock.dateKey;
  const round = (x: number) => Math.round(x * 10_000) / 10_000;
  return {
    version: 1,
    month,
    monthUsd: round((sameMonth ? prev!.monthUsd : 0) + usd),
    day: clock.dateKey,
    dayUsd: round((sameDay ? prev!.dayUsd : 0) + usd),
    serverHoursMonth: round((sameMonth ? prev!.serverHoursMonth : 0) + servers * hours),
    updatedAt: now.toISOString(),
  };
}

const client = (s3: S3Settings) => createS3Client({ S3_REGION: s3.region, S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET: s3.secret });

export async function readSpend(s3: S3Settings): Promise<Spend | null> {
  try {
    const out = await client(s3).send(new GetObjectCommand({ Bucket: s3.bucket, Key: SPEND_KEY }));
    return parseSpend(JSON.parse(await out.Body!.transformToString()));
  } catch {
    return null;
  }
}

export async function writeSpend(s3: S3Settings, spend: Spend): Promise<void> {
  await client(s3).send(new PutObjectCommand({ Bucket: s3.bucket, Key: SPEND_KEY, Body: JSON.stringify(spend), ContentType: "application/json", CacheControl: "no-store" }));
}
