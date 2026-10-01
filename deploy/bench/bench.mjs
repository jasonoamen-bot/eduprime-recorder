#!/usr/bin/env node
// SERVER LOAD TEST: how many simultaneous classes can THIS machine record?
//
// Runs ON the server (Linux, Node 18+, Docker). For each requested number of classes it:
//   1. starts that many light fake tutors (Go `loadpub`, pre-encoded video+audio) in separate LiveKit rooms,
//   2. starts one recording per room on the local recorder,
//   3. samples the whole machine (CPU busy, steal, memory) and the recorder container for --seconds,
//   4. stops everything, then inspects every finished file: frozen picture, sound present, sync, size.
//
//   node bench.mjs --classes 1,2,4 --seconds 240
//
// Needs /opt/eduprime-recorder/bench/bench.env with LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
// RECORDER_SHARED_SECRET, and the recorder running with LOCAL_OUTPUT_DIR=/out, SERVE_FIXTURES=1,
// ALLOWED_PAGE_ORIGINS=http://127.0.0.1:8080, MAX_CONCURRENT_JOBS>=the largest class count.
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { cpus, totalmem } from "node:os";

const BENCH = "/opt/eduprime-recorder/bench";
const OUT = "/opt/eduprime-recorder/out";
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const classCounts = arg("classes", "1,2,4").split(",").map(Number);
const seconds = Number(arg("seconds", 240));
const RECORDER = "http://127.0.0.1:8787";

const env = {};
for (const line of readFileSync(`${BENCH}/bench.env`, "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
for (const k of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "RECORDER_SHARED_SECRET"]) if (!env[k]) throw new Error(`${k} missing in bench.env`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (x) => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();

/** A LiveKit access token is a plain HS256 JWT, so no SDK is needed on the server. */
function token(identity, room, grants, metadata) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: env.LIVEKIT_API_KEY, sub: identity, name: identity, nbf: now - 10, exp: now + 3 * 3600, ...(metadata ? { metadata } : {}), video: { roomJoin: true, room, ...grants } });
  const sig = createHmac("sha256", env.LIVEKIT_API_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

async function api(method, path, payload) {
  const body = payload ? JSON.stringify(payload) : "";
  const ts = String(Date.now());
  const sig = "sha256=" + createHmac("sha256", env.RECORDER_SHARED_SECRET).update(`${ts}.${body}`).digest("hex");
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(RECORDER + path, { method, headers: { "content-type": "application/json", "x-recorder-timestamp": ts, "x-recorder-signature": sig }, body: method === "POST" ? body : undefined });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    } catch { await sleep(1000 * attempt); }
  }
  throw new Error("recorder API unreachable");
}

/** Whole-machine CPU: busy % and steal % (time a cloud host took back for other customers). */
function cpuTimes() {
  const f = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
  const [user, nice, sys, idle, iowait, irq, softirq, steal] = f;
  return { busy: user + nice + sys + irq + softirq, idle: idle + iowait, steal: steal || 0 };
}

