import { describe, expect, it } from "vitest";
import { sign, verify } from "../src/auth.js";

const secret = "s".repeat(40);
const body = JSON.stringify({ jobId: "job-12345678" });

describe("request signing", () => {
  it("accepts a correctly signed, fresh request", () => {
    const timestamp = String(Date.now());
    const result = verify({ secret, timestamp, signature: sign(secret, timestamp, body), body });
    expect(result.ok).toBe(true);
  });

  it("rejects a body that was changed after signing", () => {
    const timestamp = String(Date.now());
    const result = verify({ secret, timestamp, signature: sign(secret, timestamp, body), body: body + " " });
    expect(result).toEqual({ ok: false, reason: "signature mismatch" });
  });

  it("rejects the wrong secret", () => {
    const timestamp = String(Date.now());
    const result = verify({ secret, timestamp, signature: sign("x".repeat(40), timestamp, body), body });
    expect(result.ok).toBe(false);
  });

  it("rejects a replayed request older than five minutes", () => {
    const old = String(Date.now() - 6 * 60_000);
    const result = verify({ secret, timestamp: old, signature: sign(secret, old, body), body });
    expect(result).toEqual({ ok: false, reason: "stale request" });
  });

  it("rejects missing headers and garbage timestamps", () => {
    expect(verify({ secret, timestamp: undefined, signature: undefined, body }).ok).toBe(false);
    expect(verify({ secret, timestamp: "abc", signature: "sha256=00", body }).ok).toBe(false);
  });

  it("does not throw on a signature of the wrong length", () => {
    const timestamp = String(Date.now());
    expect(verify({ secret, timestamp, signature: "sha256=short", body }).ok).toBe(false);
  });
});
