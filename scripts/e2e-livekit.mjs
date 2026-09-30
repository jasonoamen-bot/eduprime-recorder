// REAL LiveKit test of the whole loop, on this machine, with a fake tutor:
//
//   fake tutor (container, fake camera+mic) --> REAL LiveKit room <-- recorder (container, hidden viewer)
//   the LMS's OWN code (lib/recorder.ts) starts the job and checks the callback.
//
//   node scripts/e2e-livekit.mjs [publishSeconds]
//
// SAFETY, because this shares a laptop and a LiveKit project with real classes:
//   - own room name (`recorder-test-…`), never a class room
//   - refuses to run if the machine is short of RAM or CPU (override: FORCE=1)
//   - containers are CPU- and memory-capped
//   - touches no database, deploys nothing
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cpus, freemem } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LMS = process.env.LMS_DIR || "C:/Users/HP/Documents/easyway-lms-worktrees/own-recorder/prototype";
const ENV_FILE = process.env.LIVEKIT_ENV_FILE || "C:/Users/HP/Documents/EASYWAY LMS/prototype/.env.local";
const IMAGE = "eduprime-recorder:dev";
const publishSeconds = Number(process.argv[2] || 60);
const HOST_PORT = 3300;
const HOST = "host.docker.internal";
const fixtures = resolve("fixtures");
const outDir = resolve("out");

const sh = (args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
// Helper scripts (seed/inspect the throwaway DB, talk to the local MinIO) — print one JSON line.
const nodeJson = (script, args) => JSON.parse(execFileSync("node", [join("scripts", script), ...args], { encoding: "utf8" }).trim().split("\n").pop());
const LMS_CALLBACK = "http://127.0.0.1:3200/api/recorder/callback";
async function replayCallback(payload) {
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const res = await fetch(LMS_CALLBACK, { method: "POST", headers: { "content-type": "application/json", "x-recorder-timestamp": ts, "x-recorder-signature": lms.signRecorderBody(secret, ts, body) }, body });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1);

/* ---------- 0. is the machine calm enough? ---------- */
function cpuBusyPercent() {
  const sample = () => cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); return [a[0] + c.times.idle, a[1] + t]; }, [0, 0]);
  const [i1, t1] = sample();
  return new Promise((r) => setTimeout(() => { const [i2, t2] = sample(); r(Math.round((1 - (i2 - i1) / (t2 - t1)) * 100)); }, 2000));
}
const freeGb = Number(gb(freemem()));
const busy = await cpuBusyPercent();
console.log(`machine: ${freeGb} GB RAM free, CPU ${busy}% busy`);
if ((freeGb < 1.2 || busy > 60) && !process.env.FORCE) {
  console.log("\nNOT RUNNING: the machine is too busy for this test to be safe alongside whatever else is open");
  console.log("(needs >= 1.2 GB free RAM and <= 60% CPU). Close things or wait, then run again. FORCE=1 overrides.");
  process.exit(3);
}

