import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Keeps the LiveKit room token private on its way from the LMS to a recorder server.
 *
 * Servers are reached by plain http://<ip>:8080 (no domain, no certificate), so anyone on the network path could
 * read the request. The request is already signed, so it cannot be changed, but the room token inside it is a
 * credential: this seals it with AES-256-GCM under a key derived from the shared secret, so only the LMS and the
 * recorder can read it. The job id is bound in, so a sealed token cannot be replayed against a different job.
 *
 * Format: enc1.<iv>.<ciphertext>.<tag>, each base64url. The LMS has the identical code (lib/recorder.ts); a fixed
 * test vector in both repositories keeps the two honest.
 */

export const SEALED_PREFIX = "enc1.";

const key = (secret: string): Buffer => Buffer.from(hkdfSync("sha256", secret, "eduprime-recorder", "job-token-v1", 32));

export const isSealed = (token: string): boolean => token.startsWith(SEALED_PREFIX);

export function sealToken(secret: string, jobId: string, token: string, iv: Buffer = randomBytes(12)): string {
  const cipher = createCipheriv("aes-256-gcm", key(secret), iv);
  cipher.setAAD(Buffer.from(jobId));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [SEALED_PREFIX.slice(0, -1), iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

/** The plain token, or null if the sealed one was tampered with, made for another job, or sealed with another secret. */
export function openToken(secret: string, jobId: string, sealed: string): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "enc1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(parts[1]!, "base64url"));
    decipher.setAAD(Buffer.from(jobId));
    decipher.setAuthTag(Buffer.from(parts[3]!, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[2]!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
