import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createS3Client } from "../storage.js";

/**
 * The recorder's source, published to the private bucket so every new fleet server can fetch and build it.
 *
 * Kept inside the `recordings/` prefix, because the Backblaze key made for the recorder is limited to it.
 * New servers get a ONE-HOUR signed link, so the bucket stays private and a leaked link soon dies.
 */
export const RELEASE_KEY = "recordings/_recorder-release/source-latest.tgz";

export type S3Settings = { bucket: string; region: string; endpoint: string; accessKey: string; secret: string };

const client = (s: S3Settings) => createS3Client({ S3_REGION: s.region, S3_ENDPOINT: s.endpoint, S3_ACCESS_KEY: s.accessKey, S3_SECRET: s.secret });

/** Pack the recorder source (no secrets, no node_modules, no test media) into a tarball. */
export function packSource(repoDir: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "recorder-src-"));
  const file = join(dir, "source.tgz");
  try {
    execFileSync("tar", [
      "-czf", file,
      "--exclude=node_modules", "--exclude=.git", "--exclude=dist", "--exclude=.stage", "--exclude=out", "--exclude=spool",
      "--exclude=tools", "--exclude=deploy", "--exclude=.env", "--exclude=.env.*", "--exclude=*.log", "--exclude=test",
      "--exclude=fixtures/vendor", "--exclude=fleet.config.json", "-C", repoDir, ".",
    ]);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function publishSource(repoDir: string, s3: S3Settings): Promise<{ bytes: number }> {
  const body = packSource(repoDir);
  await client(s3).send(new PutObjectCommand({ Bucket: s3.bucket, Key: RELEASE_KEY, Body: body, ContentType: "application/gzip" }));
  return { bytes: body.length };
}

/** A fresh one-hour download link, for a server about to be created. */
export async function sourceDownloadUrl(s3: S3Settings, expiresInSeconds = 3600): Promise<string> {
  return getSignedUrl(client(s3), new GetObjectCommand({ Bucket: s3.bucket, Key: RELEASE_KEY }), { expiresIn: expiresInSeconds });
}
