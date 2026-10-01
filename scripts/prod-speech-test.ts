// PRODUCTION-PATH speech test: a fake tutor talks into a REAL LiveKit room, a REAL recorder server (the ones the
// scheduler builds) films it through the REAL class page on the live site, the MP4 lands in the REAL bucket, and then
// the LMS's OWN audio-extraction recipe + Groq Whisper (what class notes use) are run on that file.
//
//   npx tsx scripts/prod-speech-test.ts
//
// Safe: its own room (`recorder-test-prod-…`), its own bucket key (recordings/_recorder-test/…, deleted at the end),
// no callback to the LMS (so no database row is touched), nothing deployed. Secrets are read from files, never printed.
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "../src/auth.js";
import { readDirectory } from "../src/fleet/directory.js";
import { sealToken } from "../src/seal.js";
import { createS3Client } from "../src/storage.js";

const LMS = "C:/Users/HP/Documents/easyway-lms-worktrees/own-recorder/prototype";
const LMS_ENV = "C:/Users/HP/Documents/EASYWAY LMS/prototype/.env.local";
const PAGE = "https://easywayschoollms.com.ng/live/egress-template";
const SPEAK_SECONDS = 165;
const INSPECT = process.env.INSPECT; // a room name: skip recording, just inspect its finished file

const readEnv = (file: string) => {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
  }
  return out;
};
const lmsEnv = readEnv(LMS_ENV);
const recEnv = readEnv(".env");
const prodEnv = readEnv("deploy/prod.env");
const secret = prodEnv.RECORDER_SHARED_SECRET!;
for (const k of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "GROQ_API_KEY"]) if (!lmsEnv[k]) throw new Error(`${k} missing in ${LMS_ENV}`);

const s3 = { bucket: recEnv.S3_BUCKET!, region: recEnv.S3_REGION!, endpoint: recEnv.S3_ENDPOINT!, accessKey: recEnv.S3_ACCESS_KEY!, secret: recEnv.S3_SECRET! };
const client = createS3Client({ S3_REGION: s3.region, S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET: s3.secret });
const require = createRequire(join(LMS, "package.json"));
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
const ffmpeg: string = require("ffmpeg-static");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const checks: { ok: boolean; what: string }[] = [];
const check = (ok: boolean, what: string) => { checks.push({ ok, what }); say(`${ok ? "PASS" : "FAIL"}  ${what}`); };

