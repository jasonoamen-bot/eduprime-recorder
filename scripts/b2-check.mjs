// Real Backblaze B2 check for the recorder's storage path, using the recorder's OWN S3Storage class.
//
//   node scripts/b2-check.mjs            (needs `npm run build` first, and S3_* in ./.env)
//
// What it does, in order, and leaves NOTHING behind:
//   1. lists the test prefix (proves the key works and can LIST)
//   2. uploads a 12 MB random file through S3Storage  -> forces a real MULTIPART upload (8 MB parts)
//   3. HEADs it (size must match) and reads the first bytes back (proves READ)
//   4. deletes EVERY version of it (proves DELETE; B2 otherwise keeps hidden copies that still cost money)
//   5. lists again: must be empty
//
// Safety: refuses any bucket other than the recordings bucket, and only ever touches
// `recordings/_recorder-test/`. Never prints the key.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { createLogger } from "../dist/log.js";
import { S3Storage, createS3Client } from "../dist/storage.js";

const env = {};
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
for (const k of ["S3_BUCKET", "S3_REGION", "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET"]) if (!env[k]) throw new Error(`${k} missing in .env`);
if (env.S3_BUCKET !== "easyway-recordings") throw new Error("REFUSING: this check only runs against the recordings bucket");

const PREFIX = "recordings/_recorder-test/";
const key = `${PREFIX}b2-check-${randomBytes(4).toString("hex")}.mp4`;
const config = { S3_REGION: env.S3_REGION, S3_ENDPOINT: env.S3_ENDPOINT, S3_ACCESS_KEY: env.S3_ACCESS_KEY, S3_SECRET: env.S3_SECRET };
const client = createS3Client(config);
const Bucket = env.S3_BUCKET;
let failed = 0;
const check = (label, ok, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); if (!ok) failed++; };

try {
  const before = await client.send(new ListObjectsV2Command({ Bucket, Prefix: PREFIX, MaxKeys: 5 }));
  check("the key authenticates and can LIST the test prefix", true, `(${before.KeyCount ?? 0} objects there already)`);
} catch (e) {
  console.log("  FAIL  could not authenticate / list:", e.name, "-", String(e.message).slice(0, 160));
  console.log("\nThis usually means a character in the key was misread (O vs 0, 1 vs l). Put the key in .env yourself and re-run.");
  process.exit(1);
}

const dir = await mkdtemp(join(tmpdir(), "b2check-"));
const file = join(dir, "test.mp4");
await writeFile(file, randomBytes(12 * 1024 * 1024)); // incompressible, > 8 MB part size => multipart
const size = (await stat(file)).size;

try {
  const started = Date.now();
  await new S3Storage(Bucket, config, createLogger({ svc: "b2-check" })).put(file, key);
  check("uploaded through the recorder's own S3Storage (multipart, 12 MB)", true, `(${((Date.now() - started) / 1000).toFixed(1)} s)`);

  const head = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
  check("size in the bucket matches what was uploaded", head.ContentLength === size, `(${head.ContentLength} vs ${size})`);
  check("content type stored as video/mp4", head.ContentType === "video/mp4", `(${head.ContentType})`);

  const part = await client.send(new GetObjectCommand({ Bucket, Key: key, Range: "bytes=0-1023" }));
  const bytes = Buffer.from(await part.Body.transformToByteArray());
  check("can READ it back (first KB)", bytes.length === 1024);
} catch (e) {
  console.log("  FAIL  upload/read step:", e.name, "-", String(e.message).slice(0, 200));
  failed++;
} finally {
  // Remove EVERY version + hide marker of the test object(s): a plain delete on B2 only hides the file.
  try {
    const versions = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix: key }));
    const all = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].filter((v) => v.Key === key);
    for (const v of all) await client.send(new DeleteObjectCommand({ Bucket, Key: key, VersionId: v.VersionId }));
    const after = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix: key }));
    const left = (after.Versions?.length ?? 0) + (after.DeleteMarkers?.length ?? 0);
    check("deleted every version of the test file (nothing left behind, nothing billed)", left === 0, `(${all.length} version(s) removed, ${left} left)`);
  } catch (e) {
    console.log("  FAIL  delete step:", e.name, "-", String(e.message).slice(0, 200));
    console.log(`  !! Clean up by hand in Backblaze: ${key}`);
    failed++;
  }
}
console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(failed ? 1 : 0);
