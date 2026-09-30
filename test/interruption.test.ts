import { describe, expect, it } from "vitest";
import { isInterruption } from "../src/session.js";

describe("interruption vs a real end", () => {
  it("a crash, stall or length cap is an interruption (the class is still going)", () => {
    for (const reason of ["xvfb-exited", "ffmpeg-exited", "page-crashed", "page-failed", "max-duration", "start-failed"]) {
      expect(isInterruption(reason), reason).toBe(true);
    }
  });

  it("the room ending or an explicit stop is a real end, never an interruption", () => {
    for (const reason of ["room-ended", "stopped-by-lms", "stopped-before-start"]) {
      expect(isInterruption(reason), reason).toBe(false);
    }
  });

  it("an unknown or missing reason is not reported as an interruption", () => {
    expect(isInterruption(undefined)).toBe(false);
    expect(isInterruption("something-new")).toBe(false);
  });
});
