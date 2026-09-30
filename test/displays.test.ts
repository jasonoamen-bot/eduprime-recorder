import { beforeEach, describe, expect, it } from "vitest";
import { allocateDisplay, releaseDisplay, resetDisplays } from "../src/displays.js";

describe("display numbers", () => {
  beforeEach(resetDisplays);

  it("hands out distinct numbers to concurrent recordings", () => {
    const a = allocateDisplay();
    const b = allocateDisplay();
    expect(a).not.toBe(b);
  });

  it("does NOT hand a just-released number straight back (the failed-start retry collision)", () => {
    const first = allocateDisplay();
    releaseDisplay(first);
    const retry = allocateDisplay();
    expect(retry).not.toBe(first);
  });

  it("eventually reuses numbers once released, so it never runs out", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const n = allocateDisplay();
      seen.add(n);
      releaseDisplay(n);
    }
    expect(seen.size).toBeLessThanOrEqual(99);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(101);
    expect(Math.max(...seen)).toBeLessThanOrEqual(199);
  });

  it("throws only when every number is genuinely in use", () => {
    for (let i = 0; i < 99; i++) allocateDisplay();
    expect(() => allocateDisplay()).toThrow(/no free display/);
  });
});
