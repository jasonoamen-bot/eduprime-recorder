export type CaptureOptions = {
  display: string; // e.g. ":101"
  audioSource: string; // PulseAudio monitor, e.g. "rec_101.monitor"
  width: number;
  height: number;
  fps: number;
  crf: number;
  /** x264 speed/size trade-off. Faster = less CPU per frame, bigger file at the same quality (CRF). */
  preset: string;
  output: string;
};

/**
 * HOW MANY RAW FRAMES MAY WAIT FOR THE ENCODER.
 *
 * Every frame from the screen grabber is raw: 1280x720x4 bytes = 3.7 MB. A queue
 * of 1024 (what this used to be, to "stop dropping frames") is 3.8 GB of RAM if
 * the encoder ever falls behind — which a busy machine guarantees sooner or
 * later. The 30-minute soak test proved it: memory climbed from 450 MB to the
 * container limit in under two minutes and the kernel killed the recording.
 * 64 frames is under a quarter of a gigabyte and ~2.7 s of slack at 24 fps: enough
 * to ride out a hiccup, and a hard ceiling when the encoder cannot keep up
 * (frames are then skipped, not hoarded).
 */
export const VIDEO_QUEUE_FRAMES = 64;
// Audio packets are tiny (a few KB), so a deep queue costs almost nothing and keeps the voice gap-free.
export const AUDIO_QUEUE_PACKETS = 512;

/**
 * Live capture: screen + system audio -> fragmented MP4.
 *
 * WHY FRAGMENTED: a normal MP4 keeps its index at the end of the file, so a
 * crash mid-class leaves an unplayable file and the whole lesson is lost. A
 * fragmented MP4 is playable up to the last fragment, whatever happens. On a
 * clean finish we remux into a normal seekable MP4 (see `remuxArgs`).
 *
 * `-use_wallclock_as_timestamps` on both inputs + `aresample=async=1` keeps
 * picture and voice in step even when the CPU stutters for a second.
 */
export function captureArgs(options: CaptureOptions): string[] {
  const { display, audioSource, width, height, fps, crf, preset, output } = options;
  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-y",
    // picture (bounded: see VIDEO_QUEUE_FRAMES)
    "-thread_queue_size", String(VIDEO_QUEUE_FRAMES),
    "-use_wallclock_as_timestamps", "1",
    "-f", "x11grab",
    "-framerate", String(fps),
    "-video_size", `${width}x${height}`,
    "-draw_mouse", "0",
    "-i", `${display}.0`,
    // sound
    "-thread_queue_size", String(AUDIO_QUEUE_PACKETS),
    "-use_wallclock_as_timestamps", "1",
    "-f", "pulse",
    "-i", audioSource,
    // encode
    "-c:v", "libx264",
    "-preset", preset,
    "-tune", "zerolatency",
    "-crf", String(crf),
    "-pix_fmt", "yuv420p",
    "-g", String(fps * 2),
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
    "-af", "aresample=async=1:first_pts=0",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    output,
  ];
}

/** Clean finish: same streams, proper index at the front, so seeking is instant. */
export function remuxArgs(input: string, output: string): string[] {
  return ["-hide_banner", "-loglevel", "warning", "-y", "-i", input, "-c", "copy", "-movflags", "+faststart", output];
}

/** ffprobe duration in seconds — used to check the file before we upload it. */
export function probeArgs(input: string): string[] {
  return ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input];
}
