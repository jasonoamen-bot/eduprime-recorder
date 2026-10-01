import type { ServerType } from "./types.js";

/**
 * The cheapest set of servers that can record `classes` at once.
 *
 * A small knapsack: for each class count up to the target, the cheapest way to cover it, ties broken by
 * fewer servers (fewer machines to babysit). Sizes mix freely, e.g. 7 classes = one 5-class server plus
 * one 2-class server if that is cheaper than a 10-class one. Returns counts by type id.
 */
export function bestFleet(classes: number, types: ServerType[]): Record<string, number> {
  if (classes <= 0) return {};
  const usable = types.filter((t) => t.classes > 0 && t.usdPerHour > 0);
  if (usable.length === 0) throw new Error("no usable server types configured");

  // best[c] = cheapest way to reach capacity >= c
  const best: { cost: number; servers: number; pick: number }[] = [{ cost: 0, servers: 0, pick: -1 }];
  for (let c = 1; c <= classes; c++) {
    let chosen = { cost: Infinity, servers: Infinity, pick: -1 };
    usable.forEach((type, index) => {
      const previous = best[Math.max(0, c - type.classes)]!;
      const cost = previous.cost + type.usdPerHour;
      const servers = previous.servers + 1;
      if (cost < chosen.cost - 1e-9 || (Math.abs(cost - chosen.cost) < 1e-9 && servers < chosen.servers)) chosen = { cost, servers, pick: index };
    });
    best.push(chosen);
  }

  const counts: Record<string, number> = {};
  let c = classes;
  while (c > 0) {
    const type = usable[best[c]!.pick]!;
    counts[type.id] = (counts[type.id] ?? 0) + 1;
    c = Math.max(0, c - type.classes);
  }
  return counts;
}

export function capacityOf(counts: Record<string, number>, types: ServerType[]): number {
  return Object.entries(counts).reduce((sum, [id, n]) => sum + n * (types.find((t) => t.id === id)?.classes ?? 0), 0);
}

export function costPerHour(counts: Record<string, number>, types: ServerType[]): number {
  return Object.entries(counts).reduce((sum, [id, n]) => sum + n * (types.find((t) => t.id === id)?.usdPerHour ?? 0), 0);
}
