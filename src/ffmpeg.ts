export type CaptureOptions = {
  display: string; // e.g. ":101"
  audioSource: string; // PulseAudio monitor, e.g. "rec_101.monitor"
  width: number;
  height: number;
  fps: number;
  crf: number;
  output: string;
};

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
  const { display, audioSource, width, height, fps, crf, output } = options;
  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-y",
    // picture (the deep input queue stops a busy CPU dropping frames)
    "-thread_queue_size", "1024",
    "-use_wallclock_as_timestamps", "1",
    "-f", "x11grab",
    "-framerate", String(fps),
    "-video_size", `${width}x${height}`,
    "-draw_mouse", "0",
    "-i", `${display}.0`,
    // sound
    "-thread_queue_size", "1024",
    "-use_wallclock_as_timestamps", "1",
    "-f", "pulse",
    "-i", audioSource,
    // encode
    "-c:v", "libx264",
    "-preset", "veryfast",
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
