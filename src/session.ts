import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Config } from "./config.js";
import { allocateDisplay, releaseDisplay } from "./displays.js";
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

/**
 * Reasons that mean the recording stopped but the CLASS IS STILL GOING: a crash, a
 * stall, or hitting our own length cap. Anything else ("room-ended", "stopped-by-lms")
 * is a real end. The LMS uses this to tell "class over" from "we lost the camera" — it
 * restarts a recording for a live class on the tutor's next heartbeat, but the
 * interrupted part must never be reported as a clean finish.
 */
export const INTERRUPTION_REASONS: ReadonlySet<EndReason> = new Set<EndReason>([
  "max-duration",
  "page-failed",
  "page-crashed",
  "ffmpeg-exited",
  "xvfb-exited",
  "start-failed",
]);

export const isInterruption = (reason: string | undefined): boolean => INTERRUPTION_REASONS.has(reason as EndReason);

export type SessionResult = { path: string; durationSeconds: number; sizeBytes: number };

/** Thrown when a stop was requested while still starting up: not a failure, do not retry. */
export class StartCancelled extends Error {
  constructor() {
    super("start cancelled by a stop request");
  }
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  what: string,
  cancelled: () => boolean = () => false,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cancelled()) throw new StartCancelled();
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
  private chromium: Running | null = null;
  private browser: Browser | null = null;
  private userDataDir: string | null = null;
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
      //
      // `--app=` opens a CHROMELESS window: no tabs, no address bar. That matters
      // twice over: the recording is only the class, and the address bar would
      // otherwise show the room token to every student who watches the replay.
      // (`--kiosk` does nothing here: there is no window manager on the virtual
      // screen to make the window fullscreen.)
      //
      // We start Chromium OURSELVES rather than through Playwright: Playwright
      // ignores `--app` and opens a normal window, address bar and all. It
      // attaches afterwards over the debugging port, only to read page state.
      this.userDataDir = join(config.SPOOL_DIR, `chrome-${this.request.jobId}`);
      const debugPort = 9000 + this.displayNumber;
      // `nice -n 5`: under CPU pressure the OS now favours the capture (ffmpeg, Xvfb) over
      // the browser. A starved page shows a stale picture for a moment; a starved encoder
      // piles up frames and takes the whole recording down. `nice` replaces itself with
      // Chromium, so the process we track and kill is still the browser.
      this.chromium = run(
        "nice",
        [
          "-n", "5",
          config.CHROMIUM_PATH,
          // Chromium only treats `--app` as an app window for a real URL; the
          // blank page is silently opened as a normal tabbed window.
          "--app=data:text/html,<title>recorder</title><body style='background:%230b0b0e'>",
          `--user-data-dir=${this.userDataDir}`,
          `--remote-debugging-port=${debugPort}`,
          "--no-sandbox",
          "--test-type", // silences the "unsupported flag: --no-sandbox" banner
          "--disable-dev-shm-usage",
          `--window-size=${config.VIDEO_WIDTH},${config.VIDEO_HEIGHT}`,
          "--window-position=0,0",
          "--force-device-scale-factor=1",
          "--autoplay-policy=no-user-gesture-required",
          "--disable-infobars",
          "--hide-scrollbars",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-features=Translate",
          ...config.CHROMIUM_EXTRA_ARGS.split(/\s+/).filter(Boolean),
        ],
        log,
        { ...process.env, DISPLAY: this.display, PULSE_SINK: this.sink },
      );
      void this.chromium.exited.then(() => this.end("page-crashed"));
      await waitFor(
        async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`).catch(() => null))?.ok === true,
        20_000,
        "the browser to start",
        () => this.endedFlag,
      );
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      const context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.page = context.pages()[0] ?? (await context.waitForEvent("page"));
      this.page.on("pageerror", (error) => log.warn("page error", { error: String(error).slice(0, 300) }));
      // What the class page says to itself is the first place to look when a
      // recording comes out wrong, so keep its warnings and errors in our log.
      this.page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          log.warn("page console", { type: message.type(), text: message.text().slice(0, 300) });
        }
      });
      this.page.on("crash", () => this.end("page-crashed"));
      await this.page.goto(pageUrlWithCredentials(this.request), { waitUntil: "domcontentloaded", timeout: 30_000 });

      // 4. Do not film a blank screen: wait until the page has really joined.
      await waitFor(
        async () => (await this.pageState()) === "connected",
        config.PAGE_JOIN_TIMEOUT_SECONDS * 1000,
        "the page to join the room",
        () => this.endedFlag,
      );

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
          preset: config.VIDEO_PRESET,
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
    let tick = 0;
    this.timer = setInterval(() => {
      void (async () => {
        if (this.endedFlag) return;
        // Every ~10s, a snapshot of what the page believes: cheap, and it turns
        // "the recording is blank" from a mystery into a log line.
        if (++tick % 5 === 0 && this.page) {
          const snapshot = await this.page
            .evaluate(() => JSON.stringify((window as unknown as { __recorder?: unknown }).__recorder ?? null))
            .catch(() => null);
          this.log.info("page snapshot", { snapshot });
        }
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

    await this.browser?.close().catch(() => undefined); // detaches; does not stop the process
    if (this.chromium) {
      this.chromium.child.kill("SIGTERM");
      const gone = await Promise.race([this.chromium.exited.then(() => true), sleep(5_000).then(() => false)]);
      if (!gone) this.chromium.child.kill("SIGKILL");
    }
    if (this.userDataDir) await rm(this.userDataDir, { recursive: true, force: true }).catch(() => undefined);
    if (this.sinkModule) await output("pactl", ["unload-module", this.sinkModule]).catch(() => undefined);
    if (this.xvfb) {
      // Wait for it to really be gone before the number can be reused, and clear
      // the lock files a hard kill leaves behind.
      this.xvfb.child.kill("SIGTERM");
      const gone = await Promise.race([this.xvfb.exited.then(() => true), sleep(5_000).then(() => false)]);
      if (!gone) this.xvfb.child.kill("SIGKILL");
      await rm(`/tmp/.X${this.displayNumber}-lock`, { force: true }).catch(() => undefined);
      await rm(`/tmp/.X11-unix/X${this.displayNumber}`, { force: true }).catch(() => undefined);
    }
    if (this.displayNumber) releaseDisplay(this.displayNumber);

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
