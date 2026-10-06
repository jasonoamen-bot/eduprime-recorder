import { describe, expect, it } from "vitest";
import { SCHEDULER_TAG, SCHEDULER_TYPE, buildSchedulerUserData } from "../src/fleet/scheduler.js";

const ok = {
  sourceUrl: "https://s3.example.com/source.tgz?X-Amz-Signature=abc",
  dotEnv: `LINODE_TOKEN=${"t".repeat(64)}\nS3_BUCKET=easyway-recordings\nLMS_FORECAST_URL=https://school.example/api/recorder/forecast\n`,
  recorderEnv: `RECORDER_SHARED_SECRET=${"a".repeat(64)}\nS3_BUCKET=easyway-recordings\n`,
};
const decode = (text: string, path: string) => {
  const block = new RegExp(`path: ${path.replace(/[./]/g, "\\$&")}\\n\\s+permissions: '\\d+'\\n\\s+encoding: b64\\n\\s+content: (\\S+)`).exec(text);
  return block ? Buffer.from(block[1]!, "base64").toString() : null;
};

describe("the scheduler server", () => {
  it("is tagged separately from recorder servers, so the fleet never deletes it, and uses the smallest size", () => {
    expect(SCHEDULER_TAG).toBe("eduprime-scheduler");
    expect(SCHEDULER_TAG).not.toBe("eduprime-recorder");
    expect(SCHEDULER_TYPE).toBe("g6-nanode-1");
  });

  it("runs the fleet pass every minute and installs what that needs", () => {
    const text = buildSchedulerUserData(ok);
    expect(text.startsWith("#cloud-config\n")).toBe(true);
    expect(text).toContain("* * * * * root cd /opt/fleet");
    expect(text).not.toContain("*/5 * * * *");
    expect(text).toContain("tick --apply");
    for (const piece of ["setup_22.x", "npm ci", "ufw --force enable"]) expect(text).toContain(piece);
  });

  it("carries the token and settings encoded, never in the clear", () => {
    const text = buildSchedulerUserData(ok);
    expect(text).not.toContain("LINODE_TOKEN");
    expect(text).not.toContain("tttttttt");
    expect(decode(text, "/opt/fleet/.env")).toContain("LMS_FORECAST_URL=https://school.example/api/recorder/forecast");
    expect(decode(text, "/opt/fleet/deploy/prod.env")).toContain("RECORDER_SHARED_SECRET=");
  });

  it("points the settings at where the recorder file is placed on that machine", () => {
    expect(decode(buildSchedulerUserData({ ...ok, dotEnv: ok.dotEnv + "FLEET_RECORDER_ENV_FILE=C:/somewhere/else.env\n" }), "/opt/fleet/.env")).toMatch(/FLEET_RECORDER_ENV_FILE=deploy\/prod\.env\n$/);
  });

  it("can start paused: it deletes but never creates", () => {
    expect(decode(buildSchedulerUserData({ ...ok, pauseCreates: true }), "/opt/fleet/.env")).toContain("FLEET_PAUSE_CREATES=1");
    expect(decode(buildSchedulerUserData(ok), "/opt/fleet/.env")).not.toContain("FLEET_PAUSE_CREATES");
  });

  it("refuses an insecure link and missing credentials", () => {
    expect(() => buildSchedulerUserData({ ...ok, sourceUrl: "http://x" })).toThrow(/https/);
    expect(() => buildSchedulerUserData({ ...ok, dotEnv: "S3_BUCKET=x\n" })).toThrow(/LINODE_TOKEN/);
    expect(() => buildSchedulerUserData({ ...ok, recorderEnv: "RECORDER_SHARED_SECRET=short" })).toThrow(/SHARED_SECRET/);
  });
});
