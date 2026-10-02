// Upload a 12 MB file (multipart) to the production recordings bucket on R2 with the recorder's own upload code, read it back, delete it.
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { S3Storage, createS3Client } from "../src/storage.js";
import { createLogger } from "../src/log.js";
const env: Record<string, string> = {};
for (const line of readFileSync("C:/Users/HP/Documents/EASYWAY LMS/prototype/.env.local", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}
const cfg = { S3_REGION: "auto", S3_ENDPOINT: env.BACKUP_S3_ENDPOINT!, S3_ACCESS_KEY: env.BACKUP_S3_ACCESS_KEY!, S3_SECRET: env.BACKUP_S3_SECRET_KEY! };
const bucket = "easyway-lms";
const key = `recordings/_recorder-test/r2-check-${randomBytes(3).toString("hex")}.mp4`;
const local = "out/r2-check.bin";
writeFileSync(local, randomBytes(12 * 1024 * 1024));
const client = createS3Client(cfg);
let ok = true;
const say = (pass: boolean, what: string) => { ok &&= pass; console.log(`${pass ? "PASS" : "FAIL"}  ${what}`); };
try {
  await new S3Storage(bucket, cfg, createLogger({ svc: "r2-check" })).put(local, key);
  say(true, "multipart upload (12 MB) through the recorder's own S3Storage");
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  say(head.ContentLength === 12 * 1024 * 1024, `size in the bucket matches (${head.ContentLength})`);
  say(head.ContentType === "video/mp4", `content type video/mp4 (${head.ContentType})`);
  const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: "bytes=0-1023" }));
  say((await got.Body!.transformToByteArray()).length === 1024, "range read works (what video playback needs)");
} catch (e) { say(false, `error: ${(e as Error).name}: ${String((e as Error).message).slice(0, 120)}`); }
finally { try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); console.log("cleaned up"); } catch { console.log("cleanup failed"); } }
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
