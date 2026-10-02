// What is LiveKit recording / hosting right now?   npx tsx scripts/livekit-egress-now.ts
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
const host = env.LIVEKIT_URL!.replace(/^wss:/, "https:");
const rooms = new sdk.RoomServiceClient(host, env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!);
const egress = new sdk.EgressClient(host, env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!);
const t = (s: bigint | number) => new Date(Number(s) / (Number(s) > 1e15 ? 1e6 : 1) * (Number(s) < 1e11 ? 1000 : 1)).toISOString().slice(11, 19);
for (const r of await rooms.listRooms()) {
  const people = await rooms.listParticipants(r.name);
  console.log(`ROOM ${r.name}  participants=${people.length}  started ${t(r.creationTime)}`);
}
for (const e of await egress.listEgress({ active: true })) {
  console.log(`EGRESS ${e.egressId}  room=${e.roomName}  status=${e.status}  started ${t(e.startedAt ?? 0)}  kind=${e.request?.case}`);
}
const recent = await egress.listEgress({});
console.log(`(all egress records returned: ${recent.length}; most recent 6 by start)`);
for (const e of recent.sort((a: { startedAt?: bigint }, b: { startedAt?: bigint }) => Number((b.startedAt ?? 0n) - (a.startedAt ?? 0n))).slice(0, 6)) {
  console.log(`  ${e.egressId} room=${e.roomName} status=${e.status} started ${t(e.startedAt ?? 0)} kind=${e.request?.case}`);
}
