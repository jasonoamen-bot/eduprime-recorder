import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sendCallback } from "./callback.js";
import type { Config } from "./config.js";
import type { JobRecord, JobRequest, JobStatus } from "./job.js";
import type { Logger } from "./log.js";
import { finalizeFragment, RecordingSession, StartCancelled, type SessionResult } from "./session.js";
import type { Storage } from "./storage.js";

export class AtCapacityError extends Error {
  constructor() {
    super("recorder is at capacity");
  }
}

const ACTIVE: JobStatus[] = ["starting", "recording", "finalising", "uploading"];
const START_ATTEMPTS = 2;

/**
 * Owns every recording job: accepts them, runs them, survives restarts.
 *
 * DESIGN CHOICES worth knowing:
 *  - No queue. If we are full we say so (503) instead of starting a recording
 *    late. A class recorded from minute 20 is worse than a clear "use the
 *    fallback recorder" answer the LMS can act on immediately.
 *  - Idempotent by jobId AND by room. The LMS calls "start" on every heartbeat
 *    by design; asking twice must never make two recordings.
 *  - Every state change is written to disk (token stripped), so a restart
 *    picks up half-finished work instead of forgetting it.
 */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly sessions = new Map<string, RecordingSession>();
  private readonly runs = new Set<Promise<void>>();
  private readonly stopRequests = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly storage: Storage,
    private readonly log: Logger,
  ) {}

  get activeCount(): number {
    return [...this.jobs.values()].filter((job) => ACTIVE.includes(job.status)).length;
  }

  get capacity(): number {
    return this.config.MAX_CONCURRENT_JOBS;
  }

  get(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  async init(): Promise<void> {
    await mkdir(this.config.SPOOL_DIR, { recursive: true });
    await this.recover();
  }

  /** Start a recording. Returns the existing job when this is a repeat request. */
  submit(request: JobRequest): { job: JobRecord; created: boolean } {
    const existing = this.jobs.get(request.jobId);
    if (existing) return { job: existing, created: false };

    const sameRoom = [...this.jobs.values()].find(
      (job) => job.request.roomName === request.roomName && ACTIVE.includes(job.status),
    );
    if (sameRoom) return { job: sameRoom, created: false };

    // Only recordings that are still capturing count against the CPU budget.
    const capturing = [...this.jobs.values()].filter((job) => job.status === "starting" || job.status === "recording").length;
    if (capturing >= this.config.MAX_CONCURRENT_JOBS) throw new AtCapacityError();

    const job: JobRecord = { request, status: "starting", createdAt: new Date().toISOString() };
    this.jobs.set(request.jobId, job);
    void this.persist(job);

    const running = this.execute(job).finally(() => this.runs.delete(running));
    this.runs.add(running);
    return { job, created: true };
  }

  stop(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || !ACTIVE.includes(job.status)) return false;
    // Remembered separately from the session: a stop can arrive before a session
    // exists (between start attempts) and must still win.
    this.stopRequests.add(jobId);
    this.sessions.get(jobId)?.requestStop("stopped-by-lms");
    return true;
  }

  /** Graceful shutdown: end every recording and give uploads a chance to finish. */
  async shutdown(timeoutMs = 110_000): Promise<void> {
    for (const session of this.sessions.values()) session.requestStop("stopped-by-lms");
    await Promise.race([Promise.allSettled([...this.runs]), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  private async execute(job: JobRecord): Promise<void> {
    const log = this.log.child({ jobId: job.request.jobId, room: job.request.roomName });

    // One retry on start: a browser or virtual screen that hiccups on a busy
    // machine is transient, and a live class cannot be re-run.
    let session: RecordingSession | null = null;
    for (let attempt = 1; attempt <= START_ATTEMPTS && !session; attempt++) {
      // A stop that arrived while starting (or between attempts) means: do not start at all.
      if (this.stopRequests.has(job.request.jobId)) break;
      const candidate = new RecordingSession(job.request, this.config, log);
      this.sessions.set(job.request.jobId, candidate);
      try {
        await candidate.start();
        session = candidate;
      } catch (error) {
        const cancelled = error instanceof StartCancelled;
        log.warn(cancelled ? "start cancelled" : "start attempt failed", { attempt, error: String(error) });
        await candidate.stop().catch(() => undefined);
        if (cancelled) break; // never retry a start that was told to stop
      }
    }

    if (!session) {
      this.sessions.delete(job.request.jobId);
      const wasStopped = this.stopRequests.has(job.request.jobId);
      job.reason = wasStopped ? "stopped-before-start" : "start-failed";
      if (!wasStopped) log.error("could not start recording after retries");
      await this.deliver(job, null, log);
      return;
    }

    let result: SessionResult | null = null;
    try {
      await this.setStatus(job, "recording", { startedAt: new Date().toISOString() });
      job.reason = await session.ended;
      await this.setStatus(job, "finalising");
      result = await session.stop();
    } finally {
      this.sessions.delete(job.request.jobId);
    }

    await this.deliver(job, result, log);
  }

  /** Upload what we have and tell the LMS. Shared by normal runs and crash recovery. */
  private async deliver(job: JobRecord, result: SessionResult | null, log: Logger): Promise<void> {
    if (!result) {
      await this.setStatus(job, "failed", { endedAt: new Date().toISOString() });
      await this.notify(job, "failed", log);
      return;
    }
    job.durationSeconds = result.durationSeconds;
    job.sizeBytes = result.sizeBytes;
    job.localPath = result.path;
    try {
      await this.setStatus(job, "uploading");
      await this.storage.put(result.path, job.request.objectKey);
    } catch (error) {
      // Keep the file on disk: recovery retries the upload on the next boot.
      job.reason = `upload-failed: ${String(error).slice(0, 200)}`;
      log.error("upload failed, file kept for retry", { error: String(error) });
      await this.setStatus(job, "failed", { endedAt: new Date().toISOString() });
      await this.notify(job, "failed", log);
      return;
    }
    await this.setStatus(job, "done", { endedAt: new Date().toISOString() });
    await this.notify(job, "completed", log);
    await this.cleanup(job.request.jobId);
  }

  private async notify(job: JobRecord, status: "completed" | "failed", log: Logger): Promise<void> {
    const { callbackUrl } = job.request;
    if (!callbackUrl) return;
    await sendCallback(
      callbackUrl,
      this.config.RECORDER_SHARED_SECRET,
      {
        jobId: job.request.jobId,
        roomName: job.request.roomName,
        status,
        objectKey: job.request.objectKey,
        durationSeconds: job.durationSeconds,
        sizeBytes: job.sizeBytes,
        reason: job.reason,
      },
      log,
    );
  }

  /**
   * After a crash or restart: anything that was mid-flight and left footage on
   * disk gets finalised, uploaded and reported instead of silently lost.
   */
  private async recover(): Promise<void> {
    const files = await readdir(this.config.SPOOL_DIR).catch(() => [] as string[]);
    for (const name of files.filter((file) => file.endsWith(".json"))) {
      try {
        const job = JSON.parse(await readFile(join(this.config.SPOOL_DIR, name), "utf8")) as JobRecord;
        if (job.status === "done") {
          await this.cleanup(job.request.jobId);
          continue;
        }
        if (!ACTIVE.includes(job.status) && !job.localPath) continue;
        const jobId = job.request.jobId;
        const log = this.log.child({ jobId, recovered: true });
        const frag = join(this.config.SPOOL_DIR, `${jobId}.frag.mp4`);
        const final = join(this.config.SPOOL_DIR, `${jobId}.mp4`);
        const source = existsSync(final) ? final : frag;
        const result = existsSync(source) ? await finalizeFragment(frag, final, log) : null;
        job.reason = `recovered after restart (was ${job.status})`;
        this.jobs.set(jobId, job);
        log.info("recovering job", { hasFootage: Boolean(result) });
        const running = this.deliver(job, result, log).finally(() => this.runs.delete(running));
        this.runs.add(running);
      } catch (error) {
        this.log.warn("could not recover job file", { file: name, error: String(error) });
      }
    }
  }

  private async setStatus(job: JobRecord, status: JobStatus, extra: Partial<JobRecord> = {}): Promise<void> {
    Object.assign(job, extra, { status });
    await this.persist(job);
  }

  private async persist(job: JobRecord): Promise<void> {
    // The token is a credential: it must never be written to disk.
    const { token: _token, ...request } = job.request;
    const safe = { ...job, request: { ...request, token: "redacted-not-stored" } };
    await writeFile(join(this.config.SPOOL_DIR, `${job.request.jobId}.json`), JSON.stringify(safe), "utf8").catch(() => undefined);
  }

  private async cleanup(jobId: string): Promise<void> {
    for (const suffix of [".frag.mp4", ".mp4"]) {
      await rm(join(this.config.SPOOL_DIR, `${jobId}${suffix}`), { force: true }).catch(() => undefined);
    }
  }
}
