import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const destination = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(destination, "../../../../..");
const { chromium } = await import(
  pathToFileURL(
    path.join(
      root,
      "node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.mjs",
    ),
  )
);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage({
  viewport: { width: 1664, height: 1664 },
  deviceScaleFactor: 1,
});
const names = ["inbox", "pull-requests", "source-control"];
const dataUrl = async (file) =>
  "data:image/png;base64," + (await fs.readFile(file)).toString("base64");
try {
  for (const [index, name] of names.entries()) {
    const background = await dataUrl(path.join(destination, `background-${index + 1}.png`));
    const capture = await dataUrl(path.join(destination, "..", `${name}-frame.png`));
    await page.setContent(`<style>
      * { box-sizing:border-box }
      html,body { margin:0;width:1664px;height:1664px;overflow:hidden }
      body { background-image:url('${background}');background-size:1664px 1664px }
      img { position:absolute;left:32px;top:365px;width:1600px;height:934px;
        border-radius:14px;box-shadow:0 22px 60px #07192f66 }
    </style><img src="${capture}">`);
    await page.locator("img").evaluate((image) => image.decode());
    await page.screenshot({ path: path.join(destination, `${index + 1}-${name}.png`) });
  }
} finally {
  await browser.close();
}
