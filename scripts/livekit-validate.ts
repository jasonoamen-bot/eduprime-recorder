// Prove a LiveKit URL + key + secret work together (lists rooms; changes nothing). Reads the LMS's local .env.local.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const LMS = "C:/Users/HP/Documents/easyway-lms-worktrees/own-recorder/prototype";
const env: Record<string, string> = {};
for (const line of readFileSync("C:/Users/HP/Documents/EASYWAY LMS/prototype/.env.local", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}
const { RoomServiceClient } = createRequire(join(LMS, "package.json"))("livekit-server-sdk");
const rooms = await new RoomServiceClient(env.LIVEKIT_URL!.replace(/^wss:/, "https:"), env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!).listRooms();
console.log(`VALID: ${env.LIVEKIT_URL} + key ${env.LIVEKIT_API_KEY} work together (${rooms.length} room(s) open right now)`);
