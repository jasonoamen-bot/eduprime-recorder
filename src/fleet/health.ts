import type { ServerHealth } from "./directory.js";
import type { Probe } from "./runner.js";

/** Ask a recorder's open health endpoint what it is doing: recordings going and how many it accepts. null if it does not answer. */
export async function httpHealth(ip: string, port = 8787, http: typeof fetch = fetch): Promise<ServerHealth | null> {
  try {
    const response = await http(`http://${ip}:${port}/healthz`, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: boolean; active?: number; capacity?: number };
    return body.ok && typeof body.active === "number" && typeof body.capacity === "number" ? { active: body.active, capacity: body.capacity } : null;
  } catch {
    return null;
  }
}

/** Just the number of recordings in progress. null if it does not answer. */
export function httpProbe(port = 8787, http: typeof fetch = fetch): Probe {
  return async (ip) => (await httpHealth(ip, port, http))?.active ?? null;
}
