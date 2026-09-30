import { spawn, type ChildProcess } from "node:child_process";
import type { Logger } from "./log.js";

export type Running = {
  child: ChildProcess;
  /** Resolves with the exit code (null when killed by a signal). */
  exited: Promise<number | null>;
};

/** Spawn a long-running helper (Xvfb, ffmpeg…) and pipe its stderr into our log. */
export function run(command: string, args: string[], log: Logger, env: NodeJS.ProcessEnv = process.env): Running {
  const child = spawn(command, args, { env, stdio: ["pipe", "ignore", "pipe"] });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log.warn(`${command}: ${text.slice(0, 500)}`);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", (error) => {
      log.error(`${command} failed to start`, { error: String(error) });
      resolve(-1);
    });
    child.on("exit", (code) => resolve(code));
  });
  return { child, exited };
}

/** Run a short command to completion and return its stdout. Rejects on non-zero exit. */
export function output(command: string, args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${command} exited ${code}: ${err.trim().slice(0, 400)}`));
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
