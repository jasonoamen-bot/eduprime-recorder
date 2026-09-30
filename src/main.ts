import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { JobManager } from "./manager.js";
import { createApp } from "./server.js";
import { createStorage } from "./storage.js";

async function main(): Promise<void> {
  const log = createLogger({ svc: "recorder" });
  const config = loadConfig();
  const manager = new JobManager(config, createStorage(config, log), log);
  await manager.init();

  const server = createApp(config, manager, log);
  server.listen(config.PORT, () => {
    log.info("recorder listening", { port: config.PORT, capacity: config.MAX_CONCURRENT_JOBS });
  });

  // `docker stop` sends SIGTERM: stop taking work, finish and upload what is running.
  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info("shutting down", { signal });
    server.close();
    await manager.shutdown();
    process.exit(0);
  };
  process.on("SIGTERM", () => void close("SIGTERM"));
  process.on("SIGINT", () => void close("SIGINT"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
