// Print the scheduler's running cost estimate (the file the admin page reads).   npx tsx scripts/show-spend.ts
import { readFileSync } from "node:fs";
import { readSpend } from "../src/fleet/spend.js";

const env: Record<string, string> = {};
for (const line of readFileSync(".env", "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}
const spend = await readSpend({ bucket: env.S3_BUCKET!, region: env.S3_REGION!, endpoint: env.S3_ENDPOINT!, accessKey: env.S3_ACCESS_KEY!, secret: env.S3_SECRET! });
console.log(spend ? JSON.stringify(spend) : "no spend figure yet");
