// Make LiveKit send webhooks for a throwaway room (a fake tutor joins for ~12 s), so the production logs show
// whether the LMS accepts LiveKit's signature.   npx tsx scripts/webhook-probe.ts
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LMS = "C:/Users/HP/Documents/easyway-lms-worktrees/own-recorder/prototype";
const env: Record<string, string> = {};
for (const line of readFileSync("C:/Users/HP/Documents/EASYWAY LMS/prototype/.env.local", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}
const { AccessToken } = createRequire(join(LMS, "package.json"))("livekit-server-sdk");
const room = `webhook-probe-${Date.now().toString(36)}`;
const token = new AccessToken(env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!, { identity: "probe", ttl: "10m" });
token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
console.log(`joining ${room} at ${new Date().toISOString()}`);
const child = spawn(resolve("tools/loadpub/loadpub.exe"), ["--url", env.LIVEKIT_URL!, "--token", await token.toJwt(), "--video", "media/video.ivf", "--audio", "media/audio.ogg", "--seconds", "12"], { cwd: resolve("tools/loadpub"), stdio: "ignore" });
await new Promise<void>((done) => child.on("exit", () => done()));
console.log(`left at ${new Date().toISOString()}`);
