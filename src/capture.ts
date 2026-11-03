// Screenshots each page at every viewport and color scheme in a hidden browser,
// and records the hard failures a user would hit: console errors, failed
// requests, and pages that scroll sideways.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import sharp from 'sharp';
import type { Config } from './config.ts';
import type { Route } from './routes.ts';

export interface Shot {
  id: string;
  route: string;
  url: string;
  viewport: string;
  scheme: 'light' | 'dark';
  /** Absolute path, or null when the page could not be loaded. */
  file: string | null;
  loadError: string | null;
  consoleErrors: string[];
  failedRequests: string[];
  /** How far the page scrolls sideways, in CSS pixels. 0 is correct. */
  overflowX: number;
}

export function shotId(route: string, viewport: string, scheme: string): string {
  const slug = route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^A-Za-z0-9]+/g, '-');
  return `${slug}.${viewport}.${scheme}`;
}

// Hides the Next.js dev badge and toasts so they never show up as a difference.
const HIDE_DEV_UI = 'nextjs-portal, [data-nextjs-toast], #__next-build-watcher { display: none !important; }';

export async function captureAll(
  browser: Browser,
  baseUrl: string,
  routes: Route[],
  cfg: Config,
  outDir: string,
  deadline: number,
): Promise<Shot[]> {
  mkdirSync(outDir, { recursive: true });
  const shots: Shot[] = [];
  for (const vp of cfg.viewports) {
    for (const scheme of cfg.schemes) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: scheme,
        reducedMotion: 'reduce',
        deviceScaleFactor: 1,
        isMobile: vp.width < 600,
        hasTouch: vp.width < 600,
      });
      try {
        for (const r of routes) {
          shots.push(await captureOne(ctx, baseUrl, r, vp.name, scheme, cfg, outDir, deadline));
        }
      } finally {
        await ctx.close();
      }
    }
  }
  return shots;
}

async function captureOne(
  ctx: BrowserContext,
  baseUrl: string,
  route: Route,
  viewport: string,
  scheme: 'light' | 'dark',
  cfg: Config,
  outDir: string,
  deadline: number,
): Promise<Shot> {
  const id = shotId(route.pattern, viewport, scheme);
  const shot: Shot = { id, route: route.pattern, url: route.url, viewport, scheme, file: null, loadError: null, consoleErrors: [], failedRequests: [], overflowX: 0 };
  const left = deadline - Date.now();
  if (left < 5000) {
    shot.loadError = 'Ran out of time before this page.';
    return shot;
  }
  const page = await ctx.newPage();
  const origin = new URL(baseUrl).origin;
  page.on('console', (m) => {
    if (m.type() === 'error') shot.consoleErrors.push(normalize(m.text(), origin));
  });
  page.on('pageerror', (e) => shot.consoleErrors.push(normalize(String(e.message ?? e), origin)));
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? 'failed';
    if (!/ERR_ABORTED/.test(why)) shot.failedRequests.push(`${r.method()} ${normalize(r.url(), origin)} (${why})`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400 && !res.url().includes('/__nextjs')) shot.failedRequests.push(`${res.request().method()} ${normalize(res.url(), origin)} (${res.status()})`);
  });
  try {
    await page.clock.setFixedTime(new Date(cfg.fixedTime));
    const res = await page.goto(baseUrl + route.url, { waitUntil: 'load', timeout: Math.min(90_000, left) });
    if (res && res.status() >= 400) shot.loadError = `Page returned HTTP ${res.status()}.`;
    await page.waitForLoadState('networkidle', { timeout: Math.min(10_000, Math.max(1000, deadline - Date.now())) }).catch(() => {});
    await page.addStyleTag({ content: HIDE_DEV_UI });
    await page.evaluate(() => document.fonts?.ready);
    await page.waitForTimeout(400);
    // Compare with the device width, not window.innerWidth: a phone browser zooms out
    // to fit wide content, which grows innerWidth and hides the overflow.
    const deviceWidth = page.viewportSize()!.width;
    shot.overflowX = await page.evaluate((w) => Math.max(0, document.documentElement.scrollWidth - w), deviceWidth);
    const png = await page.screenshot({
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      mask: cfg.mask.map((s) => page.locator(s)),
    });
    const file = join(outDir, `${id}.png`);
    const meta = await sharp(png).metadata();
    await sharp(png)
      .extract({ left: 0, top: 0, width: meta.width!, height: Math.min(meta.height!, cfg.maxShotHeight) })
      .toFile(file);
    shot.file = file;
  } catch (e: any) {
    shot.loadError = String(e?.message ?? e).split('\n')[0];
  } finally {
    await page.close();
  }
  return shot;
}

/** Strips the per-copy port so the same error in both copies compares equal. */
function normalize(text: string, origin: string): string {
  return text.replaceAll(origin, '').replace(/127\.0\.0\.1:\d+/g, 'localhost').slice(0, 500);
}