async function scenario(n) {
  console.log(`\n========== ${n} CLASS${n > 1 ? "ES" : ""} AT ONCE, ${seconds} s ==========`);
  const tag = randomBytes(3).toString("hex");
  const classes = Array.from({ length: n }, (_, i) => ({ i, room: `bench-${tag}-${i + 1}`, jobId: randomBytes(8).toString("hex") }));
  const tutors = [];

  // 1. fake tutors
  for (const c of classes) {
    const t = token(`tutor-${c.i}`, c.room, { canPublish: true, canSubscribe: true }, JSON.stringify({ role: "tutor" }));
    const p = spawn(`${BENCH}/loadpub`, ["--url", env.LIVEKIT_URL, "--token", t, "--video", `${BENCH}/media/video.ivf`, "--audio", `${BENCH}/media/audio.ogg`, "--seconds", String(seconds + 240)], { stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    p.stdout.on("data", (d) => (log += d));
    p.stderr.on("data", (d) => (log += d));
    c.tutor = { p, ready: () => /publishing for/.test(log), log: () => log };
    tutors.push(p);
  }
  for (let i = 0; i < 120 && !classes.every((c) => c.tutor.ready()); i++) await sleep(500);
  if (!classes.every((c) => c.tutor.ready())) { tutors.forEach((p) => p.kill()); throw new Error("a fake tutor could not join LiveKit"); }

  // 2. recordings
  const startedAt = Date.now();
  for (const c of classes) {
    c.objectKey = `recordings/bench/${c.room}.mp4`;
    const r = await api("POST", "/v1/jobs", {
      jobId: c.jobId, roomName: c.room, pageUrl: "http://127.0.0.1:8080/livekit-viewer.html", livekitUrl: env.LIVEKIT_URL,
      token: token(`recorder-${c.jobId}`, c.room, { canSubscribe: true, canPublish: false, canPublishData: false, hidden: true }), objectKey: c.objectKey,
    });
    if (r.status !== 202 && r.status !== 200) { tutors.forEach((p) => p.kill()); throw new Error(`recorder refused a class: HTTP ${r.status} ${JSON.stringify(r.json)}`); }
  }
  for (let i = 0; i < 300; i++) {
    const states = await Promise.all(classes.map(async (c) => (await api("GET", `/v1/jobs/${c.jobId}`)).json.job?.status));
    if (states.every((s) => s === "recording")) break;
    if (states.some((s) => s === "failed")) { tutors.forEach((p) => p.kill()); throw new Error("a recording failed to start"); }
    await sleep(1000);
  }
  const startupSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(`all ${n} recording after ${startupSec} s (browser start + join, all at once)`);

  // 3. sample
  const samples = [];
  let prev = cpuTimes();
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) {
    await sleep(10_000);
    const now = cpuTimes();
    const dBusy = now.busy - prev.busy, dIdle = now.idle - prev.idle, dSteal = now.steal - prev.steal, total = dBusy + dIdle + dSteal || 1;
    const stat = docker("stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", "recorder").split("|");
    // "473.9MiB / 7.755GiB": read the USED part only (before the slash), not the limit's unit.
    const used = stat[1].split("/")[0];
    const mem = parseFloat(used) * (/GiB/.test(used) ? 1024 : /KiB/.test(used) ? 1 / 1024 : 1);
    samples.push({ busyPct: (dBusy / total) * 100, stealPct: (dSteal / total) * 100, recorderCores: parseFloat(stat[0]) / 100, memMiB: mem });
    prev = now;
    process.stdout.write(`  ${Math.round((Date.now() - (end - seconds * 1000)) / 1000)}s  machine ${samples.at(-1).busyPct.toFixed(0)}% busy, recorder ${samples.at(-1).recorderCores.toFixed(2)} cores\n`);
  }

  // 4. stop + analyse
  await Promise.all(classes.map((c) => api("POST", `/v1/jobs/${c.jobId}/stop`, {})));
  for (let i = 0; i < 240; i++) {
    const states = await Promise.all(classes.map(async (c) => (await api("GET", `/v1/jobs/${c.jobId}`)).json.job?.status));
    if (states.every((s) => s === "done" || s === "failed")) break;
    await sleep(2000);
  }
  tutors.forEach((p) => p.kill());

  const rows = [];
  for (const c of classes) {
    const file = `/out/${c.objectKey}`;
    let row = { room: c.room, ok: false };
    try {
      const probe = JSON.parse(docker("exec", "recorder", "ffprobe", "-v", "error", "-show_entries", "format=duration,size", "-of", "json", file)).format;
      const dur = Number(probe.duration);
      // ffmpeg prints its analysis on stderr, which spawnSync hands back (execFileSync would discard it on success).
      const run = (...vf) => spawnSync("docker", ["exec", "recorder", "ffmpeg", "-i", file, ...vf, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stderr || "";
      const freezeText = run("-vf", "freezedetect=n=-55dB:d=2", "-an");
      // The fake tutor needs ~1 minute before its video flows and its video file ends ~10 s before we stop
      // recording; neither is the recorder's doing. Judge the STEADY STATE: from 60 s to 15 s before the end.
      const pairs = [...freezeText.matchAll(/freeze_start:\s*([\d.]+)[\s\S]*?freeze_duration:\s*([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      const steady = pairs.filter(([start]) => start >= 60 && start <= dur - 15);
      const frozen = steady.reduce((s, [, d]) => s + d, 0);
      const vol = Number((run("-af", "volumedetect", "-vn").match(/mean_volume:\s*(-?[\d.]+)/) || [])[1] ?? -Infinity);
      row = {
        room: c.room, ok: true, minutes: +(dur / 60).toFixed(1), mbPerMin: +((Number(probe.size) / 1e6) / (dur / 60)).toFixed(2),
        freezes: steady.length, frozenSeconds: +frozen.toFixed(1), frozenPct: +((frozen / Math.max(1, dur - 75)) * 100).toFixed(1), soundDb: vol,
      };
    } catch (e) {
      row.error = String(e.message).slice(0, 160);
    }
    rows.push(row);
  }
  const avg = (k) => samples.reduce((s, x) => s + x[k], 0) / Math.max(1, samples.length);
  const result = {
    classes: n, seconds, startupSec,
    machineBusyAvgPct: +avg("busyPct").toFixed(0), machineBusyMaxPct: +Math.max(...samples.map((s) => s.busyPct)).toFixed(0),
    stealAvgPct: +avg("stealPct").toFixed(1),
    recorderCoresAvg: +avg("recorderCores").toFixed(2), recorderCoresMax: +Math.max(...samples.map((s) => s.recorderCores)).toFixed(2),
    coresPerClassAvg: +(avg("recorderCores") / n).toFixed(2),
    peakMemMiB: Math.round(Math.max(...samples.map((s) => s.memMiB))),
    classesDetail: rows,
  };
  console.log("RESULT " + JSON.stringify(result));
  return result;
}

console.log(`machine: ${cpus().length} CPU threads, ${(totalmem() / 1024 ** 3).toFixed(1)} GB RAM, model ${cpus()[0].model}`);
const all = [];
for (const n of classCounts) {
  try { all.push(await scenario(n)); } catch (e) { console.log(`SCENARIO ${n} FAILED: ${e.message}`); all.push({ classes: n, error: e.message }); }
  await sleep(15_000); // let everything settle
}
writeFileSync(`${BENCH}/results-${Date.now()}.json`, JSON.stringify({ machine: { threads: cpus().length, model: cpus()[0].model }, all }, null, 2));
console.log("\n=== SUMMARY ===");
for (const r of all) {
  if (r.error) { console.log(`${r.classes} classes: FAILED (${r.error})`); continue; }
  const worst = Math.max(...r.classesDetail.map((d) => d.frozenPct ?? 0));
  const quiet = r.classesDetail.some((d) => (d.soundDb ?? -99) < -50);
  console.log(`${r.classes} classes: machine ${r.machineBusyAvgPct}% busy (steal ${r.stealAvgPct}%), recorder ${r.recorderCoresAvg} cores avg / ${r.recorderCoresMax} max = ${r.coresPerClassAvg} cores per class, memory peak ${r.peakMemMiB} MiB, worst frozen picture ${worst}%${quiet ? ", SOME RECORDING HAS NO SOUND" : ""}`);
}
console.log("\nRule of thumb: the largest class count whose worst frozen picture stays under ~1% and whose machine stays under ~85% busy is what this server can safely handle.");