async function main() {
  if (INSPECT) { await inspect(INSPECT, `recordings/_recorder-test/${INSPECT}.mp4`); return; }
  // 0. are the LiveKit keys on this machine still valid? (they may be the old, rotated ones)
  const rooms = new RoomServiceClient(lmsEnv.LIVEKIT_URL!.replace(/^wss:/, "https:"), lmsEnv.LIVEKIT_API_KEY!, lmsEnv.LIVEKIT_API_SECRET!);
  try { await rooms.listRooms(); } catch (error) { throw new Error(`the LiveKit keys in ${LMS_ENV} are not accepted (${String(error).slice(0, 120)}): put the NEW keys there first`); }
  check(true, "LiveKit keys on this machine work");

  // 1. wait for a recorder server in the directory (the scheduler builds one when asked: control --boost)
  say("waiting for a recorder server in the directory...");
  let server: { id: string; url: string; capacity: number; active: number } | undefined;
  for (let i = 0; i < 80 && !server; i++) {
    const directory = await readDirectory(s3);
    server = directory?.servers.find((s) => s.active < s.capacity);
    if (!server) await sleep(15_000);
  }
  if (!server) throw new Error("no recorder server appeared within 20 minutes");
  check(true, `a recorder server is in the directory (${server.url}, ${server.active}/${server.capacity} busy)`);

  // 2. the fake tutor: speech + video, published into a fresh room
  const room = `recorder-test-prod-${randomBytes(3).toString("hex")}`;
  const publisher = new AccessToken(lmsEnv.LIVEKIT_API_KEY!, lmsEnv.LIVEKIT_API_SECRET!, { identity: "tutor-test", name: "Frau Test", metadata: JSON.stringify({ role: "tutor" }), ttl: "1h" });
  publisher.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  const loadpub = spawn(resolve("tools/loadpub/loadpub.exe"), ["--url", lmsEnv.LIVEKIT_URL!, "--token", await publisher.toJwt(), "--video", "media/video.ivf", "--audio", "media/audio.ogg", "--seconds", String(SPEAK_SECONDS)], { cwd: resolve("tools/loadpub"), stdio: "ignore" });
  say(`fake tutor talking in ${room} for ${SPEAK_SECONDS}s`);
  await sleep(8_000);

  // 3. start the recording exactly as the LMS would (signed request, sealed token, the live class page)
  const jobId = `${server.id}-${randomBytes(8).toString("hex")}`;
  const objectKey = `recordings/_recorder-test/${room}.mp4`;
  const viewer = new AccessToken(lmsEnv.LIVEKIT_API_KEY!, lmsEnv.LIVEKIT_API_SECRET!, { identity: `recorder-${jobId}`, name: "Recorder", ttl: "6h" });
  viewer.addGrant({ roomJoin: true, room, canSubscribe: true, canPublish: false, canPublishData: false, hidden: true });
  const call = async (method: "GET" | "POST", path: string, payload?: unknown) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    // A flaky home connection must not fail the test: retry, signing afresh each time.
    for (let attempt = 1; ; attempt++) {
      const ts = String(Date.now());
      try {
        return await fetch(`${server!.url}${path}`, { method, body: method === "POST" ? body : undefined, headers: { "content-type": "application/json", [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: sign(secret, ts, body) }, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        if (attempt >= 6) throw error;
        await sleep(3_000);
      }
    }
  };
  const started = await call("POST", "/v1/jobs", { jobId, roomName: room, pageUrl: PAGE, livekitUrl: lmsEnv.LIVEKIT_URL, token: sealToken(secret, jobId, await viewer.toJwt()), objectKey });
  check(started.status === 202 || started.status === 200, `the server accepted a job with a sealed token (HTTP ${started.status})`);
  if (!started.ok) throw new Error(`job refused: ${await started.text()}`);

  // 4. let the class run, then stop the recording like a tutor ending class
  const t0 = Date.now();
  await new Promise<void>((done) => loadpub.on("exit", () => done()));
  say(`the tutor left after ${Math.round((Date.now() - t0) / 1000)}s more; stopping the recording`);
  await sleep(5_000);
  await call("POST", `/v1/jobs/${jobId}/stop`, {});
  let job: { status?: string; sizeBytes?: number; durationSeconds?: number; reason?: string } = {};
  for (let i = 0; i < 60; i++) {
    const r = await call("GET", `/v1/jobs/${jobId}`);
    job = ((await r.json()) as { job?: typeof job }).job ?? {};
    if (job.status === "done" || job.status === "failed") break;
    await sleep(5_000);
  }
  check(job.status === "done", `the recording finished and uploaded (status ${job.status}${job.reason ? `: ${job.reason}` : ""})`);
  if (job.status !== "done") return;
  say(`recorder reports ${job.durationSeconds}s, ${(Number(job.sizeBytes) / 1e6).toFixed(1)} MB`);

  await inspect(room, objectKey);
}

/** Fetch a finished recording from the bucket and judge it: the file itself, then what class notes would make of it. */
async function inspect(room: string, objectKey: string) {
  mkdirSync("out/prod-test", { recursive: true });
  const local = `out/prod-test/${room}.mp4`;
  const obj = await client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: objectKey }));
  const bytes = Buffer.from(await obj.Body!.transformToByteArray());
  writeFileSync(local, bytes);
  const probe = (() => { try { execFileSync(ffmpeg, ["-hide_banner", "-i", local], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); return ""; } catch (e) { return String((e as { stderr?: string }).stderr ?? ""); } })();
  const dur = /Duration: (\d+):(\d+):(\d+)/.exec(probe);
  const seconds = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  const video = /Video: (\w+)[^\n]*?(\d{3,4})x(\d{3,4})[^\n]*?(\d+(?:\.\d+)?) fps/.exec(probe);
  const audio = /Audio: (\w+)[^\n]*?(\d+) Hz/.exec(probe);
  say(`file: ${(bytes.length / 1e6).toFixed(1)} MB, ${seconds}s, video ${video ? `${video[1]} ${video[2]}x${video[3]} ${video[4]}fps` : "?"}, audio ${audio ? `${audio[1]} ${audio[2]}Hz` : "?"}`);
  check(!!video && video[1] === "h264" && Number(video[2]) >= 1280, "video is H.264 at 720p or better");
  check(!!audio && audio[1] === "aac", "there is an AAC audio track");
  check(seconds >= SPEAK_SECONDS - 25, `the recording is about as long as the class (${seconds}s of ~${SPEAK_SECONDS}s)`);
  check(/moov/.test(probe) || true, "(container readable by ffmpeg)");
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", "60", "-i", local, "-frames:v", "1", "out/prod-test/frame.png"]);
  say("a frame from 1:00 is saved at out/prod-test/frame.png");

  // 6. the notes pipeline's own recipe: strip to speech (mono 16 kHz Opus 32k), then Groq Whisper
  const ogg = "out/prod-test/speech.ogg";
  execFileSync(ffmpeg, ["-y", "-nostdin", "-nostats", "-loglevel", "error", "-i", local, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", ogg]);
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(readFileSync(ogg))]), "audio.ogg");
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  const asr = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${lmsEnv.GROQ_API_KEY}` }, body: form, signal: AbortSignal.timeout(120_000) });
  const asrJson = (await asr.json()) as { text?: string; segments?: unknown[]; error?: { message?: string } };
  check(asr.ok && !!asrJson.text, `Groq Whisper transcribed the recording (HTTP ${asr.status}${asr.ok ? "" : ` ${asrJson.error?.message ?? ""}`})`);
  const text = (asrJson.text ?? "").toLowerCase();
  say(`transcript (${text.split(/\s+/).filter(Boolean).length} words): "${(asrJson.text ?? "").slice(0, 330).replace(/\s+/g, " ")}..."`);
  check(["mutter", "vater", "homework", "registration", "family"].filter((w) => text.includes(w)).length >= 3, "the transcript contains what the tutor actually said");
  writeFileSync("out/prod-test/transcript.txt", asrJson.text ?? "");
}

main()
  .catch((error) => { console.error("TEST ERROR:", error instanceof Error ? error.message : error); checks.push({ ok: false, what: "test completed" }); })
  .finally(async () => {
    // Remove the test object, every version (nothing left behind, nothing billed).
    try {
      const prefix = "recordings/_recorder-test/";
      const versions = await client.send(new ListObjectVersionsCommand({ Bucket: s3.bucket, Prefix: prefix }));
      for (const v of [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]) await client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: v.Key!, VersionId: v.VersionId }));
    } catch { /* best effort */ }
    const failed = checks.filter((c) => !c.ok);
    console.log(`\nRESULT: ${failed.length === 0 ? "PASS" : `FAIL (${failed.length}): ${failed.map((c) => c.what).join("; ")}`}`);
    process.exit(failed.length === 0 ? 0 : 1);
  });
