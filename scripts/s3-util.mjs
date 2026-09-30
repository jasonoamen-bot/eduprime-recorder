// Test helper for the LOCAL MinIO used in storage tests. Never points at a real bucket.
//
//   node scripts/s3-util.mjs mkbucket
//   node scripts/s3-util.mjs head <key>            -> {"exists":true,"size":123} | {"exists":false}
//   node scripts/s3-util.mjs get <key> <localPath>
import { writeFile } from "node:fs/promises";
import { GetObjectCommand, HeadObjectCommand, CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

const ENDPOINT = process.env.TEST_S3_ENDPOINT || "http://127.0.0.1:9000";
if (!/^http:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal)(:\d+)?$/.test(ENDPOINT)) {
  console.error("REFUSING: not a local endpoint");
  process.exit(2);
}
const BUCKET = "recorder-test";
const client = new S3Client({
  region: "us-east-1", endpoint: ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId: "recordertest", secretAccessKey: "recordertest-secret-123" },
});

const [cmd, key, dest] = process.argv.slice(2);
try {
  if (cmd === "mkbucket") {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch((e) => { if (!/BucketAlready/.test(e.name)) throw e; });
    console.log(JSON.stringify({ bucket: BUCKET, ok: true }));
  } else if (cmd === "head") {
    try {
      const r = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      console.log(JSON.stringify({ exists: true, size: r.ContentLength, type: r.ContentType }));
    } catch (e) {
      if (e.$metadata?.httpStatusCode === 404 || e.name === "NotFound") console.log(JSON.stringify({ exists: false }));
      else throw e;
    }
  } else if (cmd === "get") {
    const r = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    await writeFile(dest, Buffer.from(await r.Body.transformToByteArray()));
    console.log(JSON.stringify({ saved: dest }));
  } else {
    console.error("unknown command");
    process.exit(1);
  }
} catch (e) {
  console.error(String(e).slice(0, 400));
  process.exit(1);
}
