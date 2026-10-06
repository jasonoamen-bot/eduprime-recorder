#!/usr/bin/env node
/**
 * The fleet manager's command line.
 *
 *   npm run fleet -- plan [--days 28]        what a month would cost, and the servers' schedule (no network)
 *   npm run fleet -- forecast [--hours 48]   what the LMS says is coming, and the servers that would follow it
 *   npm run fleet -- status                  the servers that exist right now, and what each is doing
 *   npm run fleet -- tick [--apply]          one pass: what should be created/deleted (dry run unless --apply)
 *   npm run fleet -- create --type ID [--apply]   make one server by hand (for testing)
 *   npm run fleet -- teardown [--apply]      delete EVERY server this fleet made (emergency / end of a test)
 *   npm run fleet -- control [--pause "why"|--resume] [--skip DATE|--unskip DATE] [--boost N --hours H|--no-boost]   steer the fleet like the admin page does (no flags: show)
 *   npm run fleet -- heartbeat [--log]       when each scheduler last ran, and (with --log) what it did
 *   npm run fleet -- release                 publish the recorder source that new servers build from
 *   npm run fleet -- scheduler [--role standby --region nl-ams] [--do status|delete] [--apply] [--paused]   the always-on machine that runs `tick` every minute
 *
 * Everything that spends or removes money is a dry run unless `--apply` is given.
 * Settings live in the recorder's .env (LINODE_TOKEN, S3_*), `fleet.config.json` (optional overrides) and
 * the recorder's own settings file for the servers (FLEET_RECORDER_ENV_FILE, default deploy/prod.env).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUserData, withMaxJobs } from "./bootstrap.js";
import { ForecastDemand, fetchForecast, loadDemand, type DemandMode } from "./demand.js";
import { hostname } from "node:os";
import { NO_CONTROL, applyControl, readControl, writeControl } from "./control.js";
import { buildDirectory, publishDirectory, type ServerHealth } from "./directory.js";
import { nextBeat, readBeat, shouldStandBy, writeBeat, type Role } from "./beat.js";
import { addSpend, readSpend, writeSpend } from "./spend.js";
import { httpHealth, httpProbe } from "./health.js";
import { acquireLock } from "./lock.js";
import { SCHEDULER_STANDBY_TAG, SCHEDULER_TAG, SCHEDULER_TYPE, buildSchedulerUserData } from "./scheduler.js";
import { LinodeProvider } from "./linode.js";
import { bestFleet, costPerHour } from "./plan.js";
import { publishSource, sourceDownloadUrl, type S3Settings } from "./release.js";
import { tick } from "./runner.js";
import { simulate } from "./simulate.js";
import { DEFAULT_CONFIG } from "./slots.js";
import type { FleetConfig } from "./types.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
  }
  return out;
}

const env = { ...readEnvFile(join(repo, ".env")), ...process.env } as Record<string, string | undefined>;
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const apply = flag("apply");

function loadConfig(): FleetConfig {
  const file = join(repo, "fleet.config.json");
  const overrides = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<FleetConfig>) : {};
  // No spare server by default: a spare is a whole extra server paid for in every class window. An unplanned class is covered by
  // the office's "start now" boost or the live-now allowance. (FLEET_SPARE_CLASSES=1 brings the headroom back.)
  const spare = Number(env.FLEET_SPARE_CLASSES);
  const config = { ...DEFAULT_CONFIG, spareClasses: Number.isFinite(spare) && env.FLEET_SPARE_CLASSES !== undefined && env.FLEET_SPARE_CLASSES !== "" ? Math.max(0, Math.floor(spare)) : 0, ...overrides };
  // A pause switch: nothing new is created, but servers still get deleted (so a pause can never leave money running).
  // FLEET_MAX_SERVERS raises/lowers the hard ceiling without a config file (the scheduler server only receives .env).
  const ceiling = Number(env.FLEET_MAX_SERVERS);
  if (env.FLEET_MAX_SERVERS && Number.isInteger(ceiling) && ceiling >= 1 && ceiling <= 20) config.maxServers = ceiling;
  // A new Linode account may not be allowed the big plans (its limit, lifted by a support request): FLEET_TYPES=g6-dedicated-2,g6-dedicated-4
  // keeps the planner to the plans that can really be created. Cost per class is the same, so only the server count changes.
  if (env.FLEET_TYPES) {
    const wanted = env.FLEET_TYPES.split(",").map((s) => s.trim()).filter(Boolean);
    const known = new Set(config.types.map((t) => t.id));
    const unknown = wanted.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`FLEET_TYPES has unknown plan(s): ${unknown.join(", ")}`);
    config.types = config.types.filter((t) => wanted.includes(t.id));
  }
  return env.FLEET_PAUSE_CREATES === "1" ? { ...config, maxCreatesPerTick: 0 } : config;
}

function s3Settings(): S3Settings {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} is missing from .env`); return v; };
  return { bucket: need("S3_BUCKET"), region: need("S3_REGION"), endpoint: need("S3_ENDPOINT"), accessKey: need("S3_ACCESS_KEY"), secret: need("S3_SECRET") };
}

function provider() {
  const token = env.LINODE_TOKEN;
  if (!token) throw new Error("LINODE_TOKEN is missing from .env");
  const key = env.FLEET_SSH_PUBKEY_FILE && existsSync(env.FLEET_SSH_PUBKEY_FILE) ? readFileSync(env.FLEET_SSH_PUBKEY_FILE, "utf8").trim() : undefined;
  const fallbackRegions = (env.FLEET_REGION_FALLBACKS ?? "nl-ams").split(",").map((r) => r.trim()).filter(Boolean);
  return new LinodeProvider({ token, region: env.FLEET_REGION ?? "eu-central", fallbackRegions, tag: env.FLEET_TAG ?? "eduprime-recorder", authorizedKeys: key ? [key] : [] });
}

async function makeUserData(server: { typeId: string } = { typeId: "" }): Promise<string> {
  const envFile = resolve(repo, env.FLEET_RECORDER_ENV_FILE ?? "deploy/prod.env");
  if (!existsSync(envFile)) throw new Error(`the recorder settings file is missing: ${envFile} (copy deploy/env.server.example and fill it in)`);
  const keyFile = env.FLEET_SSH_PUBKEY_FILE;
  // Each server accepts only as many recordings as its size is trusted with.
  const classes = loadConfig().types.find((t) => t.id === server.typeId)?.classes;
  const recorderEnv = readFileSync(envFile, "utf8");
  return buildUserData({
    recorderEnv: classes ? withMaxJobs(recorderEnv, classes) : recorderEnv,
    sourceUrl: await sourceDownloadUrl(s3Settings()),
    sshPublicKey: keyFile && existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined,
  });
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** The secret shared with the LMS: the same one the servers use, read from the servers' settings file. */
function sharedSecret(): string | undefined {
  if (env.RECORDER_SHARED_SECRET) return env.RECORDER_SHARED_SECRET;
  const file = resolve(repo, env.FLEET_RECORDER_ENV_FILE ?? "deploy/prod.env");
  return readEnvFile(file).RECORDER_SHARED_SECRET;
}

