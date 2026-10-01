import type { FleetConfig, ServerType, SlotRule } from "./types.js";

/**
 * The school's class hours, mirrored from the LMS (prototype/src/lib/class-times.ts):
 *   Morning 10:00-13:00, Afternoon 13:00-15:00, Evening 17:00-19:00 (Mon-Fri), Weekend Sat 10:00-14:00.
 * `classes` is the most that run at once in the slot: the morning is the school's peak.
 * These are the numbers to adjust as the school grows (or to replace with a day-by-day forecast from the LMS).
 */
export const DEFAULT_SLOTS: SlotRule[] = [
  { name: "morning", days: [1, 2, 3, 4, 5], start: "10:00", end: "13:00", classes: 5 },
  { name: "afternoon", days: [1, 2, 3, 4, 5], start: "13:00", end: "15:00", classes: 2 },
  { name: "evening", days: [1, 2, 3, 4, 5], start: "17:00", end: "19:00", classes: 2 },
  { name: "weekend", days: [6], start: "10:00", end: "14:00", classes: 3 },
];

/**
 * Akamai/Linode dedicated plans (ids and prices read from the Linode API on 2026-10-01).
 *
 * `classes` is how many simultaneous classes a size records cleanly. Measured on a 4-vCPU dedicated server
 * with a SIMPLE stand-in class page: 3 classes clean, 4 occasionally stalled, 5+ stalled. The real class page
 * does more work, so this assumes ~1.6 vCPU per class (floor(vcpu / 1.6)). Raise it only after a pilot on the
 * real page shows headroom.
 */
export const DEFAULT_TYPES: ServerType[] = [
  { id: "g6-dedicated-2", label: "Dedicated 4 GB", vcpu: 2, usdPerHour: 0.054, classes: 1 },
  { id: "g6-dedicated-4", label: "Dedicated 8 GB", vcpu: 4, usdPerHour: 0.108, classes: 2 },
  { id: "g6-dedicated-8", label: "Dedicated 16 GB", vcpu: 8, usdPerHour: 0.216, classes: 5 },
  { id: "g6-dedicated-16", label: "Dedicated 32 GB", vcpu: 16, usdPerHour: 0.432, classes: 10 },
];

export const DEFAULT_CONFIG: FleetConfig = {
  types: DEFAULT_TYPES,
  slots: DEFAULT_SLOTS,
  skipDates: [],
  leadMinutes: 20,
  keepMinutes: 60,
  spareClasses: 0,
  maxServers: 4,
  maxCreatesPerTick: 3,
  maxAgeHours: 8,
  stuckMinutes: 25,
  unhealthyMinutes: 30,
};

/** School time is Africa/Lagos: UTC+1 all year (Nigeria does not use daylight saving). */
export const SCHOOL_UTC_OFFSET_MINUTES = 60;

export function schoolClock(at: Date): { day: number; minutes: number; dateKey: string } {
  const shifted = new Date(at.getTime() + SCHOOL_UTC_OFFSET_MINUTES * 60_000);
  return { day: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(), dateKey: shifted.toISOString().slice(0, 10) };
}

export function parseClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`bad time "${value}" (expected HH:MM)`);
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  if (minutes < 0 || minutes > 24 * 60) throw new Error(`time out of range: "${value}"`);
  return minutes;
}

/** Classes running at this instant: the busiest slot active right now (0 on a closed day or between slots). */
export function classesAt(at: Date, slots: SlotRule[] = DEFAULT_SLOTS, skipDates: ReadonlySet<string> = new Set()): number {
  const { day, minutes, dateKey } = schoolClock(at);
  if (skipDates.has(dateKey)) return 0;
  let most = 0;
  for (const slot of slots) {
    if (!slot.days.includes(day)) continue;
    if (minutes >= parseClock(slot.start) && minutes < parseClock(slot.end)) most = Math.max(most, slot.classes);
  }
  return most;
}

/** The most classes at once at any moment in [from, to] (sampled every few minutes; slots are on 5-minute boundaries). */
export function peakClasses(from: Date, to: Date, slots: SlotRule[], skipDates: ReadonlySet<string> = new Set(), stepMinutes = 5): number {
  let peak = 0;
  for (let t = from.getTime(); t <= to.getTime(); t += stepMinutes * 60_000) peak = Math.max(peak, classesAt(new Date(t), slots, skipDates));
  return Math.max(peak, classesAt(to, slots, skipDates));
}
