/**
 * First-boot setup for a fleet server (cloud-init), built as text.
 *
 * A fresh Ubuntu server is turned into a working recorder in about 6-8 minutes:
 * install Docker, switch on a firewall, download the recorder source from the private bucket (a one-hour
 * signed link), build the image on the server (its network is fast; the school's is not), and start it.
 *
 * Secrets (the recorder's settings file) travel base64-encoded inside this text, which Linode stores as the
 * server's metadata. That is acceptable for a short-lived server in our own account, and the token that can
 * create servers is NEVER included.
 */

/**
 * Set how many recordings THIS server accepts at once, replacing any value in the shared settings file.
 * Without this every server would claim the same limit whatever its size, and a small one would be overloaded.
 */
export function withMaxJobs(recorderEnv: string, maxJobs: number): string {
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 50) throw new Error(`bad job limit: ${maxJobs}`);
  const kept = recorderEnv.split(/\r?\n/).filter((line) => !/^\s*MAX_CONCURRENT_JOBS\s*=/.test(line));
  while (kept.length && kept[kept.length - 1]!.trim() === "") kept.pop();
  return `${kept.join("\n")}\nMAX_CONCURRENT_JOBS=${maxJobs}\n`;
}

export type BootstrapInput = {
  /** The recorder's settings file: shared secret, allowed origins, Backblaze keys, video settings. */
  recorderEnv: string;
  /** A time-limited download link for the recorder source tarball (see release.ts). */
  sourceUrl: string;
  /** Optional public key for debugging logins. */
  sshPublicKey?: string;
};

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/** The compose file the server runs. No build step here: the image is built by the setup script below. */
export const SERVER_COMPOSE = `services:
  recorder:
    image: eduprime-recorder:server
    container_name: recorder
    restart: unless-stopped
    env_file: /opt/eduprime-recorder/recorder.env
    ports:
      - "8787:8787"
    shm_size: "1gb"
    volumes:
      - /opt/eduprime-recorder/spool:/data/spool
    stop_grace_period: 120s
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
`;

export function buildUserData(input: BootstrapInput): string {
  if (!/^https:\/\//.test(input.sourceUrl)) throw new Error("the source link must be https");
  if (!/RECORDER_SHARED_SECRET=\S{32,}/.test(input.recorderEnv)) throw new Error("the recorder settings need a RECORDER_SHARED_SECRET of 32+ characters");
  if (/LINODE_TOKEN/.test(input.recorderEnv)) throw new Error("refusing to put the Linode token into a server's settings");

  const lines = [
    "#cloud-config",
    "package_update: true",
    "packages: [ca-certificates, curl, ufw]",
    "write_files:",
    "  - path: /opt/eduprime-recorder/recorder.env",
    "    permissions: '0600'",
    "    encoding: b64",
    `    content: ${b64(input.recorderEnv)}`,
    "  - path: /opt/eduprime-recorder/docker-compose.yml",
    "    permissions: '0644'",
    "    encoding: b64",
    `    content: ${b64(SERVER_COMPOSE)}`,
  ];
  if (input.sshPublicKey) lines.push("ssh_authorized_keys:", `  - ${input.sshPublicKey.trim()}`);
  lines.push(
    "runcmd:",
    "  - curl -fsSL https://get.docker.com | sh",
    "  - ufw allow OpenSSH",
    "  - ufw allow 8787/tcp",
    "  - ufw allow 80/tcp",
    "  - ufw allow 443/tcp",
    "  - ufw --force enable",
    "  - mkdir -p /opt/eduprime-recorder/src /opt/eduprime-recorder/spool",
    "  - chown -R 1001:1001 /opt/eduprime-recorder/spool",
    `  - curl -fsSL --retry 5 --retry-delay 5 '${input.sourceUrl}' -o /tmp/source.tgz`,
    "  - tar xzf /tmp/source.tgz -C /opt/eduprime-recorder/src && rm /tmp/source.tgz",
    "  - cd /opt/eduprime-recorder/src && docker build -f Dockerfile.server -t eduprime-recorder:server .",
    "  - cd /opt/eduprime-recorder && docker compose up -d",
    "  - touch /opt/eduprime-recorder/.ready",
  );
  const text = lines.join("\n") + "\n";
  if (Buffer.byteLength(text) > 60_000) throw new Error("first-boot text is too large for Linode (65,535 byte limit)");
  return text;
}
