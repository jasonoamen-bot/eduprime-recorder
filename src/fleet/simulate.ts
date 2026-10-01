import { staticDemand, type Demand } from "./demand.js";
import { reconcile } from "./reconcile.js";
import type { FleetConfig, ServerState } from "./types.js";

export type SimulationResult = {
  days: number;
  /** Cost of the servers, billed the way Linode bills: every started hour of a server's life. */
  usd: number;
  serverHours: number;
  peakServers: number;
  /** Class-minutes the fleet could NOT cover (those classes fall back to LiveKit recording). Should be 0. */
  uncoveredClassMinutes: number;
  /** Servers still alive at the end: must be 0 after a quiet night. */
  leftover: number;
  creates: number;
  deletes: number;
  byDay: { date: string; usd: number; creates: number }[];
};

/**
 * Run the fleet manager against a fake provider for N days, ticking every `stepMinutes`, to see what a real
 * month would cost and to check the rules behave (servers appear before classes, vanish after, never pile up).
 * Servers take `bootMinutes` to become ready; a server is "busy" while classes occupy its capacity.
 */
export function simulate(opts: { config: FleetConfig; from: Date; days: number; stepMinutes?: number; bootMinutes?: number; demand?: Demand }): SimulationResult {
  const { config, from, days } = opts;
  const step = (opts.stepMinutes ?? 5) * 60_000;
  const boot = (opts.bootMinutes ?? 6) * 60_000;
  const demand = opts.demand ?? staticDemand(config);
  const typeById = new Map(config.types.map((t) => [t.id, t]));
  const end = from.getTime() + days * 24 * 3_600_000;

  type Sim = { id: string; typeId: string; createdAt: Date };
  let servers: Sim[] = [];
  let next = 1;
  let usd = 0, serverHours = 0, peak = 0, uncovered = 0, creates = 0, deletes = 0;
  const byDay = new Map<string, { usd: number; creates: number }>();
  const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
  const bump = (t: number, cost: number, create: number) => {
    const d = byDay.get(dayOf(t)) ?? { usd: 0, creates: 0 };
    d.usd += cost; d.creates += create; byDay.set(dayOf(t), d);
  };
  const bill = (s: Sim, at: number) => {
    const hours = Math.max(1, Math.ceil((at - s.createdAt.getTime()) / 3_600_000));
    const cost = hours * (typeById.get(s.typeId)?.usdPerHour ?? 0);
    usd += cost; serverHours += hours; bump(at, cost, 0);
  };

  for (let t = from.getTime(); t < end; t += step) {
    const now = new Date(t);
    const running = servers.filter((s) => t - s.createdAt.getTime() >= boot).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    // Classes fill servers in order: a server is busy while it holds any class.
    let toPlace = demand.at(now);
    const busy = new Map<string, number>();
    for (const s of running) {
      const cap = typeById.get(s.typeId)?.classes ?? 0;
      const take = Math.min(cap, toPlace);
      busy.set(s.id, take);
      toPlace -= take;
    }
    uncovered += toPlace > 0 ? toPlace * (step / 60_000) : 0;

    const state: ServerState[] = servers.map((s) => ({
      id: s.id, label: s.id, typeId: s.typeId, createdAt: s.createdAt, ip: "10.0.0.1",
      status: t - s.createdAt.getTime() >= boot ? "running" : "provisioning",
      activeJobs: t - s.createdAt.getTime() >= boot ? busy.get(s.id) ?? 0 : null,
    }));
    const decision = reconcile({ now, servers: state, config, demand });
    for (const action of decision.actions) {
      if (action.kind === "create") { servers.push({ id: `sim-${next++}`, typeId: action.typeId, createdAt: now }); creates += 1; bump(t, 0, 1); }
      else { const s = servers.find((x) => x.id === action.id); if (s) { bill(s, t); deletes += 1; } servers = servers.filter((x) => x.id !== action.id); }
    }
    peak = Math.max(peak, servers.length);
  }
  const leftover = servers.length;
  for (const s of servers) bill(s, end); // count what a still-running server has cost so far

  return {
    days, usd: usd, serverHours, peakServers: peak, uncoveredClassMinutes: Math.round(uncovered), leftover, creates, deletes,
    byDay: [...byDay.entries()].sort().map(([date, v]) => ({ date, usd: +v.usd.toFixed(3), creates: v.creates })),
  };
}