const demandOptions = (config: FleetConfig) => ({
  config,
  mode: (env.FLEET_DEMAND_MODE as DemandMode | undefined) ?? "lms",
  forecastUrl: env.LMS_FORECAST_URL,
  secret: sharedSecret(),
});

const schoolTime = (iso: string) => new Date(new Date(iso).getTime() + 3_600_000).toISOString().slice(5, 16).replace("T", " ");

async function main(): Promise<void> {
  const config = loadConfig();

  if (command === "plan") {
    const days = Number(option("days") ?? 28);
    const month = simulate({ config, from: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`), days });
    console.log(`Simulated ${days} days with the current timetable (${config.slots.map((s) => `${s.name}: ${s.classes} classes`).join(", ")}):`);
    console.log(`  server cost:       ${usd(month.usd)}  (about ${usd((month.usd * 30) / days)} per 30 days, billed by the started hour)`);
    console.log(`  server-hours:      ${month.serverHours}   peak servers at once: ${month.peakServers}`);
    console.log(`  classes uncovered: ${month.uncoveredClassMinutes} class-minutes (those would fall back to LiveKit recording)`);
    console.log(`  left running at the end: ${month.leftover}`);
    for (const n of [1, 2, 3, 4, 5, 6, 8]) {
      const fleet = bestFleet(n, config.types);
      console.log(`  ${n} classes at once -> ${Object.entries(fleet).map(([id, c]) => `${c} x ${config.types.find((t) => t.id === id)?.label}`).join(" + ")}  (${usd(costPerHour(fleet, config.types))}/hour)`);
    }
    return;
  }

  if (command === "forecast") {
    // What the LMS says is coming, and what the fleet would do about it. Read-only.
    const url = env.LMS_FORECAST_URL;
    const secret = sharedSecret();
    if (!url || !secret) throw new Error("set LMS_FORECAST_URL in .env (and a RECORDER_SHARED_SECRET in deploy/prod.env)");
    const forecast = await fetchForecast({ url, secret, hours: Number(option("hours") ?? 48) });
    console.log(`LMS timetable: ${forecast.cohorts} cohorts, ${forecast.liveNow} class(es) live now, generated ${forecast.generatedAt}`);
    if (forecast.buckets.length === 0) console.log("  no classes in this window");
    for (const b of forecast.buckets) console.log(`  ${schoolTime(b.start)} -> ${schoolTime(b.end).slice(6)}  ${String(b.classes).padStart(2)} classes  -> ${Object.entries(bestFleet(b.classes, config.types)).map(([id, c]) => `${c} x ${config.types.find((t) => t.id === id)?.label}`).join(" + ")}`);
    const hours = Number(option("hours") ?? 48);
    const run = simulate({ config, from: new Date(forecast.generatedAt), days: Math.max(1, Math.ceil(hours / 24)), demand: new ForecastDemand(forecast) });
    console.log(`Servers for this window: about ${usd(run.usd)} (${run.serverHours} server-hours, peak ${run.peakServers} at once, ${run.uncoveredClassMinutes} class-minutes uncovered)`);
    return;
  }

  if (command === "release") {
    const { bytes } = await publishSource(repo, s3Settings());
    console.log(`Published the recorder source (${(bytes / 1024).toFixed(0)} KB). New servers will build from it.`);
    return;
  }

  const p = provider();

  if (command === "status") {
    const probe = httpProbe();
    const servers = await p.list();
    if (servers.length === 0) console.log("No fleet servers exist. (Nothing is being billed.)");
    for (const s of servers) {
      const active = s.status === "running" && s.ip ? await probe(s.ip) : null;
      const hours = ((Date.now() - s.createdAt.getTime()) / 3_600_000).toFixed(1);
      console.log(`${s.label}  id=${s.id}  ${s.typeId}  ${s.status}  ip=${s.ip ?? "-"}  age=${hours}h  recordings=${active === null ? "no answer" : active}`);
    }
    return;
  }

  if (command === "tick") {
    const release = acquireLock(join(repo, ".fleet.lock"));
    if (!release) { console.log("Another pass is running (lock held); skipping."); return; }
    try {
      const s3 = s3Settings();
      const now = new Date();
      const role: Role = env.FLEET_ROLE === "standby" ? "standby" : "primary";
      const holder = hostname();
      const events: string[] = [];

      // A standby leaves the work to the primary for as long as the primary keeps reporting in.
      if (role === "standby") {
        const verdict = shouldStandBy(await readBeat(s3, "primary"), now);
        console.log(`${now.toISOString()}  standby: ${verdict.why}`);
        const mine = await readBeat(s3, "standby");
        if (verdict.standBy) {
          if (apply) await writeBeat(s3, nextBeat(mine, now, { role, holder, acting: false, servers: 0, needSoon: 0, needLater: 0, actions: 0, failed: 0, timetable: verdict.why, paused: false, boosted: false, notes: [], events: [] })).catch(() => undefined);
          return;
        }
        if (!mine?.acting) events.push(`STANDBY took over: ${verdict.why}`);
      }

      // What the office has asked for (pause, skip dates, boost). A missing or broken file means "no instructions".
      const { control, problem } = await readControl(s3, now);
      if (problem) { console.log(`  ${problem}`); events.push(problem); }
      const applied = applyControl(config, control, now);
      for (const n of applied.notes) console.log(`  control: ${n}`);

      const loaded = await loadDemand({ ...demandOptions(applied.config), skipDates: applied.skipDates });
      const demand = applied.adjustDemand(loaded.demand);
      // Publish which servers the LMS may send work to BEFORE any server is deleted, so it stops using them first.
      const beforeApply = async ({ servers, decision }: { servers: import("./types.js").ServerState[]; decision: import("./reconcile.js").Decision }) => {
        const doomed = new Set(decision.actions.flatMap((a) => (a.kind === "delete" ? [a.id] : [])));
        const health = new Map<string, ServerHealth>();
        await Promise.all(servers.map(async (s) => { const h = s.ip ? await httpHealth(s.ip) : null; if (h) health.set(s.id, h); }));
        const directory = buildDirectory(servers, health, doomed, new Date());
        await publishDirectory(s3, directory);
        console.log(`  directory published: ${directory.servers.length} server(s) open for recording`);
      };
      const report = await tick({ provider: p, probe: httpProbe(), config: applied.config, apply, userData: makeUserData, demand, beforeApply });
      console.log(`${report.at.toISOString()}  classes needed within ${applied.config.leadMinutes} min: ${report.decision.need.create}, within ${applied.config.keepMinutes} min: ${report.decision.need.keep}  servers: ${report.servers.length}`);
      console.log(`  timetable: ${loaded.note}`);
      for (const n of report.decision.notes) console.log(`  note: ${n}`);
      if (report.decision.actions.length === 0) console.log("  nothing to do");
      report.decision.actions.forEach((a, i) => {
        const done = report.executed[i];
        const what = a.kind === "create" ? `CREATE ${a.typeId}` : `DELETE ${a.label}`;
        console.log(`  ${apply ? (done?.ok ? "done:  " : "FAILED:") : "would: "} ${what}  (${a.reason})${done?.error ? "  ERROR: " + done.error : ""}`);
        if (apply) events.push(done?.ok ? `${a.kind === "create" ? "started" : "removed"} ${a.kind === "create" ? a.typeId : a.label}: ${a.reason}` : `FAILED to ${a.kind} ${a.kind === "create" ? a.typeId : a.label}: ${done?.error ?? "unknown error"}`);
      });
      if (!apply && report.decision.actions.length) console.log("  (dry run: nothing changed. Add --apply to act.)");
      if (report.executed.some((e) => !e.ok)) process.exitCode = 1;

      if (apply) {
        // Running cost estimate (servers seen x time since the last pass), for the admin page.
        const price = new Map(DEFAULT_CONFIG.types.map((t) => [t.id, t.usdPerHour]));
        const perHour = report.servers.reduce((sum, s) => sum + (price.get(s.typeId) ?? 0), 0);
        await writeSpend(s3, addSpend(await readSpend(s3), now, report.servers.length, perHour)).catch((error: unknown) => console.log(`  (spend not written: ${error instanceof Error ? error.message : String(error)})`));
        const prev = await readBeat(s3, role);
        // Tell the log when the office's instructions change, not on every pass.
        if (JSON.stringify(prev?.notes ?? []) !== JSON.stringify(applied.notes)) events.push(applied.notes.length ? `instructions now in force: ${applied.notes.join("; ")}` : "no special instructions in force");
        await writeBeat(s3, nextBeat(prev, now, {
          role, holder, acting: true, servers: report.servers.length, needSoon: report.decision.need.create, needLater: report.decision.need.keep,
          actions: report.decision.actions.length, failed: report.executed.filter((e) => !e.ok).length, timetable: loaded.note,
          paused: control.paused, boosted: applied.notes.some((n) => n.startsWith("BOOST")), notes: applied.notes, events,
        })).catch((error: unknown) => console.log(`  (heartbeat not written: ${error instanceof Error ? error.message : String(error)})`));
      }
    } finally {
      release();
    }
    return;
  }

  if (command === "control") {
    const s3 = s3Settings();
    const now = new Date();
    const { control: current, problem } = await readControl(s3, now);
    if (problem) console.log(problem);
    const next = { ...current, skipDates: [...current.skipDates], updatedAt: now.toISOString(), updatedBy: "command line" };
    let changed = false;
    if (flag("pause")) { next.paused = true; next.pauseNote = option("pause") && !option("pause")!.startsWith("--") ? option("pause")!.slice(0, 200) : ""; changed = true; }
    if (flag("resume")) { next.paused = false; next.pauseNote = ""; next.stopAllAt = null; changed = true; }
    if (flag("stop-all")) { next.paused = true; next.pauseNote = next.pauseNote || "powered off from the command line"; next.stopAllAt = now.toISOString(); changed = true; }
    if (option("skip")) { if (!/^\d{4}-\d{2}-\d{2}$/.test(option("skip")!)) throw new Error("--skip needs a date like 2026-12-25"); next.skipDates = [...new Set([...next.skipDates, option("skip")!])].sort(); changed = true; }
    if (option("unskip")) { next.skipDates = next.skipDates.filter((d) => d !== option("unskip")); changed = true; }
    if (option("boost")) {
      const classes = Number(option("boost")); const hours = Number(option("hours") ?? 2);
      if (!Number.isInteger(classes) || classes < 1 || classes > 12 || !(hours > 0 && hours <= 12)) throw new Error("--boost needs 1-12 classes and --hours up to 12");
      next.boost = { classes, until: new Date(now.getTime() + hours * 3_600_000).toISOString() };
      changed = true;
    }
    if (flag("no-boost")) { next.boost = null; changed = true; }
    if (changed) { await writeControl(s3, next); console.log("Saved. The scheduler picks it up within 5 minutes."); }
    const shown = changed ? next : current === NO_CONTROL ? NO_CONTROL : current;
    console.log(`paused: ${shown.paused}${shown.pauseNote ? ` (${shown.pauseNote})` : ""}  days off: ${shown.skipDates.join(", ") || "none"}  boost: ${shown.boost ? `${shown.boost.classes} class(es) until ${shown.boost.until}` : "none"}  by: ${shown.updatedBy || "-"}`);
    return;
  }

  if (command === "heartbeat") {
    const s3 = s3Settings();
    let worst = 0;
    for (const role of ["primary", "standby"] as const) {
      const beat = await readBeat(s3, role);
      if (!beat) { console.log(`${role}: no heartbeat${role === "primary" ? " yet: the scheduler has not completed a pass" : ""}.`); if (role === "primary") worst = 1; continue; }
      const age = Math.round((Date.now() - new Date(beat.at).getTime()) / 1000);
      console.log(`${role}: ran ${age}s ago (${beat.at}) on ${beat.holder}${beat.acting ? "" : " [standing by]"}: ${beat.servers} server(s), ${beat.needSoon} class(es) needed soon, ${beat.actions} action(s), ${beat.failed} failed.${beat.paused ? " PAUSED." : ""}`);
      if (role === "primary" && age > 600) { console.log("WARNING: the primary is more than 10 minutes silent. The standby will take over after 12."); worst = 1; }
      if (flag("log")) for (const l of beat.recent.slice(-15)) console.log(`    ${l.at.slice(5, 16).replace("T", " ")}  ${l.text}`);
    }
    process.exitCode = worst;
    return;
  }

  if (command === "scheduler") {
    // The always-on machine that runs `tick --apply` every minute. Tagged differently so the fleet never touches it.
    const token = env.LINODE_TOKEN!;
    // --role standby builds the second scheduler, in ANOTHER region (--region, default nl-ams), under its own tag.
    const standby = option("role") === "standby";
    const tag = standby ? SCHEDULER_STANDBY_TAG : SCHEDULER_TAG;
    const sched = new LinodeProvider({ token, region: standby ? option("region") ?? "nl-ams" : env.FLEET_REGION ?? "eu-central", tag });
    const existing = await sched.list();
    const action = option("do") ?? "create";
    if (action === "status") {
      const both = [
        ...(await new LinodeProvider({ token, tag: SCHEDULER_TAG }).list()).map((s) => ({ ...s, role: "primary" })),
        ...(await new LinodeProvider({ token, tag: SCHEDULER_STANDBY_TAG }).list()).map((s) => ({ ...s, role: "standby" })),
      ];
      console.log(both.length ? both.map((s) => `${s.role}: ${s.label} id=${s.id} ${s.status} ip=${s.ip}`).join("\n") : "No scheduler exists.");
      return;
    }
    if (action === "delete") {
      for (const s of existing) { if (apply) { await sched.remove(s.id); console.log(`deleted ${s.label}`); } else console.log(`would delete ${s.label} (add --apply)`); }
      if (existing.length === 0) console.log("No scheduler exists.");
      return;
    }
    if (existing.length > 0) throw new Error(`a scheduler already exists (${existing[0]!.label}); use --do delete first to replace it`);
    console.log(`The scheduler is a ${SCHEDULER_TYPE} server (about $5/month, always on). It will run \`tick --apply\` every minute.`);
    console.log("Once running it WILL create recorder servers by the timetable. Create it only when you are ready for that.");
    if (!apply) { console.log("(dry run: nothing created. Add --apply.)"); return; }
    const userData = buildSchedulerUserData({
      sourceUrl: await sourceDownloadUrl(s3Settings()),
      dotEnv: readFileSync(join(repo, ".env"), "utf8"),
      recorderEnv: readFileSync(resolve(repo, env.FLEET_RECORDER_ENV_FILE ?? "deploy/prod.env"), "utf8"),
      pauseCreates: flag("paused"),
      role: standby ? "standby" : "primary",
    });
    const server = await sched.create({ typeId: SCHEDULER_TYPE, label: `fleet-${standby ? "standby" : "scheduler"}-${Date.now().toString(36)}`, userData });
    console.log(`Created ${server.label} (id ${server.id}). It is ready in about 5 minutes; check with: npm run fleet -- scheduler --do status`);
    return;
  }

  if (command === "create") {
    const typeId = option("type");
    const type = config.types.find((t) => t.id === typeId);
    if (!type) throw new Error(`--type must be one of: ${config.types.map((t) => t.id).join(", ")}`);
    const existing = await p.list();
    if (existing.length >= config.maxServers) throw new Error(`already ${existing.length} servers (max ${config.maxServers})`);
    if (!apply) { console.log(`Would create one ${type.label} (${usd(type.usdPerHour)}/hour). Add --apply to do it.`); return; }
    const server = await p.create({ typeId: type.id, label: `rec-manual-${Date.now().toString(36)}`, userData: await makeUserData() });
    console.log(`Created ${server.label} (id ${server.id}, ${server.typeId}). It bills ${usd(type.usdPerHour)}/hour until deleted.`);
    return;
  }

  if (command === "teardown") {
    const servers = await p.list();
    if (servers.length === 0) { console.log("No fleet servers exist."); return; }
    for (const s of servers) {
      if (!apply) { console.log(`would delete ${s.label} (id ${s.id})`); continue; }
      await p.remove(s.id);
      console.log(`deleted ${s.label} (id ${s.id})`);
    }
    if (!apply) console.log("(dry run: nothing deleted. Add --apply.)");
    return;
  }

  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 15).join("\n").replace(/^ \* ?/gm, ""));
}

main().catch((error) => {
  console.error("fleet:", error instanceof Error ? error.message : error);
  process.exit(1);
});
