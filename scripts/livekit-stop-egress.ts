// End LiveKit's own recording for the classes that are running, so the LMS restarts them on OUR recorder servers.
// The part recorded so far is finalised normally (LiveKit sends its "egress ended" webhook), nothing is lost.
//   npx tsx scripts/livekit-stop-egress.ts
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
const active = await egress.listEgress({ active: true });
console.log(`${active.length} active LiveKit recording(s)`);
for (const e of active) {
  if (!/^ew-/.test(e.roomName)) { console.log(`  skip ${e.roomName} (not a class room)`); continue; }
  await egress.stopEgress(e.egressId);
  console.log(`  stopped ${e.egressId} for ${e.roomName} at ${new Date().toISOString().slice(11, 19)}Z`);
}
