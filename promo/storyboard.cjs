const { chromium } = require("playwright");
const sharp = require("sharp");
const { mkdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const output = resolve(process.argv[2] || resolve(__dirname, "rendered/storyboard.png"));
const frameNumbers = [24, 126, 174, 204, 264, 342];
const language = process.env.PROMO_LANG === "zh" ? "zh" : "en";

(async () => {
  mkdirSync(resolve(output, ".."), { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const sourceUrl = pathToFileURL(resolve(__dirname, "index.html"));
  if (language === "zh") sourceUrl.searchParams.set("lang", "zh");
  await page.goto(sourceUrl.href);
  await page.evaluate(() => document.fonts.ready);
  const tiles = [];
  for (const frame of frameNumbers) {
    await page.evaluate((value) => window.setFrame(value), frame);
    const buffer = await page.screenshot({ type: "png" });
    tiles.push(await sharp(buffer).resize(640, 360).png().toBuffer());
  }
  await browser.close();
  const canvas = sharp({ create: { width: 1920, height: 720, channels: 3, background: "#07110c" } });
  await canvas.composite(tiles.map((input, index) => ({ input, left: (index % 3) * 640, top: Math.floor(index / 3) * 360 }))).png().toFile(output);
  process.stdout.write(`${output}\n`);
})().catch((error) => { console.error(error); process.exit(1); });
