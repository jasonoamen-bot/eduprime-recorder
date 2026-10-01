import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

/**
 * A lock file so two overlapping passes cannot both decide "create a server" and double the fleet.
 * A lock older than `staleMinutes` (a pass that crashed) is ignored. Returns a release function, or null if held.
 */
export function acquireLock(path: string, staleMinutes = 10, now = Date.now()): (() => void) | null {
  if (existsSync(path)) {
    const startedAt = Number(readFileSync(path, "utf8").trim());
    if (Number.isFinite(startedAt) && now - startedAt < staleMinutes * 60_000) return null;
  }
  writeFileSync(path, String(now), "utf8");
  return () => rmSync(path, { force: true });
}
