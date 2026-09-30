// Runs INSIDE a container: opens the fake-tutor page in Chromium with fake
// camera/microphone devices, stays for N seconds, then leaves (which empties the room).
//   node fixtures/publisher-run.mjs <pageUrl> <seconds>
import { chromium } from "playwright-core";

const [pageUrl, secondsArg] = process.argv.slice(2);
const seconds = Number(secondsArg || 60);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext();
const page = await context.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[publisher page]", m.text().slice(0, 200)); });
await page.goto(pageUrl, { waitUntil: "domcontentloaded" });

for (let i = 0; i < 40; i++) {
  const state = await page.evaluate(() => window.__publisher?.state).catch(() => null);
  if (state === "publishing") break;
  if (state === "failed") { console.log("publisher: FAILED to join"); process.exit(2); }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`publisher: publishing for ${seconds}s`);
await new Promise((r) => setTimeout(r, seconds * 1000));
await browser.close();
console.log("publisher: left the room");
