/** Shared shapes for the on-demand recorder fleet. */

/** One kind of rentable server, and how many classes we trust it to record at once. */
export type ServerType = {
  id: string; // the provider's id, e.g. "g6-dedicated-4"
  label: string;
  vcpu: number;
  usdPerHour: number;
  /** Simultaneous classes this size records without stalls (measured, then padded for the real class page). */
  classes: number;
};

/** A repeating block of class time. Times are SCHOOL time (Africa/Lagos, UTC+1, no daylight saving). */
export type SlotRule = {
  name: string;
  /** 0 = Sunday ... 6 = Saturday, in school time. */
  days: number[];
  start: string; // "10:00"
  end: string; // "13:00"
  /** How many classes run at once in this slot (the busiest it gets). */
  classes: number;
};

export type ServerStatus = "provisioning" | "running" | "other";

/** A server as the provider reports it. */
export type Server = {
  id: string;
  label: string;
  typeId: string;
  status: ServerStatus;
  ip: string | null;
  createdAt: Date;
};

/** A server plus what the recorder on it says it is doing right now. */
export type ServerState = Server & {
  /** Recordings in progress (incl. finishing/uploading). null = could not ask (not up yet, or unhealthy). */
  activeJobs: number | null;
};

export type Action =
  | { kind: "create"; typeId: string; reason: string }
  | { kind: "delete"; id: string; label: string; reason: string };

export type FleetConfig = {
  types: ServerType[];
  slots: SlotRule[];
  /** Dates ("2026-12-25", school time) with no classes. */
  skipDates: string[];
  /** Start a server this long before it is needed: boot + setup + download takes ~5-8 minutes. */
  leadMinutes: number;
  /** Keep an idle server this long if it is needed again soon: hourly billing makes a quick delete-and-recreate pointless. */
  keepMinutes: number;
  /** Hard ceiling on servers at any moment: the only thing standing between a bug and a large bill. */
  maxServers: number;
  /** Most creations in a single pass. */
  maxCreatesPerTick: number;
  /** An idle server older than this is deleted even if "needed" (forgotten-server sweep). */
  maxAgeHours: number;
  /** A server not running after this long is stuck: delete it. */
  stuckMinutes: number;
  /** A running server whose recorder never answers after this long is broken: delete it. */
  unhealthyMinutes: number;
};
