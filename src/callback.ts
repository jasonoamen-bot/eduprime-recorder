import { SIGNATURE_HEADER, TIMESTAMP_HEADER, sign } from "./auth.js";
import type { Logger } from "./log.js";
import { sleep } from "./proc.js";

export type CallbackPayload = {
  jobId: string;
  roomName: string;
  status: "completed" | "failed";
  objectKey: string;
  durationSeconds?: number;
  sizeBytes?: number;
  reason?: string;
};

/**
 * Tell the LMS the file is ready (or that it failed). Signed with the same
 * secret as inbound requests so the LMS can trust it. Retried with backoff: the
 * LMS may be mid-deploy for a minute, and the recording must not be orphaned.
 */
export async function sendCallback(url: string, secret: string, payload: CallbackPayload, log: Logger): Promise<boolean> {
  const body = JSON.stringify(payload);
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const timestamp = String(Date.now());
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TIMESTAMP_HEADER]: timestamp,
          [SIGNATURE_HEADER]: sign(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) {
        log.info("callback delivered", { status: response.status, callbackStatus: payload.status });
        return true;
      }
      // 4xx means the LMS understood and refused: retrying will not help.
      if (response.status >= 400 && response.status < 500) {
        log.error("callback refused", { status: response.status });
        return false;
      }
      log.warn("callback server error", { status: response.status, attempt });
    } catch (error) {
      log.warn("callback failed", { attempt, error: String(error) });
    }
    await sleep(Math.min(60_000, 2_000 * 2 ** attempt));
  }
  return false;
}
