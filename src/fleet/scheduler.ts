/**
 * The scheduler: a tiny always-on server whose only job is to run `fleet tick --apply` every five minutes.
 *
 * Why a separate machine: the fleet manager must keep running when no one's laptop is on, and the Linode token
 * it holds must not live inside the school website (a break-in there would then reach the servers account).
 * It is tagged differently from the recorder servers, so the fleet manager never lists, counts or deletes it.
 *
 * IF IT STOPS, nothing breaks for students (classes fall back to LiveKit recording), but servers already
 * running would not be deleted until it is back. That is why the fleet has a hard server cap, and why this
 * machine restarts its job on reboot. Check `fleet status` now and then.
 */

export const SCHEDULER_TAG = "eduprime-scheduler";
/** The second scheduler, in another region: it only acts when the first has gone quiet (see beat.ts). */
export const SCHEDULER_STANDBY_TAG = "eduprime-scheduler-standby";
/** Linode's smallest plan (about $5 a month). The job is a few HTTP calls every five minutes. */
export const SCHEDULER_TYPE = "g6-nanode-1";

export type SchedulerInput = {
  /** One-hour signed link to the recorder source tarball (see release.ts). */
  sourceUrl: string;
  /** The fleet manager's own settings (.env): the Linode token, the Backblaze key, the LMS forecast address. */
  dotEnv: string;
  /** The settings recorder servers are created with (shared secret, origins, Backblaze keys, video settings). */
  recorderEnv: string;
  /** Optional: keep the fleet from creating anything (it still deletes). For pausing without destroying the scheduler. */
  pauseCreates?: boolean;
  /** "standby" = act only when the primary scheduler has been silent for a while. */
  role?: "primary" | "standby";
};

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

export function buildSchedulerUserData(input: SchedulerInput): string {
  if (!/^https:\/\//.test(input.sourceUrl)) throw new Error("the source link must be https");
  if (!/^LINODE_TOKEN=\S{20,}/m.test(input.dotEnv)) throw new Error("the scheduler needs LINODE_TOKEN in .env");
  if (!/^RECORDER_SHARED_SECRET=\S{32,}/m.test(input.recorderEnv)) throw new Error("the recorder settings need a RECORDER_SHARED_SECRET");
  const dotEnv = input.dotEnv.replace(/^FLEET_RECORDER_ENV_FILE=.*$/m, "").trimEnd() + `\nFLEET_RECORDER_ENV_FILE=deploy/prod.env\n` + (input.pauseCreates ? "FLEET_PAUSE_CREATES=1\n" : "") + (input.role === "standby" ? "FLEET_ROLE=standby\n" : "");

  const text = [
    "#cloud-config",
    "package_update: true",
    "packages: [ca-certificates, curl, ufw, tar]",
    "write_files:",
    "  - path: /opt/fleet/.env",
    "    permissions: '0600'",
    "    encoding: b64",
    `    content: ${b64(dotEnv)}`,
    "  - path: /opt/fleet/deploy/prod.env",
    "    permissions: '0600'",
    "    encoding: b64",
    `    content: ${b64(input.recorderEnv)}`,
    "  - path: /etc/cron.d/fleet",
    "    permissions: '0644'",
    "    content: |",
    "      # every 5 minutes: look at the timetable and the servers, create or delete what is needed",
    "      */5 * * * * root cd /opt/fleet && /usr/bin/npx tsx src/fleet/cli.ts tick --apply >> /var/log/fleet.log 2>&1",
    "      # keep the log from growing for ever",
    "      0 4 * * 0 root tail -c 200000 /var/log/fleet.log > /var/log/fleet.log.tmp && mv /var/log/fleet.log.tmp /var/log/fleet.log",
    "runcmd:",
    "  - ufw allow OpenSSH",
    "  - ufw --force enable",
    "  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
    "  - apt-get install -y nodejs",
    `  - curl -fsSL --retry 5 --retry-delay 5 '${input.sourceUrl}' -o /tmp/source.tgz`,
    "  - tar xzf /tmp/source.tgz -C /opt/fleet && rm /tmp/source.tgz",
    "  - cd /opt/fleet && npm ci --no-audit --no-fund",
    "  - touch /var/log/fleet.log",
    "  - touch /opt/fleet/.ready",
  ].join("\n") + "\n";
  if (Buffer.byteLength(text) > 60_000) throw new Error("first-boot text is too large for Linode (65,535 byte limit)");
  return text;
}
