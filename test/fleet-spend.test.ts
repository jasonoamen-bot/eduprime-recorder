import { describe, expect, it } from "vitest";
import { addSpend, parseSpend, type Spend } from "../src/fleet/spend.js";

const at = (iso: string) => new Date(iso);

describe("the running cost estimate", () => {
  it("the first pass starts the file at zero", () => {
    const s = addSpend(null, at("2026-10-05T08:00:00Z"), 2, 0.2);
    expect(s).toMatchObject({ month: "2026-10", day: "2026-10-05", monthUsd: 0, dayUsd: 0, serverHoursMonth: 0 });
  });

  it("adds price x time since the last pass", () => {
    const first = addSpend(null, at("2026-10-05T08:00:00Z"), 0, 0);
    const next = addSpend(first, at("2026-10-05T08:05:00Z"), 2, 0.216); // two 4-vCPU servers for 5 minutes
    expect(next.dayUsd).toBeCloseTo(0.018, 4);
    expect(next.serverHoursMonth).toBeCloseTo(2 * (5 / 60), 3);
  });

  it("a long silence counts as at most 15 minutes: an estimate, not an invoice", () => {
    const first = addSpend(null, at("2026-10-05T08:00:00Z"), 0, 0);
    const next = addSpend(first, at("2026-10-05T14:00:00Z"), 1, 0.108);
    expect(next.dayUsd).toBeCloseTo(0.108 * 0.25, 4);
  });

  it("the day resets at school midnight (UTC+1), the month at the school month", () => {
    const prev: Spend = { version: 1, month: "2026-10", monthUsd: 10, day: "2026-10-05", dayUsd: 2, serverHoursMonth: 40, updatedAt: "2026-10-05T22:55:00.000Z" };
    const next = addSpend(prev, at("2026-10-05T23:00:00Z"), 1, 0.108); // 00:00 school time on the 6th
    expect(next.day).toBe("2026-10-06");
    expect(next.dayUsd).toBeCloseTo(0.108 * (5 / 60), 4); // only the new day's share
    expect(next.monthUsd).toBeCloseTo(10 + 0.108 * (5 / 60), 3);
    const newMonth = addSpend({ ...prev, month: "2026-09" }, at("2026-10-05T23:00:00Z"), 1, 0.108);
    expect(newMonth.monthUsd).toBeCloseTo(0.108 * (5 / 60), 4);
  });

  it("reads its own file, and refuses garbage", () => {
    expect(parseSpend({ version: 1, month: "2026-10", monthUsd: 1.5, day: "2026-10-05", dayUsd: 0.5, serverHoursMonth: 3, updatedAt: "2026-10-05T08:00:00Z" })).toMatchObject({ monthUsd: 1.5 });
    expect(parseSpend(null)).toBeNull();
    expect(parseSpend({ version: 1, month: "x" })).toBeNull();
    expect(parseSpend({ version: 1, month: "2026-10", day: "2026-10-05", monthUsd: -5, updatedAt: "2026-10-05T08:00:00Z" })?.monthUsd).toBe(0);
  });
});
