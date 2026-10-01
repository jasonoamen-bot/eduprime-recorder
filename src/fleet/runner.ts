import { randomBytes } from "node:crypto";
import type { Demand } from "./demand.js";
import type { ComputeProvider } from "./provider.js";
import { reconcile, type Decision } from "./reconcile.js";
import type { Action, FleetConfig, ServerState } from "./types.js";

/** Asks the recorder on a server how many recordings it has in progress. null = no answer. */
export type Probe = (ip: string) => Promise<number | null>;

export type Executed = { action: Action; ok: boolean; error?: string };

export type TickReport = {
  at: Date;
  applied: boolean;
  servers: ServerState[];
  decision: Decision;
  executed: Executed[];
};

const label = (now: Date) => `rec-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${randomBytes(2).toString("hex")}`;

/**
 * One pass: list our servers, ask each recorder what it is doing, decide, and (only with `apply`) act.
 * Without `apply` nothing is created or deleted: that is the default everywhere, so looking is always safe.
 * One failed action never stops the others (a stuck delete must not prevent a needed create).
 */
export async function tick(opts: {
  provider: ComputeProvider;
  probe: Probe;
  config: FleetConfig;
  apply: boolean;
  /** Built fresh for each new server (it carries a one-hour download link). */
  userData: () => Promise<string> | string;
  /** How many classes to expect (the LMS forecast, or the built-in timetable). Defaults to the built-in one. */
  demand?: Demand;
  now?: Date;
}): Promise<TickReport> {
  const now = opts.now ?? new Date();
  const listed = await opts.provider.list();
  const servers: ServerState[] = await Promise.all(
    listed.map(async (s) => ({ ...s, activeJobs: s.status === "running" && s.ip ? await opts.probe(s.ip).catch(() => null) : null })),
  );
  const decision = reconcile({ now, servers, config: opts.config, demand: opts.demand });

  const executed: Executed[] = [];
  if (opts.apply) {
    for (const action of decision.actions) {
      try {
        if (action.kind === "create") await opts.provider.create({ typeId: action.typeId, label: label(now), userData: await opts.userData() });
        else await opts.provider.remove(action.id);
        executed.push({ action, ok: true });
      } catch (error) {
        executed.push({ action, ok: false, error: String(error instanceof Error ? error.message : error) });
      }
    }
  }
  return { at: now, applied: opts.apply, servers, decision, executed };
}
