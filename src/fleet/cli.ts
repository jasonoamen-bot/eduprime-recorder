#!/usr/bin/env node
/**
 * The fleet manager's command line.
 *
 *   npm run fleet -- plan [--days 28]        what a month would cost, and the servers' schedule (no network)
 *   npm run fleet -- status                  the servers that exist right now, and what each is doing
 *   npm run fleet -- tick [--apply]          one pass: what should be created/deleted (dry run unless --apply)
 *   npm run fleet -- create --type ID [--apply]   make one server by hand (for testing)
 *   npm run fleet -- teardown [--apply]      delete EVERY server this fleet made (emergency / end of a test)
 *   npm run fleet -- release                 publish the recorder source that new servers build from
 *
 * Everything that spends or removes money is a dry run unless `--apply` is given.
 * Settings live in the recorder's .env (LINODE_TOKEN, S3_*), `fleet.config.json` (optional overrides) and
 * the recorder's own settings file for the servers (FLEET_RECORDER_ENV_FILE, default deploy/prod.env).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUserData } from "./bootstrap.js";
import { httpProbe } from "./health.js";
import { acquireLock } from "./lock.js";
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
  return { ...DEFAULT_CONFIG, ...overrides };
}

function s3Settings(): S3Settings {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`${k} is missing from .env`); return v; };
  return { bucket: need("S3_BUCKET"), region: need("S3_REGION"), endpoint: need("S3_ENDPOINT"), accessKey: need("S3_ACCESS_KEY"), secret: need("S3_SECRET") };
}

function provider() {
  const token = env.LINODE_TOKEN;
  if (!token) throw new Error("LINODE_TOKEN is missing from .env");
  const key = env.FLEET_SSH_PUBKEY_FILE && existsSync(env.FLEET_SSH_PUBKEY_FILE) ? readFileSync(env.FLEET_SSH_PUBKEY_FILE, "utf8").trim() : undefined;
  return new LinodeProvider({ token, region: env.FLEET_REGION ?? "eu-central", tag: env.FLEET_TAG ?? "eduprime-recorder", authorizedKeys: key ? [key] : [] });
}

async function makeUserData(): Promise<string> {
  const envFile = resolve(repo, env.FLEET_RECORDER_ENV_FILE ?? "deploy/prod.env");
  if (!existsSync(envFile)) throw new Error(`the recorder settings file is missing: ${envFile} (copy deploy/env.server.example and fill it in)`);
  const keyFile = env.FLEET_SSH_PUBKEY_FILE;
  return buildUserData({
    recorderEnv: readFileSync(envFile, "utf8"),
    sourceUrl: await sourceDownloadUrl(s3Settings()),
    sshPublicKey: keyFile && existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : undefined,
  });
}

const usd = (n: number) => `$${n.toFixed(2)}`;

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
      const report = await tick({ provider: p, probe: httpProbe(), config, apply, userData: makeUserData });
      console.log(`${report.at.toISOString()}  classes needed within ${config.leadMinutes} min: ${report.decision.need.create}, within ${config.keepMinutes} min: ${report.decision.need.keep}  servers: ${report.servers.length}`);
      for (const n of report.decision.notes) console.log(`  note: ${n}`);
      if (report.decision.actions.length === 0) console.log("  nothing to do");
      report.decision.actions.forEach((a, i) => {
        const done = report.executed[i];
        const what = a.kind === "create" ? `CREATE ${a.typeId}` : `DELETE ${a.label}`;
        console.log(`  ${apply ? (done?.ok ? "done:  " : "FAILED:") : "would: "} ${what}  (${a.reason})${done?.error ? "  ERROR: " + done.error : ""}`);
      });
      if (!apply && report.decision.actions.length) console.log("  (dry run: nothing changed. Add --apply to act.)");
      if (report.executed.some((e) => !e.ok)) process.exitCode = 1;
    } finally {
      release();
    }
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
