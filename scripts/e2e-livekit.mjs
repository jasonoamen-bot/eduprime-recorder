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
import { execFileSync, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
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

const secret = randomBytes(32).toString("hex");
const roomName = `recorder-test-${randomBytes(3).toString("hex")}`;
const jobId = randomBytes(8).toString("hex");
const objectKey = `recordings/test/${roomName}.mp4`;
const base = `http://${HOST}:${HOST_PORT}`;
const env = { RECORDER_URL: "http://127.0.0.1:8787", RECORDER_SHARED_SECRET: secret, RECORDING_BACKEND: "recorder", NEXT_PUBLIC_APP_URL: base, ...vars };

/* ---------- 2. host server: the class page + a callback catcher ---------- */
const callbacks = [];
const routes = { "/live/egress-template": join(fixtures, "livekit-viewer.html"), "/publisher.html": join(fixtures, "publisher.html"), "/vendor/livekit-client.umd.js": join(LMS, "node_modules/livekit-client/dist/livekit-client.umd.js") };
const server = createServer(async (req, res) => {
  const path = new URL(req.url, base).pathname;
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
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(HOST_PORT, "0.0.0.0", r));

/* ---------- 3. containers, capped ---------- */
rmSync(outDir, { recursive: true, force: true }); mkdirSync(outDir, { recursive: true });
for (const n of ["er-lk-recorder", "er-lk-publisher"]) spawnSync("docker", ["rm", "-f", n], { stdio: "ignore" });
const common = ["--add-host", `${HOST}:host-gateway`, "-v", `${fixtures}:/app/fixtures:ro`, "--shm-size=512m"];
let recorderPeak = { cpu: 0, mem: "" };
let audioMean = -Infinity;
let ok = false;
try {
  console.log("starting recorder (capped: 2 CPUs, 1.5 GB)…");
  sh(["run", "-d", "--name", "er-lk-recorder", "--cpus=2", "--memory=1500m", "--memory-swap=1500m", "-p", "8787:8787", ...common,
    "-v", `${outDir}:/out`, "-e", `RECORDER_SHARED_SECRET=${secret}`, "-e", "LOCAL_OUTPUT_DIR=/out",
    "-e", `ALLOWED_PAGE_ORIGINS=${base}`, "-e", `ALLOWED_CALLBACK_ORIGINS=${base}`, IMAGE]);
  for (let i = 0; i < 120; i++) { try { if ((await fetch("http://127.0.0.1:8787/healthz")).ok) break; } catch {} await sleep(500); }

  const at = new AccessToken(vars.LIVEKIT_API_KEY, vars.LIVEKIT_API_SECRET, { identity: "test-tutor", name: "Test Tutor", ttl: "1h", metadata: JSON.stringify({ role: "tutor" }) });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  const tutorToken = await at.toJwt();
  const pubUrl = `${base}/publisher.html?url=${encodeURIComponent(vars.LIVEKIT_URL)}&token=${encodeURIComponent(tutorToken)}`;
  console.log(`starting fake tutor in room ${roomName} for ${publishSeconds}s (capped: 1 CPU, 0.8 GB)…`);
  sh(["run", "-d", "--name", "er-lk-publisher", "--cpus=1", "--memory=800m", "--memory-swap=800m", ...common, "--entrypoint", "/usr/bin/tini", IMAGE, "--", "node", "fixtures/publisher-run.mjs", pubUrl, String(publishSeconds + 12)]);
  await sleep(10_000);

  // The LMS's own code starts the recording — token minting, signing, URLs and all.
  const started = await lms.startRecorderJob({ roomName, objectKey, jobId }, env);
  console.log("LMS startRecorderJob ->", JSON.stringify(started));
  if (!started.ok) throw new Error("the LMS could not start the recorder: " + JSON.stringify(started));

  const view = async () => (await (await fetch(`http://127.0.0.1:8787/v1/jobs/${started.jobId}`, { headers: (() => { const t = String(Date.now()); return { "x-recorder-timestamp": t, "x-recorder-signature": lms.signRecorderBody(secret, t, "") }; })() })).json()).job;
  let job;
  for (let i = 0; i < publishSeconds + 240; i++) {
    await sleep(2000);
    job = await view();
    if (i % 5 === 0) console.log("  recorder:", job.status);
    if (job.status === "recording") {
      const [cpu, mem] = sh(["stats", "er-lk-recorder", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}"]).split("|");
      if (parseFloat(cpu) > recorderPeak.cpu) recorderPeak = { cpu: parseFloat(cpu), mem };
    }
    if (job.status === "done" || job.status === "failed") break;
  }
  console.log("final job:", JSON.stringify({ status: job.status, reason: job.reason, seconds: job.durationSeconds, bytes: job.sizeBytes }));
  console.log(`recorder peak: ${recorderPeak.cpu}% of one core (limit 200%), memory ${recorderPeak.mem}`);

  await sleep(3000);
  console.log("\n--- callback the LMS would have received ---");
  console.log(callbacks.length ? JSON.stringify(callbacks.map((c) => ({ signatureOk: c.verdict.ok, parsed: c.parsed, becomes: c.egress && { egressId: c.egress.egressId, status: c.egress.status, hasFile: Boolean(c.egress.fileResults) } })), (k, v) => typeof v === "bigint" ? v.toString() : v, 1) : "NONE");

  if (job.status === "done") {
    const file = `/out/${objectKey}`;
    console.log("\n--- ffprobe ---");
    console.log(sh(["exec", "er-lk-recorder", "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size", "-of", "compact", file]));
    const vol = spawnSync("docker", ["exec", "er-lk-recorder", "ffmpeg", "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
    console.log((vol.stderr.match(/(mean_volume|max_volume).*/g) || ["no audio level"]).join("\n"));
    // A silent recording is a failed recording (the first version of this test "passed" with -91 dB).
    audioMean = Number((vol.stderr.match(/mean_volume:\s*(-?[\d.]+)/) || [])[1] ?? -Infinity);
    for (const t of [8, 25]) spawnSync("docker", ["exec", "er-lk-recorder", "ffmpeg", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", `/out/live-frame-${t}s.png`], { stdio: "ignore" });
    console.log("frames saved in", outDir);
  }
  console.log(`audio mean ${audioMean} dB (must be louder than -50 dB)`);
  ok = job.status === "done" && audioMean > -50 && callbacks.some((c) => c.verdict.ok && c.parsed);
} finally {
  server.close();
  try { await new RoomServiceClient(vars.LIVEKIT_URL.replace(/^wss:/, "https:"), vars.LIVEKIT_API_KEY, vars.LIVEKIT_API_SECRET).deleteRoom(roomName); } catch {}
  if (!process.env.KEEP) for (const n of ["er-lk-recorder", "er-lk-publisher"]) spawnSync("docker", ["rm", "-f", n], { stdio: "ignore" });
}
console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");
process.exit(ok ? 0 : 1);
