import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Config } from "./config.js";
import { captureArgs, probeArgs, remuxArgs } from "./ffmpeg.js";
import { pageUrlWithCredentials, type JobRequest } from "./job.js";
import type { Logger } from "./log.js";
import { output, run, sleep, type Running } from "./proc.js";

/**
 * The contract between this recorder and the page it opens. The page sets
 * `window.__recorder.state` so the recorder knows what is happening without
 * having to guess from pixels:
 *
 *   connecting -> connected -> ended        (normal class)
 *   connecting -> failed                    (could not join the room)
 */
export type PageState = "connecting" | "connected" | "ended" | "failed";

export type EndReason =
  | "room-ended"
  | "stopped-by-lms"
  | "max-duration"
  | "page-failed"
  | "page-crashed"
  | "ffmpeg-exited"
  | "xvfb-exited"
  | "start-failed";

export type SessionResult = { path: string; durationSeconds: number; sizeBytes: number };

// Each concurrent session needs its own virtual screen and its own audio sink.
const usedDisplays = new Set<number>();
function allocateDisplay(): number {
  for (let n = 101; n < 200; n++) {
    if (!usedDisplays.has(n)) {
      usedDisplays.add(n);
      return n;
    }
  }
  throw new Error("no free display numbers");
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * One class recording: a virtual screen, a virtual sound card, a browser that
 * looks at the class, and ffmpeg filming both.
 *
 * Everything here is torn down in `stop()` — leaked Xvfb/Chromium processes are
 * the classic way a recorder dies slowly, so cleanup is one idempotent path.
 */
export class RecordingSession {
  private display = "";
  private displayNumber = 0;
  private sink = "";
  private sinkModule: string | null = null;
  private xvfb: Running | null = null;
  private ffmpeg: Running | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private failedSince: number | null = null;
  private stopPromise: Promise<SessionResult | null> | null = null;
  private resolveEnded!: (reason: EndReason) => void;
  private endedFlag = false;

  /** Resolves once, with the reason the recording should stop. */
  readonly ended: Promise<EndReason> = new Promise((resolve) => {
    this.resolveEnded = resolve;
  });

  readonly fragPath: string;
  readonly finalPath: string;

  constructor(
    private readonly request: JobRequest,
    private readonly config: Config,
    private readonly log: Logger,
  ) {
    this.fragPath = join(config.SPOOL_DIR, `${request.jobId}.frag.mp4`);
    this.finalPath = join(config.SPOOL_DIR, `${request.jobId}.mp4`);
  }

  async start(): Promise<void> {
    const { config, log } = this;
    this.displayNumber = allocateDisplay();
    this.display = `:${this.displayNumber}`;
    this.sink = `rec_${this.displayNumber}`;
    try {
      // 1. A virtual screen.
      this.xvfb = run("Xvfb", [this.display, "-screen", "0", `${config.VIDEO_WIDTH}x${config.VIDEO_HEIGHT}x24`, "-nolisten", "tcp", "-ac"], log);
      void this.xvfb.exited.then(() => this.end("xvfb-exited"));
      await waitFor(() => existsSync(`/tmp/.X11-unix/X${this.displayNumber}`), 8_000, "the virtual screen");

      // 2. A virtual sound card. The browser plays into it, ffmpeg listens to it.
      this.sinkModule = await output("pactl", ["load-module", "module-null-sink", `sink_name=${this.sink}`]);

      // 3. A browser pointed at the class.
      this.browser = await chromium.launch({
        executablePath: config.CHROMIUM_PATH,
        headless: false,
        env: { ...process.env, DISPLAY: this.display, PULSE_SINK: this.sink } as Record<string, string>,
        ignoreDefaultArgs: ["--enable-automation", "--mute-audio"],
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--kiosk",
          `--window-size=${config.VIDEO_WIDTH},${config.VIDEO_HEIGHT}`,
          "--window-position=0,0",
          "--force-device-scale-factor=1",
          "--autoplay-policy=no-user-gesture-required",
          "--disable-infobars",
          "--hide-scrollbars",
          "--no-first-run",
          "--disable-features=Translate",
        ],
      });
      this.browser.on("disconnected", () => this.end("page-crashed"));
      const context = await this.browser.newContext({ viewport: null });
      this.page = await context.newPage();
      this.page.on("pageerror", (error) => log.warn("page error", { error: String(error).slice(0, 300) }));
      this.page.on("crash", () => this.end("page-crashed"));
      await this.page.goto(pageUrlWithCredentials(this.request), { waitUntil: "domcontentloaded", timeout: 30_000 });

      // 4. Do not film a blank screen: wait until the page has really joined.
      await waitFor(async () => (await this.pageState()) === "connected", 45_000, "the page to join the room");

      // 5. Roll tape.
      this.ffmpeg = run(
        "ffmpeg",
        captureArgs({
          display: this.display,
          audioSource: `${this.sink}.monitor`,
          width: config.VIDEO_WIDTH,
          height: config.VIDEO_HEIGHT,
          fps: config.VIDEO_FPS,
          crf: config.VIDEO_CRF,
          output: this.fragPath,
        }),
        log,
      );
      void this.ffmpeg.exited.then(() => this.end("ffmpeg-exited"));
      this.startedAt = Date.now();
      this.watch();
    } catch (error) {
      log.error("session failed to start", { error: String(error) });
      await this.stop();
      throw error;
    }
  }

  private async pageState(): Promise<PageState | null> {
    if (!this.page) return null;
    try {
      return await this.page.evaluate(() => (window as unknown as { __recorder?: { state?: string } }).__recorder?.state as PageState | undefined) ?? null;
    } catch {
      return null;
    }
  }

  private end(reason: EndReason): void {
    if (this.endedFlag) return;
    this.endedFlag = true;
    this.log.info("session ending", { reason });
    this.resolveEnded(reason);
  }

  /** Ask the session to wind up (used by the LMS "stop" call and by shutdown). */
  requestStop(reason: EndReason = "stopped-by-lms"): void {
    this.end(reason);
  }

  private watch(): void {
    const maxMs = (this.request.maxMinutes ?? this.config.MAX_JOB_MINUTES) * 60_000;
    this.timer = setInterval(() => {
      void (async () => {
        if (this.endedFlag) return;
        if (Date.now() - this.startedAt > maxMs) return this.end("max-duration");
        const state = await this.pageState();
        if (state === "ended") return this.end("room-ended");
        if (state === "failed") {
          // A blip while the room reconnects is fine; a minute of it is not.
          this.failedSince ??= Date.now();
          if (Date.now() - this.failedSince > 60_000) this.end("page-failed");
        } else if (state === null) {
          this.failedSince ??= Date.now();
          if (Date.now() - this.failedSince > 20_000) this.end("page-crashed");
        } else {
          this.failedSince = null;
        }
      })();
    }, 2_000);
  }

  /** Idempotent teardown. Returns the finished file, or null if there is nothing usable. */
  stop(): Promise<SessionResult | null> {
    this.stopPromise ??= this.teardown();
    return this.stopPromise;
  }

  private async teardown(): Promise<SessionResult | null> {
    const { log } = this;
    if (this.timer) clearInterval(this.timer);
    this.end("stopped-by-lms"); // no-op if already ended; unblocks anyone waiting

    // Let ffmpeg finish its last fragment properly.
    if (this.ffmpeg) {
      try {
        this.ffmpeg.child.stdin?.write("q");
      } catch {
        /* already gone */
      }
      const exited = await Promise.race([this.ffmpeg.exited.then(() => true), sleep(30_000).then(() => false)]);
      if (!exited) {
        log.warn("ffmpeg did not exit, killing");
        this.ffmpeg.child.kill("SIGKILL");
      }
    }

    await this.browser?.close().catch(() => undefined);
    if (this.sinkModule) await output("pactl", ["unload-module", this.sinkModule]).catch(() => undefined);
    this.xvfb?.child.kill("SIGTERM");
    usedDisplays.delete(this.displayNumber);

    if (!existsSync(this.fragPath)) return null;
    return finalizeFragment(this.fragPath, this.finalPath, log);
  }
}

/**
 * Turn the crash-safe fragmented capture into a normal seekable MP4.
 * If the remux fails, the fragmented file is still perfectly playable, so we
 * fall back to it rather than lose the class.
 */
export async function finalizeFragment(fragPath: string, finalPath: string, log: Logger): Promise<SessionResult | null> {
  let path = fragPath;
  try {
    await output("ffmpeg", remuxArgs(fragPath, finalPath), 10 * 60_000);
    path = finalPath;
  } catch (error) {
    log.warn("remux failed, using fragmented file", { error: String(error) });
  }

  let sizeBytes = 0;
  try {
    sizeBytes = (await stat(path)).size;
  } catch {
    return null;
  }
  if (sizeBytes < 10_000) return null; // nothing but a header

  let durationSeconds = 0;
  try {
    durationSeconds = Math.round(Number(await output("ffprobe", probeArgs(path))));
  } catch (error) {
    log.warn("could not probe duration", { error: String(error) });
  }
  return { path, durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0, sizeBytes };
}