/* ---------- 1. LiveKit credentials (never printed) ---------- */
const vars = {};
for (const line of readFileSync(ENV_FILE, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^\s*(LIVEKIT_URL|LIVEKIT_API_KEY|LIVEKIT_API_SECRET)\s*=\s*(.*?)\s*$/);
  if (m) vars[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}
for (const k of ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"]) if (!vars[k]) throw new Error(`${k} missing in ${ENV_FILE}`);

const require = createRequire(join(LMS, "package.json"));
const { AccessToken, RoomServiceClient } = require("livekit-server-sdk");
// The LMS's OWN recorder module — so this also proves LMS <-> recorder compatibility.
const lms = await import(pathToFileURL(join(LMS, "src/lib/recorder.ts")).href);

// In REAL_DIRECT mode the real LMS route verifies the signature, so both sides need the same secret:
// the throwaway one in the worktree's git-ignored .env. Otherwise a fresh random one.
const S3_TEST = process.env.S3_TEST; // upload to the LOCAL MinIO, then exercise the real LMS callback + library logic
let secret = randomBytes(32).toString("hex");
if (process.env.REAL_DIRECT || S3_TEST) {
  const m = readFileSync(join(LMS, ".env"), "utf8").match(/^RECORDER_SHARED_SECRET=(\S+)/m);
  if (!m) throw new Error("REAL_DIRECT needs RECORDER_SHARED_SECRET in the worktree .env");
  secret = m[1];
}
const roomName = `recorder-test-${randomBytes(3).toString("hex")}`;
const jobId = randomBytes(8).toString("hex");
const objectKey = `recordings/test/${roomName}.mp4`;
// REAL_DIRECT=http://host.docker.internal:3200 -> the recorder talks straight to the real
// LMS dev server (no proxy: dev-mode live-reload websockets cannot pass through one).
// The callback then hits the REAL /api/recorder/callback route — read the dev server log for it.
const REAL_DIRECT = process.env.REAL_DIRECT;
const localBase = `http://${HOST}:${HOST_PORT}`; // this script's own server: fake-tutor page + vendor files
const base = REAL_DIRECT || localBase;
const env = { RECORDER_URL: "http://127.0.0.1:8787", RECORDER_SHARED_SECRET: secret, RECORDING_BACKEND: "recorder", NEXT_PUBLIC_APP_URL: base, ...vars };

/* ---------- 2. host server: the class page + a callback catcher ---------- */
const callbacks = [];
// REAL_PAGE=http://127.0.0.1:3200 -> serve the REAL Next.js class page (through this
// server, so callbacks can still be caught here) instead of the stand-in viewer.
const REAL_PAGE = process.env.REAL_PAGE;
const routes = { "/publisher.html": join(fixtures, "publisher.html"), "/vendor/livekit-client.umd.js": join(LMS, "node_modules/livekit-client/dist/livekit-client.umd.js") };
if (!REAL_PAGE) routes["/live/egress-template"] = join(fixtures, "livekit-viewer.html");
const server = createServer(async (req, res) => {
  const path = new URL(req.url, localBase).pathname;
  if (req.method === "POST" && path === "/api/recorder/callback") {
    let body = ""; for await (const c of req) body += c;
    const verdict = lms.verifyRecorderRequest({ secret, timestamp: req.headers["x-recorder-timestamp"], signature: req.headers["x-recorder-signature"], body });
    const parsed = verdict.ok ? lms.parseRecorderCallback(JSON.parse(body)) : null;
    callbacks.push({ verdict, parsed, egress: parsed ? lms.callbackToEgress(parsed) : null });
    res.writeHead(verdict.ok ? 200 : 401).end("{}");
    return;
  }
  const file = routes[path];
  if (file && existsSync(file)) { res.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript" : "text/html", "content-length": statSync(file).size }); createReadStream(file).pipe(res); return; }
  if (REAL_PAGE && req.method === "GET") {
    const upstream = await fetch(REAL_PAGE + req.url, { headers: { accept: req.headers.accept || "*/*" }, redirect: "manual" }).catch(() => null);
    if (!upstream) { res.writeHead(502).end(); return; }
    if (upstream.status >= 300 && upstream.status < 400) console.log(`  [proxy] ${req.url.split("?")[0]} answered ${upstream.status} -> ${upstream.headers.get("location")}`);
    const buf = Buffer.from(await upstream.arrayBuffer());
    const headers = { "content-type": upstream.headers.get("content-type") || "text/plain", "content-length": buf.length };
    if (upstream.headers.get("location")) headers.location = upstream.headers.get("location");
    res.writeHead(upstream.status, headers).end(buf);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(HOST_PORT, "0.0.0.0", r));

/* ---------- 3. containers, capped ---------- */
rmSync(outDir, { recursive: true, force: true }); mkdirSync(outDir, { recursive: true });
for (const n of ["er-lk-recorder", "er-lk-publisher"]) spawnSync("docker", ["rm", "-f", n], { stdio: "ignore" });
const common = ["--add-host", `${HOST}:host-gateway`, "-v", `${fixtures}:/app/fixtures:ro`, "--shm-size=512m"];
let recorderPeak = { cpu: 0, mem: "" };
// SOAK=1: a long class. Samples the recorder's CPU/memory over time and analyses the finished file
// for frozen video, picture/sound length mismatch and timing drift.
const SOAK = process.env.SOAK;
// What the recorder container may use. Real classes need ~3 cores; the default is what the first tests used.
const RECORDER_CPUS = Number(process.env.RECORDER_CPUS || 2);
const RECORDER_MEM = Number(process.env.RECORDER_MEM || 1500);
// The fake tutor is the test rig, not the thing under test: give it enough CPU that it is not the weak link.
const PUBLISHER_CPUS = Number(process.env.PUBLISHER_CPUS || 1);
// PUBLISHER=go: use tools/loadpub (pre-encoded media, ~no CPU) instead of a browser-based fake tutor, so the
// machine's CPU is spent on the recorder being measured, not on the test rig.
const PUBLISHER_GO = process.env.PUBLISHER === "go";
let goPub = null;
const series = [];
let lastSample = 0;
// PROFILE=1: which part of the recorder uses the CPU? Snapshot cumulative CPU seconds per process group
// ~75 s into the recording and again near the end; the difference over the time between = cores used.
const PROFILE = process.env.PROFILE;
let recordingSeenAt = 0, prof1 = null, profLast = null, lastProf = 0;
const classify = (a) => /ffmpeg/.test(a) ? "ffmpeg (encode)" : /Xvfb/.test(a) ? "Xvfb (virtual screen)" : /pulseaudio/.test(a) ? "pulseaudio"
  : /--type=gpu-process/.test(a) ? "chromium GPU process" : /--type=renderer/.test(a) ? "chromium renderer (page + video decode)"
  : /--type=utility/.test(a) ? "chromium utility (network/audio)" : /--type=zygote/.test(a) ? "chromium zygote"
  : /chromium|chrome/.test(a) ? "chromium browser process" : /node/.test(a) ? "recorder (node)" : "other";
function psSnapshot() {
  const out = sh(["exec", "er-lk-recorder", "ps", "-eo", "pid=,cputimes=,args="]);
  const groups = {};
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) { const g = classify(m[3]); groups[g] = (groups[g] || 0) + Number(m[2]); }
  }
  return { t: Date.now(), groups };
}
const soakStart = Date.now();
const toMiB = (s) => { const n = parseFloat(s); return /GiB/i.test(s) ? n * 1024 : /KiB/i.test(s) ? n / 1024 : n; };
let audioMean = -Infinity;
let ok = false;
try {
  console.log(`starting recorder (capped: ${RECORDER_CPUS} CPUs, ${RECORDER_MEM} MB${process.env.VIDEO_PRESET ? ", preset " + process.env.VIDEO_PRESET : ""})…`);
  sh(["run", "-d", "--name", "er-lk-recorder", `--cpus=${RECORDER_CPUS}`, `--memory=${RECORDER_MEM}m`, `--memory-swap=${RECORDER_MEM}m`, "-p", "8787:8787", ...common,
    // Tuning knobs passed straight through when set (presets, frame rate, size, browser flags).
    ...["VIDEO_PRESET", "VIDEO_FPS", "VIDEO_WIDTH", "VIDEO_HEIGHT", "VIDEO_CRF", "CHROMIUM_EXTRA_ARGS"].flatMap((k) => (process.env[k] ? ["-e", `${k}=${process.env[k]}`] : [])),
    "-v", `${outDir}:/out`, "-e", `RECORDER_SHARED_SECRET=${secret}`,
    // S3_TEST: the recorder uploads through its real S3 code to the local MinIO; otherwise it just copies files.
    ...(S3_TEST
      ? ["-e", "S3_BUCKET=recorder-test", "-e", "S3_REGION=us-east-1", "-e", `S3_ENDPOINT=http://${HOST}:9000`, "-e", "S3_ACCESS_KEY=recordertest", "-e", "S3_SECRET=recordertest-secret-123"]
      : ["-e", "LOCAL_OUTPUT_DIR=/out"]),
    "-e", `PAGE_JOIN_TIMEOUT_SECONDS=${process.env.PAGE_JOIN_TIMEOUT_SECONDS || 45}`,
    "-e", `ALLOWED_PAGE_ORIGINS=${base}`, "-e", `ALLOWED_CALLBACK_ORIGINS=${base}`, IMAGE]);
  for (let i = 0; i < 120; i++) { try { if ((await fetch("http://127.0.0.1:8787/healthz")).ok) break; } catch {} await sleep(500); }

  const at = new AccessToken(vars.LIVEKIT_API_KEY, vars.LIVEKIT_API_SECRET, { identity: "test-tutor", name: "Test Tutor", ttl: "1h", metadata: JSON.stringify({ role: "tutor" }) });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  const tutorToken = await at.toJwt();
  const pubUrl = `${localBase}/publisher.html?url=${encodeURIComponent(vars.LIVEKIT_URL)}&token=${encodeURIComponent(tutorToken)}`;
  console.log(`starting fake tutor in room ${roomName} for ${publishSeconds}s (capped: ${PUBLISHER_CPUS} CPU, 0.8 GB)…`);
  if (PUBLISHER_GO) {
    // Its log is very chatty (WebRTC internals): keep it in a file, and only trust the tutor once it says it is publishing.
    mkdirSync(outDir, { recursive: true });
    const pubLogPath = join(outDir, "loadpub.log");
    const pubLog = openSync(pubLogPath, "w");
    goPub = spawn(join("tools", "loadpub", "loadpub.exe"), ["--url", vars.LIVEKIT_URL, "--token", tutorToken, "--video", join("tools", "loadpub", "media", "video.ivf"), "--audio", join("tools", "loadpub", "media", "audio.ogg"), "--seconds", String(publishSeconds + 12)], { stdio: ["ignore", pubLog, pubLog] });
    let pubExited = false;
    goPub.on("exit", () => { pubExited = true; });
    let ready = false;
    for (let i = 0; i < 180 && !ready; i++) {
      await sleep(500);
      ready = /publishing for/.test(readFileSync(pubLogPath, "utf8"));
      if (pubExited && !ready) throw new Error("the fake tutor could not join the room (see out/loadpub.log)");
    }
    if (!ready) throw new Error("the fake tutor never started publishing (see out/loadpub.log)");
    console.log("fake tutor is publishing (light Go publisher)");
  } else sh(["run", "-d", "--name", "er-lk-publisher", `--cpus=${PUBLISHER_CPUS}`, "--memory=800m", "--memory-swap=800m", ...common, "--entrypoint", "/usr/bin/tini", IMAGE, "--", "node", "fixtures/publisher-run.mjs", pubUrl, String(publishSeconds + 12)]);
  await sleep(10_000);

  // The LMS's own code starts the recording — token minting, signing, URLs and all.
  const started = await lms.startRecorderJob({ roomName, objectKey, jobId }, env);
  console.log("LMS startRecorderJob ->", JSON.stringify(started));
  if (!started.ok) throw new Error("the LMS could not start the recorder: " + JSON.stringify(started));

  // Docker's port forwarding drops a request now and then when the laptop is saturated: retry instead of dying.
  const view = async () => {
    let lastError;
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        return (await (await fetch(`http://127.0.0.1:8787/v1/jobs/${started.jobId}`, { headers: (() => { const t = String(Date.now()); return { "x-recorder-timestamp": t, "x-recorder-signature": lms.signRecorderBody(secret, t, "") }; })() })).json()).job;
      } catch (error) {
        lastError = error;
        await sleep(1500 * attempt);
      }
    }
    throw lastError;
  };
  let job;
  // The fake tutor leaves at about (start + publishSeconds + 12 + a few s of browser startup).
  // STOP=1 then ends the recording the way the LMS's "End class" does (stopRecorderJob),
  // instead of waiting for the page's own 2-minute empty-room timer.
  const leavesAt = Date.now() - 10_000 + (publishSeconds + 12 + 6) * 1000;
  let stopped = false;
  for (let i = 0; i < publishSeconds + 300; i++) {
    await sleep(2000);
    if (process.env.STOP && !stopped && Date.now() > leavesAt + 8_000) {
      stopped = true;
      console.log("  LMS stopRecorderJob ->", await lms.stopRecorderJob(started.jobId, env));
    }
    job = await view();
    if (i % 5 === 0) console.log("  recorder:", job.status);
    if (PROFILE && job.status === "recording") {
      recordingSeenAt ||= Date.now();
      if (!prof1 && Date.now() - recordingSeenAt > 75_000) { prof1 = psSnapshot(); lastProf = Date.now(); }
      else if (prof1 && Date.now() - lastProf > 15_000) { profLast = psSnapshot(); lastProf = Date.now(); }
    }
    // SOAK samples every 30 s (a `docker stats` call is slow and there are ~900 polls in 30 minutes).
    if (job.status === "recording" && Date.now() - lastSample >= (SOAK ? 30_000 : 0)) {
      lastSample = Date.now();
      const [cpu, mem] = sh(["stats", "er-lk-recorder", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}"]).split("|");
      if (parseFloat(cpu) > recorderPeak.cpu) recorderPeak = { cpu: parseFloat(cpu), mem };
      series.push({ t: Math.round((Date.now() - soakStart) / 1000), cpu: parseFloat(cpu), memMiB: toMiB(mem.split("/")[0]) });
      if (SOAK && series.length % 10 === 0) console.log(`  [soak ${Math.round(series.at(-1).t / 60)} min] cpu ${series.at(-1).cpu}%  mem ${series.at(-1).memMiB.toFixed(0)} MiB`);
    }
    if (job.status === "done" || job.status === "failed") break;
  }
  if (PROFILE && prof1 && profLast) {
    const secs = (profLast.t - prof1.t) / 1000;
    const rows = Object.keys(profLast.groups).map((g) => [g, ((profLast.groups[g] - (prof1.groups[g] || 0)) / secs)]).sort((a, b) => b[1] - a[1]);
    console.log(`\nCPU BY PART (cores used, averaged over ${secs.toFixed(0)} s of steady recording):`);
    for (const [g, c] of rows) console.log(`   ${c.toFixed(2).padStart(5)}  ${g}`);
    console.log(`   ${rows.reduce((s, r) => s + r[1], 0).toFixed(2).padStart(5)}  TOTAL`);
    console.log("PROFILE " + JSON.stringify(Object.fromEntries(rows.map(([g, c]) => [g, +c.toFixed(2)]))));
  }
  console.log("final job:", JSON.stringify({ status: job.status, reason: job.reason, seconds: job.durationSeconds, bytes: job.sizeBytes }));
  console.log(`recorder peak: ${recorderPeak.cpu}% of one core (limit 200%), memory ${recorderPeak.mem}`);

  await sleep(3000);
  console.log("\n--- callback the LMS would have received ---");
  console.log(callbacks.length ? JSON.stringify(callbacks.map((c) => ({ signatureOk: c.verdict.ok, parsed: c.parsed, becomes: c.egress && { egressId: c.egress.egressId, status: c.egress.status, hasFile: Boolean(c.egress.fileResults) } })), (k, v) => typeof v === "bigint" ? v.toString() : v, 1) : "NONE");

  let storageOk = true;
  const check = (label, cond, extra = "") => { console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); if (!cond) storageOk = false; };

  if (job.status === "done") {
    let file = `/out/${objectKey}`;
    if (S3_TEST) {
      // What actually arrived in the bucket, fetched back and inspected — not what the recorder claims.
      console.log("\n=== UPLOAD ===");
      const head = nodeJson("s3-util.mjs", ["head", objectKey]);
      check("object is in the bucket", head.exists, JSON.stringify(head));
      check("its size matches what the recorder reported", head.size === job.sizeBytes, `(${head.size} vs ${job.sizeBytes})`);
      nodeJson("s3-util.mjs", ["get", objectKey, join("out", "downloaded.mp4")]);
      file = "/out/downloaded.mp4";
    }
    console.log("\n--- ffprobe ---");
    console.log(sh(["exec", "er-lk-recorder", "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size", "-of", "compact", file]));
    const vol = spawnSync("docker", ["exec", "er-lk-recorder", "ffmpeg", "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
    console.log((vol.stderr.match(/(mean_volume|max_volume).*/g) || ["no audio level"]).join("\n"));
    // A silent recording is a failed recording (the first version of this test "passed" with -91 dB).
    audioMean = Number((vol.stderr.match(/mean_volume:\s*(-?[\d.]+)/) || [])[1] ?? -Infinity);
    const dur = job.durationSeconds || 60;
    const frameTimes = SOAK ? [60, Math.round(dur / 2), Math.max(61, dur - 30)] : [8, 25, 45];
    for (const t of frameTimes) spawnSync("docker", ["exec", "er-lk-recorder", "ffmpeg", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", `/out/live-frame-${t}s.png`], { stdio: "ignore" });
    console.log("frames saved in", outDir, "at", frameTimes.join("s, ") + "s");

    if (SOAK) {
      console.log("\n=== SOAK ANALYSIS ===");
      const probe = (sel) => JSON.parse(sh(["exec", "er-lk-recorder", "ffprobe", "-v", "error", "-select_streams", sel, "-show_entries", "stream=duration,nb_frames", "-of", "json", file])).streams?.[0] ?? {};
      const v = probe("v:0"), a = probe("a:0");
      const vd = Number(v.duration), ad = Number(a.duration);
      check("picture and sound are the same length (no drift)", Math.abs(vd - ad) < 1.0, `(video ${vd.toFixed(1)} s, audio ${ad.toFixed(1)} s, difference ${(vd - ad).toFixed(2)} s)`);
      check("the recording is as long as the class ran", vd > publishSeconds * 0.9, `(${(vd / 60).toFixed(1)} min for a ${(publishSeconds / 60).toFixed(0)} min class)`);
      // The fake camera never stops moving, so a frozen picture means the recorder stalled.
      const fz = spawnSync("docker", ["exec", "er-lk-recorder", "ffmpeg", "-i", file, "-vf", "freezedetect=n=-55dB:d=2", "-an", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const freezes = (fz.stderr.match(/freeze_start/g) || []).length;
      const frozenSeconds = [...fz.stderr.matchAll(/freeze_duration:\s*([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);
      check("no frozen-picture stalls of 2 s or more", freezes === 0, `(${freezes} found)`);
      const q = Math.max(3, Math.floor(series.length / 4));
      const avg = (xs) => xs.reduce((s, x) => s + x.memMiB, 0) / xs.length;
      const early = avg(series.slice(0, q)), late = avg(series.slice(-q));
      const peak = Math.max(...series.map((s) => s.memMiB));
      check("memory does not keep climbing (last quarter vs first quarter < +35%)", late < early * 1.35, `(early ${early.toFixed(0)} MiB -> late ${late.toFixed(0)} MiB, peak ${peak.toFixed(0)} MiB of ${RECORDER_MEM})`);
      check("peak memory stays under 85% of the container's limit", peak < RECORDER_MEM * 0.85);
      const cpus = series.map((s) => s.cpu);
      console.log(`   cpu over time: min ${Math.min(...cpus)}%  avg ${(cpus.reduce((x, y) => x + y, 0) / cpus.length).toFixed(0)}%  max ${Math.max(...cpus)}%  (limit ${RECORDER_CPUS * 100}%)`);
      // How often the OS had to hold the recorder back because it wanted more CPU than its allowance.
      const stat = Object.fromEntries(sh(["exec", "er-lk-recorder", "sh", "-c", "cat /sys/fs/cgroup/cpu.stat"]).split("\n").map((l) => l.split(" ")));
      const throttledPct = (Number(stat.nr_throttled) / Number(stat.nr_periods)) * 100;
      const summary = {
        preset: process.env.VIDEO_PRESET || "veryfast", recorderCpus: RECORDER_CPUS, publisherCpus: PUBLISHER_CPUS, minutes: +(vd / 60).toFixed(1),
        throttledPct: +throttledPct.toFixed(1), avgCpuPct: +(cpus.reduce((x, y) => x + y, 0) / cpus.length).toFixed(0), maxCpuPct: Math.max(...cpus),
        freezes, frozenSeconds: +frozenSeconds.toFixed(1), frozenPct: +((frozenSeconds / vd) * 100).toFixed(2),
        peakMemMiB: Math.round(peak), avDiffSec: +(vd - ad).toFixed(2), mbPerMin: +((job.sizeBytes / 1e6) / (vd / 60)).toFixed(2),
      };
      console.log("SUMMARY " + JSON.stringify(summary));
      console.log("   series (min: cpu% / MiB):", series.filter((_, i) => i % 6 === 0).map((s) => `${Math.round(s.t / 60)}:${s.cpu.toFixed(0)}/${s.memMiB.toFixed(0)}`).join("  "));
    }

    if (S3_TEST) {
      console.log("\n=== LMS LIBRARY STAGE (real route, real schema, throwaway DB + MinIO) ===");
      const cb = callbacks.find((c) => c.parsed?.status === "completed")?.parsed;
      check("recorder's callback reached this script, signed and valid", Boolean(cb));
      nodeJson("lms-db.cjs", ["init"]);
      nodeJson("lms-db.cjs", ["seedrec", cb.jobId, objectKey, roomName]);

      // The test class is ~1 minute; the LMS keeps group classes of 40+ minutes. So replay the
      // recorder's real callback with a 45-minute duration to exercise the "keep it" path on the
      // REAL uploaded file. (Only the duration is changed.)
      const created = await replayCallback({ ...cb, durationSeconds: 2700 });
      check("LMS verifies the file in the bucket and creates the recording", created.json.outcome === "created", JSON.stringify(created));
      const shown = nodeJson("lms-db.cjs", ["show", cb.jobId]);
      check("recording row completed, linked to a Watch-shelf entry", shown.recording?.status === "completed" && shown.material?.kind === "recording", JSON.stringify(shown.recording));
      console.log("   shelf entry:", JSON.stringify(shown.material));
      check("shelf entry points at the stored file and is the right type", shown.material?.fileType === "video/mp4" && /\.mp4$/.test(shown.material?.filePath ?? ""));

      const again = await replayCallback({ ...cb, durationSeconds: 2700 });
      check("a repeated callback is harmless (no second entry)", again.json.outcome === "already", JSON.stringify(again));

      const failId = randomBytes(8).toString("hex");
      nodeJson("lms-db.cjs", ["seedrec", failId, `recordings/test/${failId}.mp4`, roomName]);
      const failed = await replayCallback({ jobId: failId, status: "failed", objectKey: `recordings/test/${failId}.mp4`, reason: "start-failed" });
      const failedRow = nodeJson("lms-db.cjs", ["show", failId]);
      check("a failed recording is recorded as failed (admins get alerted)", failed.json.outcome === "failed" && failedRow.recording?.status === "failed", JSON.stringify(failedRow.recording));

      const ghost = await replayCallback({ ...cb, jobId: randomBytes(8).toString("hex") });
      check("a callback for a class the LMS never heard of is accepted quietly (no retry storm)", ghost.status === 200 && ghost.json.outcome === "unknown", JSON.stringify(ghost));

      const badSig = await fetch(LMS_CALLBACK, { method: "POST", headers: { "content-type": "application/json", "x-recorder-timestamp": String(Date.now()), "x-recorder-signature": "sha256=" + "0".repeat(64) }, body: JSON.stringify(cb) });
      check("a forged callback is refused", badSig.status === 401, `(HTTP ${badSig.status})`);

      const shortId = randomBytes(8).toString("hex");
      nodeJson("lms-db.cjs", ["seedrec", shortId, objectKey, roomName]);
      // The LMS does not delete a short GROUP class on the spot: it HOLDS it for 48 hours (completed row,
      // NO Watch-shelf entry, file kept) so a class cut short by a dropped connection can be noticed.
      const short = await replayCallback({ ...cb, jobId: shortId });
      const shortRow = nodeJson("lms-db.cjs", ["show", shortId]);
      check("a short group class (32 s) is held, NOT shown on the shelf", short.json.outcome === "created" && shortRow.recording?.status === "completed" && shortRow.recording?.materialId === null, JSON.stringify(shortRow.recording));
      check("...and its file is kept in the bucket for the 48-hour review window", nodeJson("s3-util.mjs", ["head", objectKey]).exists);
    }
  }
  console.log(`audio mean ${audioMean} dB (must be louder than -50 dB)`);
  // In REAL_DIRECT mode the callback goes to the real LMS route, not to this script; the recorder's
  // own "callback delivered" log line (HTTP 2xx from the real route) is the evidence instead.
  const delivered = REAL_DIRECT
    ? /"callback delivered"/.test(spawnSync("docker", ["logs", "er-lk-recorder"], { encoding: "utf8" }).stdout || "")
    : callbacks.some((c) => c.verdict.ok && c.parsed);
  console.log(`callback reached the LMS and was accepted: ${delivered}`);
  ok = job.status === "done" && audioMean > -50 && delivered && storageOk;
} finally {
  server.close();
  try { goPub?.kill(); } catch {}
  try { await new RoomServiceClient(vars.LIVEKIT_URL.replace(/^wss:/, "https:"), vars.LIVEKIT_API_KEY, vars.LIVEKIT_API_SECRET).deleteRoom(roomName); } catch {}
  if (!process.env.KEEP) for (const n of ["er-lk-recorder", "er-lk-publisher"]) spawnSync("docker", ["rm", "-f", n], { stdio: "ignore" });
}
console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(ok ? 0 : 1);
