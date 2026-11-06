import { chromium } from 'playwright-core';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { delimiter, join } from 'node:path';
async function browserPath(): Promise<string | undefined> {
  const candidates = [process.env.CTX_BROWSER_EXECUTABLE, chromium.executablePath(), ...process.env.PATH?.split(delimiter).flatMap(path => ['chromium', 'chromium-browser', 'google-chrome'].map(name => join(path, name))) ?? []];
  for (const path of candidates) if (path) { try { await access(path); return path; } catch {} }
}
const executablePath = await browserPath();
if (!executablePath) { console.log('Browser smoke unavailable: no installed Chromium executable. No browser was downloaded. Syntax checking does not verify gameplay.'); process.exitCode = 78; }
else {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true, timeout: 15_000 });
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    await context.route(/^https?:\/\//, route => route.abort());
    await context.routeWebSocket(/.*/, socket => socket.close());
    const page = await context.newPage(); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(process.argv[2]).href, { waitUntil: 'load', timeout: 15_000 });
    await page.keyboard.press('Space'); await page.waitForTimeout(500);
    const rendered = await page.evaluate(() => !!document.body && (!!document.body.children.length || !!document.body.textContent?.trim()));
    if (!rendered || errors.length) throw new Error(`Browser smoke failed: ${JSON.stringify({ rendered, errors })}`);
    console.log(`Browser smoke passed in Chromium ${browser.version()}: document loaded, rendered content exists, Space input dispatched, no uncaught page errors observed. HTTP(S) requests and WebSockets were blocked. Full gameplay, scoring, collision behavior and visual correctness remain unverified.`);
    await page.screenshot({ path: process.argv[3] }); console.log(`Screenshot evidence: ${process.argv[3]}`);
  } catch (error) { console.error(String(error)); process.exitCode = /Executable doesn't exist|host system is missing|sandbox|browserType.launch/i.test(String(error)) ? 78 : 1; }
  finally { await browser?.close(); }
}
