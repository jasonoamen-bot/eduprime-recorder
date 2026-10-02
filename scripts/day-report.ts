// End-of-day report for the class recorder: spend, how the servers were used, and whether the VIDEO is actually good.
//
//   npx tsx scripts/day-report.ts            today's recordings (school day, Lagos)
//   npx tsx scripts/day-report.ts 2026-10-03 a specific school day
//
// Reads the production bucket (R2) with the settings in .env; changes nothing. For every MP4 it probes the real file:
// picture size, frames per second, overall bitrate, audio, length. It also reads the scheduler's own records
// (cost estimate, heartbeat log) so you see what the servers did and what they cost.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readBeat } from "../src/fleet/beat.js";
import { readSpend } from "../src/fleet/spend.js";
import { createS3Client } from "../src/storage.js";

const LMS = "C:/Users/HP/Documents/easyway-lms-worktrees/own-recorder/prototype";
const ffmpeg: string = createRequire(join(LMS, "package.json"))("ffmpeg-static");
const env: Record<string, string> = {};
for (const line of readFileSync(".env", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}
const s3 = { bucket: env.S3_BUCKET!, region: env.S3_REGION!, endpoint: env.S3_ENDPOINT!, accessKey: env.S3_ACCESS_KEY!, secret: env.S3_SECRET! };
const client = createS3Client({ S3_REGION: s3.region, S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET: s3.secret });

// The school day (Lagos, UTC+1): files whose path carries that date.
const day = process.argv[2] ?? new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
console.log(`\nCLASS RECORDING REPORT for ${day} (school time)\n${"=".repeat(60)}`);

type Row = { key: string; mb: number; seconds: number; width: number; height: number; fps: number; kbps: number; audio: string; ok: boolean; notes: string[] };
const rows: Row[] = [];
let token: string | undefined;
do {
  const page = await client.send(new ListObjectsV2Command({ Bucket: s3.bucket, Prefix: "recordings/", ContinuationToken: token }));
  for (const o of page.Contents ?? []) if (o.Key!.endsWith(".mp4") && o.Key!.includes(`/${day}/`)) rows.push(await probe(o.Key!, o.Size ?? 0));
  token = page.NextContinuationToken;
} while (token);

async function probe(key: string, size: number): Promise<Row> {
  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: s3.bucket, Key: key }), { expiresIn: 900 });
  let text = "";
  try { execFileSync(ffmpeg, ["-hide_banner", "-i", url], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }); } catch (e) { text = String((e as { stderr?: string }).stderr ?? ""); }
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  const seconds = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  const video = /Video: (\w+)[^\n]*?(\d{3,4})x(\d{3,4})[^\n]*?([\d.]+) fps/.exec(text);
  const audio = /Audio: (\w+)[^\n]*?(\d+) Hz/.exec(text);
  const kbps = seconds ? Math.round((size * 8) / seconds / 1000) : 0;
  const notes: string[] = [];
  const width = video ? Number(video[2]) : 0, height = video ? Number(video[3]) : 0, fps = video ? Number(video[4]) : 0;
  if (!video) notes.push("NO VIDEO");
  else if (height < 720) notes.push(`low resolution (${width}x${height})`);
  if (!audio) notes.push("NO AUDIO");
  if (video && fps < 15) notes.push(`low frame rate (${fps} fps)`);
  if (seconds < 120) notes.push("very short");
  return { key, mb: Math.round((size / 1e6) * 10) / 10, seconds, width, height, fps, kbps, audio: audio ? `${audio[1]} ${audio[2]}Hz` : "none", ok: notes.length === 0, notes };
}

const mins = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
console.log(`\nRECORDINGS FOUND: ${rows.length}`);
for (const r of rows.sort((a, b) => a.key.localeCompare(b.key))) {
  console.log(`\n${r.ok ? "OK  " : "WARN"} ${r.key.replace("recordings/", "")}`);
  console.log(`     ${mins(r.seconds)} long, ${r.mb} MB, ${r.width}x${r.height} @ ${r.fps} fps, about ${r.kbps} kbit/s, audio ${r.audio}${r.seconds ? `, ${(r.mb / (r.seconds / 60)).toFixed(1)} MB/min` : ""}`);
  if (r.notes.length) console.log(`     ! ${r.notes.join("; ")}`);
}
if (rows.length) {
  const totalMin = rows.reduce((s, r) => s + r.seconds, 0) / 60;
  const totalMb = rows.reduce((s, r) => s + r.mb, 0);
  console.log(`\nTOTAL: ${(totalMin / 60).toFixed(1)} class-hours recorded, ${(totalMb / 1000).toFixed(2)} GB`);
  const bad = rows.filter((r) => !r.ok);
  console.log(bad.length ? `QUALITY: ${bad.length} of ${rows.length} file(s) need a look (marked WARN above)` : "QUALITY: every file is 720p or better with sound");
}

const spend = await readSpend(s3);
const primary = await readBeat(s3, "primary");
console.log(`\nSERVER SPEND (the scheduler's running estimate; Linode's invoice is the final word)`);
if (spend) console.log(`  today ${spend.day}: $${spend.dayUsd.toFixed(2)}   this month: $${spend.monthUsd.toFixed(2)} (${spend.serverHoursMonth.toFixed(1)} server-hours)`);
else console.log("  no figure yet");
if (rows.length && spend) {
  const hours = rows.reduce((s, r) => s + r.seconds, 0) / 3600;
  if (hours > 0) console.log(`  = about $${(spend.dayUsd / hours).toFixed(2)} per recorded class-hour on servers (LiveKit charged about $1.20)`);
}
console.log(`\nWHAT THE SCHEDULER DID (latest, school time)`);
for (const l of (primary?.recent ?? []).slice(-14)) console.log(`  ${l.at.slice(5, 16).replace("T", " ")}Z  ${l.text}`);
console.log(`\nFor the LiveKit minutes (the part that costs money) and class-notes status, open the admin page: /admin/recorder\n`);
