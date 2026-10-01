import { describe, expect, it } from "vitest";
import { isSealed, openToken, sealToken } from "../src/seal.js";

const secret = "s".repeat(40);
const jobId = "s0a000001-abcdef0123456789";
const token = "eyJhbGciOiJIUzI1NiJ9.eyJ2aWRlbyI6e319.signature-part-here";

describe("sealing the room token", () => {
  it("round-trips, and the sealed form does not contain the token", () => {
    const sealed = sealToken(secret, jobId, token);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain("eyJhbGci");
    expect(openToken(secret, jobId, sealed)).toBe(token);
  });
  it("is different every time (fresh iv)", () => {
    expect(sealToken(secret, jobId, token)).not.toBe(sealToken(secret, jobId, token));
  });
  it("refuses another job, another secret, or any tampering", () => {
    const sealed = sealToken(secret, jobId, token);
    expect(openToken(secret, "s0a000002-abcdef0123456789", sealed)).toBeNull();
    expect(openToken("t".repeat(40), jobId, sealed)).toBeNull();
    const parts = sealed.split(".");
    parts[2] = Buffer.from("tampered").toString("base64url");
    expect(openToken(secret, jobId, parts.join("."))).toBeNull();
    expect(openToken(secret, jobId, "enc1.nonsense")).toBeNull();
  });
  it("matches the LMS byte for byte (fixed vector shared with the LMS test)", () => {
    const sealed = sealToken(secret, jobId, token, Buffer.alloc(12, 7));
    expect(sealed).toBe("enc1.BwcHBwcHBwcHBwcH.i-jzZQ-xq-PrOZ7iyFKhrqxNEeWcBck0Q4X5f8z7LQKT_7FByAUzEnTKOcbMWU9uiPOBRWkdVfAE.olqgGIO2dAKCza4VeVDhRw");
  });
});
