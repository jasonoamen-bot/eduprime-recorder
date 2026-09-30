import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalStorage, createS3Client } from "../src/storage.js";

const config = { S3_REGION: "auto", S3_ENDPOINT: "https://s3.eu-central-003.backblazeb2.com", S3_ACCESS_KEY: "a", S3_SECRET: "b" };

describe("S3 client for S3-compatible providers (Backblaze B2)", () => {
  it("does not add checksum headers B2 rejects (WHEN_REQUIRED, not the SDK default)", async () => {
    const client = createS3Client(config);
    expect(await client.config.requestChecksumCalculation()).toBe("WHEN_REQUIRED");
    expect(await client.config.responseChecksumValidation()).toBe("WHEN_REQUIRED");
  });

  it("uses path-style addressing whenever a custom endpoint is set", async () => {
    expect(await createS3Client(config).config.forcePathStyle).toBe(true);
    expect(await createS3Client({ ...config, S3_ENDPOINT: undefined }).config.forcePathStyle).toBe(false);
  });
});

describe("local storage (dev/test)", () => {
  it("copies the file to the same key the LMS expects, creating folders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rec-"));
    const src = join(dir, "in.mp4");
    await writeFile(src, "video-bytes");
    await new LocalStorage(join(dir, "bucket")).put(src, "recordings/easyway/a1/2026-10-01/room.mp4");
    expect(await readFile(join(dir, "bucket", "recordings/easyway/a1/2026-10-01/room.mp4"), "utf8")).toBe("video-bytes");
  });
});
