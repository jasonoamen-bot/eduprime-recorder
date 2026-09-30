import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { sleep } from "./proc.js";

export interface Storage {
  /** Store the file under `key`. Throws if it could not be stored. */
  put(localPath: string, key: string): Promise<void>;
}

/** Dev/test: "upload" by copying into a folder. */
export class LocalStorage implements Storage {
  constructor(private readonly dir: string) {}
  async put(localPath: string, key: string): Promise<void> {
    const target = join(this.dir, key);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(localPath, target);
  }
}

/** R2 / S3 / B2 / MinIO — anything S3-compatible. Multipart, so a 1 GB class is fine. */
export class S3Storage implements Storage {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    config: Pick<Config, "S3_REGION" | "S3_ENDPOINT" | "S3_ACCESS_KEY" | "S3_SECRET">,
    private readonly log: Logger,
  ) {
    this.client = new S3Client({
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      forcePathStyle: Boolean(config.S3_ENDPOINT),
      credentials: { accessKeyId: config.S3_ACCESS_KEY!, secretAccessKey: config.S3_SECRET! },
    });
  }

  async put(localPath: string, key: string): Promise<void> {
    const size = (await stat(localPath)).size;
    // A dropped connection during upload is normal on real networks — retry with
    // backoff rather than lose a finished lesson.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const upload = new Upload({
          client: this.client,
          params: { Bucket: this.bucket, Key: key, Body: createReadStream(localPath), ContentType: "video/mp4" },
          queueSize: 3,
          partSize: 8 * 1024 * 1024,
        });
        await upload.done();
        this.log.info("uploaded", { key, sizeBytes: size, attempt });
        return;
      } catch (error) {
        lastError = error;
        this.log.warn("upload attempt failed", { key, attempt, error: String(error) });
        await sleep(Math.min(30_000, 1_000 * 2 ** attempt));
      }
    }
    throw new Error(`upload failed after 5 attempts: ${String(lastError)}`);
  }
}

export function createStorage(config: Config, log: Logger): Storage {
  if (config.S3_BUCKET && config.S3_ACCESS_KEY && config.S3_SECRET) {
    return new S3Storage(config.S3_BUCKET, config, log);
  }
  return new LocalStorage(config.LOCAL_OUTPUT_DIR!);
}
