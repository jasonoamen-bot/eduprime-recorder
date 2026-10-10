import { DEFAULT_CONFIG } from "../src/fleet/slots.js";
import type { FleetConfig } from "../src/fleet/types.js";

/**
 * The timing the fleet tests were written around: a server starts 20 minutes ahead and an idle one is kept for an hour.
 * Those tests are about MECHANICS (what is created, what is never deleted), not about the numbers, so they keep this
 * explicit config instead of drifting every time the real defaults are tuned. The real defaults have their own tests
 * in fleet-strict.test.ts.
 */
export const LEGACY_CONFIG: FleetConfig = { ...DEFAULT_CONFIG, leadMinutes: 20, keepMinutes: 60, spareClasses: 0, warmClasses: 0 };
