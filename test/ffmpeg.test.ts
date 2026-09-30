import { describe, expect, it } from "vitest";
import { AUDIO_QUEUE_PACKETS, VIDEO_QUEUE_FRAMES, captureArgs, remuxArgs } from "../src/ffmpeg.js";

const options = {
  preset: "veryfast",
  display: ":101",
  audioSource: "rec_101.monitor",
  width: 1280,
  height: 720,
  fps: 24,
  crf: 22,
  output: "/data/spool/job.frag.mp4",
};

describe("capture command", () => {
  const args = captureArgs(options);
  const after = (flag: string) => args[args.indexOf(flag) + 1];

  it("records the right screen and sound card at the right size", () => {
    expect(args).toContain(":101.0");
    expect(args).toContain("rec_101.monitor");
    expect(after("-video_size")).toBe("1280x720");
    expect(after("-framerate")).toBe("24");
  });

  it("writes a crash-safe fragmented file", () => {
    expect(after("-movflags")).toContain("frag_keyframe");
    expect(after("-movflags")).toContain("empty_moov");
  });

  it("keeps sound in step with picture", () => {
    expect(args.filter((arg) => arg === "-use_wallclock_as_timestamps")).toHaveLength(2);
    expect(after("-af")).toContain("aresample=async=1");
  });

  it("bounds the raw-frame queue so a slow encoder cannot eat all the memory", () => {
    // Raw 720p frames are ~3.7 MB each. The 30-minute soak test killed a container at 1024 frames.
    const queues = args.flatMap((arg, i) => (arg === "-thread_queue_size" ? [Number(args[i + 1])] : []));
    expect(queues).toHaveLength(2);
    expect(VIDEO_QUEUE_FRAMES * 1280 * 720 * 4).toBeLessThan(300 * 1024 * 1024); // < 300 MB worst case
    expect(queues[0]).toBe(VIDEO_QUEUE_FRAMES);
    expect(queues[1]).toBe(AUDIO_QUEUE_PACKETS);
  });

  it("uses the configured x264 preset", () => {
    expect(captureArgs({ ...options, preset: "ultrafast" })[captureArgs({ ...options, preset: "ultrafast" }).indexOf("-preset") + 1]).toBe("ultrafast");
  });

  it("puts a keyframe every two seconds so seeking is quick", () => {
    expect(after("-g")).toBe("48");
  });

  it("ends with the output path", () => {
    expect(args.at(-1)).toBe(options.output);
  });
});

describe("remux command", () => {
  it("copies streams (no re-encode) and moves the index to the front", () => {
    const args = remuxArgs("in.mp4", "out.mp4");
    expect(args).toContain("copy");
    expect(args).toContain("+faststart");
    expect(args.at(-1)).toBe("out.mp4");
  });
});
