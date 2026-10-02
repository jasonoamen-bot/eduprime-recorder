// Where does the LMS tell LiveKit to store recordings? (bucket / endpoint / region only; never keys)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const LMS = "C:/Users/HP/Documents/easyway-lms-worktrees/own-recorder/prototype";
const env: Record<string, string> = {};
for (const line of readFileSync("C:/Users/HP/Documents/EASYWAY LMS/prototype/.env.local", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}
const sdk = createRequire(join(LMS, "package.json"))("livekit-server-sdk");
const egress = new sdk.EgressClient(env.LIVEKIT_URL!.replace(/^wss:/, "https:"), env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!);
const walk = (o: unknown, path = ""): void => {
  if (!o || typeof o !== "object") return;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (/bucket|endpoint|region|filepath|forcePathStyle/i.test(k) && typeof v !== "object") console.log(`  ${path}${k} = ${String(v)}`);
    else if (typeof v === "object") walk(v, `${path}${k}.`);
  }
};
for (const e of await egress.listEgress({ active: true })) {
  console.log(`egress ${e.egressId} (${e.roomName})`);
  walk(e.request);
  for (const f of e.fileResults ?? []) console.log(`  result: ${f.location ?? ""}`);
}
console.log("local .env.local RECORDING_S3 bucket/endpoint for comparison:", env.RECORDING_S3_BUCKET, "|", env.RECORDING_S3_ENDPOINT);
