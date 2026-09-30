// Proof-of-life: start the container, send a signed job for the fake class page,
// wait for it to finish, then measure the file that came out.
//
//   node scripts/e2e-local.mjs [seconds]
//
// Needs Docker and the image `eduprime-recorder:dev` (docker build -t eduprime-recorder:dev .).
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const seconds = Number(process.argv[2] || 25);
const secret = randomBytes(32).toString("hex");
const name = "eduprime-recorder-e2e";
const outDir = resolve("out");
const port = 8787;

const sh = (args, opts = {}) => execFileSync("docker", args, { encoding: "utf8", ...opts }).trim();
const sign = (timestamp, body) => "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
async function call(method, path, payload) {
  const body = payload ? JSON.stringify(payload) : "";
  const timestamp = String(Date.now());
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-recorder-timestamp": timestamp, "x-recorder-signature": sign(timestamp, body) },
    body: method === "POST" ? body : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });

console.log("starting container…");
sh([
  "run", "-d", "--name", name, "-p", `${port}:8787`, "--shm-size=1g",
  "-v", `${outDir}:/out`,
  "-e", `RECORDER_SHARED_SECRET=${secret}`,
  "-e", "LOCAL_OUTPUT_DIR=/out",
  "-e", "SERVE_FIXTURES=1",
  "-e", "ALLOWED_PAGE_ORIGINS=http://127.0.0.1:8080",
  "eduprime-recorder:dev",
]);

try {
  let healthy = false;
  for (let i = 0; i < 120 && !healthy; i++) {
    try { healthy = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch {}
    if (!healthy) await sleep(500);
  }
  if (!healthy) throw new Error("recorder never became healthy:\n" + sh(["logs", name]));

  const jobId = "e2e-" + randomBytes(4).toString("hex");
  const objectKey = `recordings/test/${jobId}.mp4`;
  const started = await call("POST", "/v1/jobs", {
    jobId,
    roomName: "e2e-room",
    pageUrl: `http://127.0.0.1:8080/test-class.html?len=${seconds}`,
    livekitUrl: "wss://unused.example",
    token: "x".repeat(40),
    objectKey,
  });
  console.log("submit:", started.status, started.json.job?.status);
  if (started.status !== 202) throw new Error("job was not accepted: " + JSON.stringify(started.json));

  let job;
  let peakCpu = 0;
  let peakMem = "";
  for (let i = 0; i < seconds * 2 + 120; i++) {
    await sleep(1000);
    job = (await call("GET", `/v1/jobs/${jobId}`)).json.job;
    if (i % 5 === 0) console.log(`  ${job.status}`);
    if (job.status === "recording" && process.env.PROFILE && !globalThis.__profiled) {
      // Which process is eating the CPU? Sample a few seconds into the recording.
      await sleep(6000);
      globalThis.__profiled = true;
      console.log(sh(["exec", name, "sh", "-c", "top -b -n 2 -d 3 -w 200 | awk '/^top/{n++} n==2' | head -14"]));
    }
    if (job.status === "recording") {
      // Measure while it is actually recording — after it ends the container is idle.
      const [cpu, mem] = sh(["stats", name, "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}"]).split("|");
      if (parseFloat(cpu) > peakCpu) { peakCpu = parseFloat(cpu); peakMem = mem; }
    }
    if (job.status === "done" || job.status === "failed") break;
  }
  console.log(`peak while recording: ${peakCpu}% of one core (8 logical cores here), memory ${peakMem}`);
  console.log("final:", JSON.stringify({ status: job.status, reason: job.reason, seconds: job.durationSeconds, bytes: job.sizeBytes }));
  if (job.status !== "done") {
    const why = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    const lines = (why.stdout + why.stderr).split("\n").filter((l) => /session failed|job failed|timed out|error/i.test(l) && !/dbus/.test(l));
    console.log("WHY:\n" + lines.slice(0, 6).join("\n"));
    process.exitCode = 1;
    throw new Error("recording did not complete");
  }

  const file = `/out/${objectKey}`;
  console.log("\n--- ffprobe ---");
  console.log(sh(["exec", name, "ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate:format=duration,size", "-of", "compact", file]));
  console.log("\n--- audio level (a silent recording would show -inf / very low) ---");
  const vol = spawnSync("docker", ["exec", name, "ffmpeg", "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
  console.log((vol.stderr.match(/(mean_volume|max_volume).*/g) || ["no volume info"]).join("\n"));
  console.log("\n--- first / middle frames ---");
  for (const t of [3, Math.floor(seconds / 2)]) {
    spawnSync("docker", ["exec", name, "ffmpeg", "-y", "-ss", String(t), "-i", file, "-frames:v", "1", `/out/frame-${t}s.png`], { stdio: "ignore" });
  }
  console.log("frames saved in", join(outDir));
} finally {
  if (!process.env.KEEP) spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
}
