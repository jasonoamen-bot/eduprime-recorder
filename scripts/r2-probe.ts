// Read-only: can the R2 credentials found locally list the production recordings bucket (easyway-lms)? Prints counts only.
import { readFileSync } from "node:fs";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
const env: Record<string, string> = {};
for (const line of readFileSync("C:/Users/HP/Documents/EASYWAY LMS/prototype/.env.local", "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
}
const client = new S3Client({ region: "auto", endpoint: env.BACKUP_S3_ENDPOINT, credentials: { accessKeyId: env.BACKUP_S3_ACCESS_KEY!, secretAccessKey: env.BACKUP_S3_SECRET_KEY! }, forcePathStyle: true });
for (const bucket of ["easyway-lms", env.BACKUP_OBJECTS_BUCKET!]) {
  try {
    const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "recordings/", MaxKeys: 5 }));
    console.log(`${bucket}: OK, ${r.KeyCount} key(s) under recordings/ (first: ${r.Contents?.[0]?.Key ?? "-"})`);
  } catch (e) { console.log(`${bucket}: ${(e as Error).name} (${String((e as Error).message).slice(0, 80)})`); }
}
