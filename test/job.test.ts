import { describe, expect, it } from "vitest";
import { checkOrigins, jobRequestSchema, pageUrlWithCredentials, publicView, type JobRecord } from "../src/job.js";

const base = {
  jobId: "job-12345678",
  roomName: "a1-morning-berlin",
  pageUrl: "https://easyway-lms.vercel.app/live/egress-template",
  livekitUrl: "wss://example.livekit.cloud",
  token: "t".repeat(40),
  objectKey: "recordings/easyway/a1/2026-10-01/a1-morning.mp4",
  callbackUrl: "https://easyway-lms.vercel.app/api/recorder/callback",
};
const allow = {
  ALLOWED_PAGE_ORIGINS: ["https://easyway-lms.vercel.app"],
  ALLOWED_CALLBACK_ORIGINS: ["https://easyway-lms.vercel.app"],
};

describe("job request", () => {
  it("accepts a well-formed request", () => {
    expect(jobRequestSchema.safeParse(base).success).toBe(true);
  });

  it("refuses object keys that could escape the bucket path", () => {
    expect(jobRequestSchema.safeParse({ ...base, objectKey: "../secrets.mp4" }).success).toBe(false);
    expect(jobRequestSchema.safeParse({ ...base, objectKey: "/abs/path.mp4" }).success).toBe(false);
    expect(jobRequestSchema.safeParse({ ...base, objectKey: "a b.mp4" }).success).toBe(false);
  });

  it("refuses job ids that are unsafe as filenames", () => {
    expect(jobRequestSchema.safeParse({ ...base, jobId: "../../etc/passwd" }).success).toBe(false);
  });
});

describe("origin allow-list", () => {
  it("lets an allowed page and callback through", () => {
    expect(checkOrigins(jobRequestSchema.parse(base), allow)).toBeNull();
  });

  it("blocks a page on any other origin", () => {
    const request = jobRequestSchema.parse({ ...base, pageUrl: "https://evil.example/live/egress-template" });
    expect(checkOrigins(request, allow)).toMatch(/page origin not allowed/);
  });

  it("blocks a callback to any other origin", () => {
    const request = jobRequestSchema.parse({ ...base, callbackUrl: "https://evil.example/hook" });
    expect(checkOrigins(request, allow)).toMatch(/callback origin not allowed/);
  });

  it("is not fooled by a lookalike host", () => {
    const request = jobRequestSchema.parse({ ...base, pageUrl: "https://easyway-lms.vercel.app.evil.example/x" });
    expect(checkOrigins(request, allow)).not.toBeNull();
  });
});

describe("credentials", () => {
  it("adds url, token and bot flag to the page URL", () => {
    const url = new URL(pageUrlWithCredentials(jobRequestSchema.parse(base)));
    expect(url.searchParams.get("url")).toBe(base.livekitUrl);
    expect(url.searchParams.get("token")).toBe(base.token);
    expect(url.searchParams.get("bot")).toBe("1");
  });

  it("never echoes the token in the public view", () => {
    const job: JobRecord = { request: jobRequestSchema.parse(base), status: "recording", createdAt: "now" };
    expect(JSON.stringify(publicView(job))).not.toContain(base.token);
  });
});
