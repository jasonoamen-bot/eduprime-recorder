import { bestFleet, capacityOf } from "./plan.js";
import { staticDemand, type Demand } from "./demand.js";
import type { Action, FleetConfig, ServerState } from "./types.js";

export type Decision = {
  actions: Action[];
  notes: string[];
  /** Classes the fleet must be able to record by the end of the lead time, and the longer "keep" horizon. */
  need: { create: number; keep: number };
};

const MIN = 60_000;

/**
 * One pass of the fleet manager: look at the clock, the timetable and the servers that exist, and say what to
 * create and delete. PURE: no network, no time of its own, so every rule below is tested exactly.
 *
 * RULES, in the order they matter:
 *  0. Only the office's explicit POWER OFF (`stopAllBefore`) may cut a recording. PAUSE (`drain`) switches off every
 *     server that is not recording, immediately, but never one that is.
 *  1. NEVER delete a server that is recording (or finishing / uploading), or one we could not ask.
 *  2. Create what the timetable needs `leadMinutes` ahead, so a server is ready before the first tutor joins.
 *  3. Keep an idle server if it is needed again within `keepMinutes` (hourly billing makes delete-then-recreate pointless).
 *  4. Sweep the broken: stuck while starting, running but never answering, or simply far too old (a forgotten server).
 *  5. Never exceed `maxServers`, and never create more than `maxCreatesPerTick` in one pass: a bug here should cost
 *     a few dollars, not a bill.
 */
export function reconcile(input: { now: Date; servers: ServerState[]; config: FleetConfig; demand?: Demand }): Decision {
  const { now, servers, config } = input;
  const demand = input.demand ?? staticDemand(config);
  const typeById = new Map(config.types.map((t) => [t.id, t]));
  const classesOf = (typeId: string) => typeById.get(typeId)?.classes ?? 0;
  const ageMinutes = (s: ServerState) => (now.getTime() - s.createdAt.getTime()) / MIN;

  const withSpare = (peak: number) => (peak > 0 ? peak + Math.max(0, config.spareClasses ?? 0) : 0);
  // PAUSED (drain): the office wants nothing running. Nothing is needed, so nothing is created and every idle
  // server below falls out as surplus.
  const drain = config.drain === true;
  const needCreate = drain ? 0 : withSpare(demand.peak(now, new Date(now.getTime() + config.leadMinutes * MIN)));
  const needKeep = drain ? 0 : Math.max(needCreate, withSpare(demand.peak(now, new Date(now.getTime() + config.keepMinutes * MIN))));

  const actions: Action[] = [];
  const notes: string[] = [];
  const doomed = new Set<string>();
  const remove = (s: ServerState, reason: string) => {
    doomed.add(s.id);
    actions.push({ kind: "delete", id: s.id, label: s.label, reason });
  };

  // 0. POWER OFF: the office pressed the big button. Everything created before that moment goes, recording or not.
  if (config.stopAllBefore) {
    for (const s of servers) {
      if (s.createdAt.getTime() <= config.stopAllBefore.getTime()) {
        remove(s, s.activeJobs ? `powered off by the office (cut ${s.activeJobs} recording${s.activeJobs === 1 ? "" : "s"} in progress)` : "powered off by the office");
      }
    }
  }
  // PAUSED: a server that is still starting cannot be recording anything, so it goes too. (One that is running but
  // not answering is left alone, as always: we cannot tell whether it is recording.)
  if (drain) {
    for (const s of servers) {
      if (!doomed.has(s.id) && s.status !== "running") remove(s, "paused: this server is not needed");
    }
  }

  // 4. The broken and the forgotten (these go even if "needed": a replacement is created below if the timetable wants one).
  for (const s of servers) {
    if (s.status !== "running" && ageMinutes(s) > config.stuckMinutes) remove(s, `stuck: not running after ${Math.round(ageMinutes(s))} min`);
    else if (s.status === "running" && s.activeJobs === null && ageMinutes(s) > config.unhealthyMinutes) remove(s, `unhealthy: recorder not answering after ${Math.round(ageMinutes(s))} min`);
    else if (s.activeJobs === 0 && ageMinutes(s) > config.maxAgeHours * 60) remove(s, `forgotten: idle and ${Math.round(ageMinutes(s) / 60)} h old`);
  }

  const alive = servers.filter((s) => !doomed.has(s.id));
  let capacity = alive.reduce((sum, s) => sum + classesOf(s.typeId), 0);

  // 2. Create what is missing.
  let created = 0;
  if (capacity < needCreate) {
    const wanted = bestFleet(needCreate - capacity, config.types);
    const queue = Object.entries(wanted).flatMap(([typeId, n]) => Array.from({ length: n }, () => typeId));
    const room = Math.max(0, config.maxServers - alive.length);
    const allowed = Math.min(queue.length, room, config.maxCreatesPerTick);
    for (const typeId of queue.slice(0, allowed)) {
      actions.push({ kind: "create", typeId, reason: `timetable needs ${needCreate} classes within ${config.leadMinutes} min, have capacity for ${capacity}` });
      capacity += classesOf(typeId);
      created += 1;
    }
    if (allowed < queue.length) {
      notes.push(`WARNING: wanted ${queue.length} more server(s) but limited to ${allowed} (max ${config.maxServers} servers, ${config.maxCreatesPerTick} per pass); overflow classes fall back to LiveKit recording`);
    }
  }

  // 3. Delete what is not needed soon, idle ones only, dearest first. Not in a pass that is also creating (no churn).
  if (created === 0) {
    const idle = alive
      .filter((s) => s.status === "running" && s.activeJobs === 0)
      .sort((a, b) => (typeById.get(b.typeId)?.usdPerHour ?? 0) - (typeById.get(a.typeId)?.usdPerHour ?? 0) || a.createdAt.getTime() - b.createdAt.getTime());
    for (const s of idle) {
      if (capacity - classesOf(s.typeId) >= needKeep) {
        remove(s, drain ? "paused: idle server switched off" : needKeep === 0 ? "no classes soon" : `surplus: ${capacity} capacity for ${needKeep} classes`);
        capacity -= classesOf(s.typeId);
      }
    }
  }

  for (const s of alive) {
    if (s.activeJobs === null && s.status === "running" && !doomed.has(s.id)) notes.push(`${s.label}: recorder not answering yet (${Math.round(ageMinutes(s))} min old), left alone`);
  }
  return { actions, notes, need: { create: needCreate, keep: needKeep } };
}

export { capacityOf };
