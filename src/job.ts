import { z } from "zod";
import type { Config } from "./config.js";

/**
 * What the LMS sends to start a recording.
 *
 * The LMS mints the LiveKit token itself and hands it over, so the LiveKit API
 * secret never leaves the LMS. The token should be hidden + subscribe-only.
 */
export const jobRequestSchema = z.object({
  jobId: z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  roomName: z.string().min(1).max(200),
  /** The page to open: our /live/egress-template (or the test fixture in dev). */
  pageUrl: z.string().url(),
  livekitUrl: z.string().url(),
  token: z.string().min(20),
  /** Where the finished file goes in the bucket — same key the LMS already expects. */
  objectKey: z
    .string()
    .min(3)
    .max(500)
    .regex(/^[A-Za-z0-9/_.-]+$/)
    .refine((key) => !key.includes("..") && !key.startsWith("/"), "bad object key"),
  callbackUrl: z.string().url().optional(),
  maxMinutes: z.number().int().min(1).max(600).optional(),
});

export type JobRequest = z.infer<typeof jobRequestSchema>;

export type JobStatus = "queued" | "starting" | "recording" | "finalising" | "uploading" | "done" | "failed";

export type JobRecord = {
  request: JobRequest;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  reason?: string;
  durationSeconds?: number;
  sizeBytes?: number;
  localPath?: string;
};

/** Public view — never echoes the token back. */
export function publicView(job: JobRecord) {
  const { token: _token, ...request } = job.request;
  return { ...job, request };
}

/**
 * A headless browser that opens arbitrary URLs is a gift to an attacker, so the
 * recorder only opens pages and calls back to origins on an explicit allow-list.
 */
export function checkOrigins(request: JobRequest, config: Pick<Config, "ALLOWED_PAGE_ORIGINS" | "ALLOWED_CALLBACK_ORIGINS">): string | null {
  if (!config.ALLOWED_PAGE_ORIGINS.includes(new URL(request.pageUrl).origin)) {
    return `page origin not allowed: ${new URL(request.pageUrl).origin}`;
  }
  if (request.callbackUrl && !config.ALLOWED_CALLBACK_ORIGINS.includes(new URL(request.callbackUrl).origin)) {
    return `callback origin not allowed: ${new URL(request.callbackUrl).origin}`;
  }
  return null;
}

/** The URL the browser actually opens: page + the room credentials. */
export function pageUrlWithCredentials(request: JobRequest): string {
  const url = new URL(request.pageUrl);
  url.searchParams.set("url", request.livekitUrl);
  url.searchParams.set("token", request.token);
  url.searchParams.set("bot", "1");
  return url.toString();
}
