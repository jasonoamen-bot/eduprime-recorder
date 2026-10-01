import type { Probe } from "./runner.js";

/** Ask a recorder's open health endpoint how many recordings it has going. null if it does not answer. */
export function httpProbe(port = 8787, http: typeof fetch = fetch): Probe {
  return async (ip) => {
    try {
      const response = await http(`http://${ip}:${port}/healthz`, { signal: AbortSignal.timeout(4_000) });
      if (!response.ok) return null;
      const body = (await response.json()) as { ok?: boolean; active?: number };
      return body.ok && typeof body.active === "number" ? body.active : null;
    } catch {
      return null;
    }
  };
}
