import { z } from "zod";

const origins = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((entry) => entry.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  );

const schema = z.object({
  PORT: z.coerce.number().int().default(8787),
  RECORDER_SHARED_SECRET: z.string().min(32, "RECORDER_SHARED_SECRET must be at least 32 characters"),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).default(2),
  MAX_JOB_MINUTES: z.coerce.number().int().min(1).default(240),
  SPOOL_DIR: z.string().default("/data/spool"),
  CHROMIUM_PATH: z.string().default("/usr/bin/chromium"),
  ALLOWED_PAGE_ORIGINS: origins,
  ALLOWED_CALLBACK_ORIGINS: origins,
  VIDEO_WIDTH: z.coerce.number().int().default(1280),
  VIDEO_HEIGHT: z.coerce.number().int().default(720),
  VIDEO_FPS: z.coerce.number().int().min(10).max(60).default(24),
  VIDEO_CRF: z.coerce.number().int().min(15).max(35).default(22),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET: z.string().optional(),
  LOCAL_OUTPUT_DIR: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Blank strings in a .env file mean "unset", not "empty value".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid recorder configuration — ${problems}`);
  }
  const config = parsed.data;
  const hasS3 = config.S3_BUCKET && config.S3_ACCESS_KEY && config.S3_SECRET;
  if (!hasS3 && !config.LOCAL_OUTPUT_DIR) {
    throw new Error("Invalid recorder configuration — set S3_BUCKET/S3_ACCESS_KEY/S3_SECRET or LOCAL_OUTPUT_DIR");
  }
  return config;
}
