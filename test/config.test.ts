import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const good = { RECORDER_SHARED_SECRET: "s".repeat(40), LOCAL_OUTPUT_DIR: "/tmp/out" };

describe("config", () => {
  it("loads with a secret and somewhere to put files", () => {
    const config = loadConfig(good);
    expect(config.MAX_CONCURRENT_JOBS).toBe(2);
    expect(config.VIDEO_HEIGHT).toBe(720);
  });

  it("refuses a short secret", () => {
    expect(() => loadConfig({ ...good, RECORDER_SHARED_SECRET: "short" })).toThrow(/at least 32/);
  });

  it("refuses to start with nowhere to store recordings", () => {
    expect(() => loadConfig({ RECORDER_SHARED_SECRET: "s".repeat(40) })).toThrow(/S3_BUCKET/);
  });

  it("treats blank env values as unset and parses origin lists", () => {
    const config = loadConfig({ ...good, S3_BUCKET: "", ALLOWED_PAGE_ORIGINS: "https://a.example/, https://b.example" });
    expect(config.ALLOWED_PAGE_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
  });
});
