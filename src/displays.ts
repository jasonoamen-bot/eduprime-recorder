/**
 * Virtual-screen numbers. Every concurrent recording needs its own X display.
 *
 * WHY ROUND-ROBIN and not "lowest free number": when a start attempt fails and
 * is retried straight away, the dying Xvfb of the first attempt may still hold
 * `/tmp/.X101-lock` for a moment. Handing the retry the SAME number (which
 * lowest-free does, instantly) collided with it: "Server is already active for
 * display 101". Moving on to a fresh number each time makes that collision
 * impossible, whatever the timing.
 */
const FIRST = 101;
const COUNT = 99; // 101..199

const inUse = new Set<number>();
let cursor = 0;

export function allocateDisplay(): number {
  for (let step = 0; step < COUNT; step++) {
    const n = FIRST + ((cursor + step) % COUNT);
    if (!inUse.has(n)) {
      inUse.add(n);
      cursor = (cursor + step + 1) % COUNT;
      return n;
    }
  }
  throw new Error("no free display numbers");
}

export function releaseDisplay(n: number): void {
  inUse.delete(n);
}

/** Test hook. */
export function resetDisplays(): void {
  inUse.clear();
  cursor = 0;
}
