import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client } from "../storage.js";
import { RELEASE_KEY, type S3Settings } from "./release.js";
import type { ServerState } from "./types.js";

/**
 * The directory: which recorder servers exist right now, where they are, and how much room each has.
 *
 * Servers come and go with new addresses, so the LMS cannot be given a fixed one. The fleet manager keeps this
 * small file up to date in the private bucket; the LMS reads it (cached for a few seconds), picks a server with
 * free room, and falls back to LiveKit recording if there is none. Each job's id starts with the server's id
 * (`s<8 hex digits of its IPv4>-...`), so stopping or checking a job goes to the right machine with no database.
 */
export const DIRECTORY_KEY = RELEASE_KEY.replace("source-latest.tgz", "fleet.json");

export type DirectoryServer = {
  /** 8 hex digits: the server's IPv4 address. */
  id: string;
  url: string;
  /** Recordings this server accepts at once (set per server size when it is created). */
  capacity: number;
  /** Recordings in progress right now. */
  active: number;
};

export type Directory = { version: 1; updatedAt: string; servers: DirectoryServer[] };

export type ServerHealth = { active: number; capacity: number };

/** Hex id for an IPv4 address: "172.104.156.47" -> "ac689c2f". */
export function serverIdFromIp(ip: string): string {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) throw new Error(`not an IPv4 address: ${ip}`);
  return parts.map((p) => p.toString(16).padStart(2, "0")).join("");
}

/**
 * The directory of servers that are safe to send work to: running, answering, and not about to be deleted.
 * `health` maps a server id to what its recorder said; a server that did not answer is left out.
 */
export function buildDirectory(servers: ServerState[], health: Map<string, ServerHealth>, excludeIds: ReadonlySet<string>, now: Date, port = 8787): Directory {
  const entries: DirectoryServer[] = [];
  for (const s of servers) {
    if (s.status !== "running" || !s.ip || excludeIds.has(s.id)) continue;
    const h = health.get(s.id);
    if (!h) continue;
    entries.push({ id: serverIdFromIp(s.ip), url: `http://${s.ip}:${port}`, capacity: h.capacity, active: h.active });
  }
  return { version: 1, updatedAt: now.toISOString(), servers: entries.sort((a, b) => a.id.localeCompare(b.id)) };
}

export async function publishDirectory(s3: S3Settings, directory: Directory): Promise<void> {
  const client = createS3Client({ S3_REGION: s3.region, S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET: s3.secret });
  await client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: DIRECTORY_KEY, Body: JSON.stringify(directory), ContentType: "application/json", CacheControl: "no-store" }));
}

export async function readDirectory(s3: S3Settings): Promise<Directory | null> {
  const client = createS3Client({ S3_REGION: s3.region, S3_ENDPOINT: s3.endpoint, S3_ACCESS_KEY: s3.accessKey, S3_SECRET: s3.secret });
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: s3.bucket, Key: DIRECTORY_KEY }));
    return JSON.parse(await out.Body!.transformToString()) as Directory;
  } catch {
    return null;
  }
}
