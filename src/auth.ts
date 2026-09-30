import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The LMS and the recorder trust each other through one shared secret and an
 * HMAC over `timestamp.body`. Two properties matter:
 *
 *  - Only the LMS can start a recording (nobody else can make this machine open
 *    a browser).
 *  - A captured request cannot be replayed later: the timestamp is signed and
 *    stale ones are refused.
 */
export const SIGNATURE_HEADER = "x-recorder-signature";
export const TIMESTAMP_HEADER = "x-recorder-timestamp";
const MAX_SKEW_MS = 5 * 60 * 1000;

export function sign(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verify(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  now?: number;
}): VerifyResult {
  const { secret, timestamp, signature, body } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing signature headers" };

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs((input.now ?? Date.now()) - sentAt) > MAX_SKEW_MS) return { ok: false, reason: "stale request" };

  const expected = Buffer.from(sign(secret, timestamp, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}
