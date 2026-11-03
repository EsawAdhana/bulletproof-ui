// One full check: what changed, plain code checks, which pages render it,
// before/after screenshots, pixel diff, the judge, and the decision.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { addedLines, fastChecks, isUiFile, type CodeFinding } from './checks.ts';
import { captureAll, type Shot } from './capture.ts';
import type { Config } from './config.ts';
import { startDevServer, type DevServer } from './devserver.ts';
import { diffPair } from './pixeldiff.ts';
import { readTaste, runJudge, type JudgeFinding, type JudgeShot } from './judge.ts';
import type { Repo } from './repo.ts';
import { writeReview } from './review.ts';
import { affectedRoutes, type Route } from './routes.ts';
import { changedSince, materialize, sessionDiff } from './snapshot.ts';

export interface HardFailure {
  shot: string | null;
  problem: string;
  fix: string;
}

export interface ShotPair {
  id: string;
  route: string;
  viewport: string;
  scheme: string;
  before: string | null;
  after: string | null;
  side: string | null;
  diff: string | null;
  changedPercent: number;
}

export interface RunResult {
  id: string;
  runDir: string;
  startedAt: string;
  ms: number;
  status: 'skipped' | 'pass' | 'block';
  request: string;
  changed: string[];
  uiFiles: string[];
  routes: Route[];
  notChecked: string[];
  codeFindings: CodeFinding[];
  hardFailures: HardFailure[];
  judge: { findings: JudgeFinding[]; reviewed: string[]; summary: string; error: string | null; costUsd: number | null; ms: number } | null;
  shots: ShotPair[];
  reviewPath: string | null;
  timings: Record<string, number>;
}

export interface CheckInput {
  repo: Repo;
  cfg: Config;
  snapshot: string;
  /** Repo-relative paths the session edited. Only these go into the "after" copy. */
  files: string[];
  request: string;
  /** Keep the before/after copies for debugging. */
  keepCopies?: boolean;
}

const MAX_JUDGED_SHOTS = 12;

export async function runCheck(input: CheckInput): Promise<RunResult> {
  const { repo, cfg, snapshot } = input;
  const started = Date.now();
  const deadline = started + cfg.timeoutMs;
  const timings: Record<string, number> = {};
  const lap = (name: string, since: number) => (timings[name] = Date.now() - since);

  const id = new Date(started).toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);
  const runDir = join(repo.stateDir, 'runs', id);
  mkdirSync(runDir, { recursive: true });

  const changed = changedSince(repo, snapshot, input.files);
  const uiFiles = changed.filter((f) => isUiFile(f, cfg) || /^(tailwind|postcss)\.config\./.test(basename(f)));
  const result: RunResult = {
    id, runDir, startedAt: new Date(started).toISOString(), ms: 0, status: 'skipped', request: input.request,
    changed, uiFiles, routes: [], notChecked: [], codeFindings: [], hardFailures: [], judge: null, shots: [], reviewPath: null, timings,
  };
  if (!uiFiles.length) return finish(result, started);

  let t = Date.now();
  const diff = sessionDiff(repo, snapshot, changed);
  writeFileSync(join(runDir, 'session.diff'), diff);
  result.codeFindings = fastChecks(addedLines(diff), repo.root, cfg);
  lap('codeChecks', t);

  const copies = join(tmpdir(), 'bulletproof', id);
  const beforeDir = join(copies, 'before');
  const afterDir = join(copies, 'after');
  const servers: DevServer[] = [];
  let browser: Browser | null = null;
  try {
    t = Date.now();
    await Promise.all([materialize(repo, snapshot, beforeDir, cfg.copyIgnored), materialize(repo, snapshot, afterDir, cfg.copyIgnored, changed)]);
    lap('copies', t);

    t = Date.now();
    const found = affectedRoutes(afterDir, uiFiles, cfg);
    result.routes = found.routes;
    result.notChecked.push(...found.notChecked);
    lap('routes', t);
    if (!found.routes.length) return await done();

    t = Date.now();
    const [before, after] = await Promise.all([
      startDevServer(beforeDir, cfg.devCommand, cfg.devReadyTimeoutMs),
      startDevServer(afterDir, cfg.devCommand, cfg.devReadyTimeoutMs),
    ]);
    servers.push(before, after);
    lap('devServers', t);
    if (after.failed && !before.failed) {
      result.hardFailures.push({ shot: null, problem: `The app no longer starts after this change. ${after.failed}`, fix: 'Fix the error so the dev server starts.' });
      return await done();
    }
    if (before.failed) {
      result.notChecked.push(`Every page: the app did not start even before this change, so nothing could be compared. ${before.failed}`);
      return await done();
    }

    t = Date.now();
    browser = await chromium.launch({ headless: true });
    const [bShots, aShots] = await Promise.all([
      captureAll(browser, before.url, found.routes, cfg, join(runDir, 'before'), deadline),
      captureAll(browser, after.url, found.routes, cfg, join(runDir, 'after'), deadline),
    ]);
    lap('screenshots', t);
    await Promise.all(servers.map((s) => s.stop()));

    t = Date.now();
    const pairs = await comparePairs(bShots, aShots, runDir, result);
    result.shots = pairs;
    lap('pixelDiff', t);

    const changedPairs = pairs.filter((p) => p.side).sort((p, q) => q.changedPercent - p.changedPercent);
    const toJudge = changedPairs.slice(0, MAX_JUDGED_SHOTS);
    for (const p of changedPairs.slice(MAX_JUDGED_SHOTS)) result.notChecked.push(`${p.id}: changed, but over the judge's limit of ${MAX_JUDGED_SHOTS} screenshots.`);

    if (cfg.judge.enabled && (toJudge.length || result.codeFindings.some((f) => f.severity === 'warn'))) {
      t = Date.now();
      const judgeShots: JudgeShot[] = toJudge.map((p) => ({ id: p.id, route: p.route, viewport: p.viewport, scheme: p.scheme, image: p.side!, changedPercent: p.changedPercent }));
      const j = await runJudge(
        {
          request: input.request,
          diff,
          codeFindings: result.codeFindings.filter((f) => f.severity === 'block'),
          shots: judgeShots,
          components: listComponents(repo.root, cfg),
          themeFiles: cfg.themeFiles,
          taste: readTaste(repo.stateDir, repo.root),
        },
        cfg,
        runDir,
      );
      lap('judge', t);
      if (j.output) {
        const reviewed = new Set(j.output.reviewed);
        result.judge = { ...j.output, error: null, costUsd: j.costUsd, ms: j.ms };
        for (const p of toJudge) if (!reviewed.has(p.id)) result.notChecked.push(`${p.id}: changed, but the judge did not open it.`);
      } else {
        result.judge = { findings: [], reviewed: [], summary: '', error: j.error, costUsd: j.costUsd, ms: j.ms };
        for (const p of toJudge) result.notChecked.push(`${p.id}: changed, but the judge failed (${j.error}).`);
      }
    } else if (toJudge.length) {
      for (const p of toJudge) result.notChecked.push(`${p.id}: changed, and the judge is turned off.`);
    }
    return await done();
  } finally {
    await Promise.all(servers.map((s) => s.stop()));
    await browser?.close().catch(() => {});
    if (!input.keepCopies) rmSync(copies, { recursive: true, force: true });
  }

  async function done(): Promise<RunResult> {
    const blocking =
      result.hardFailures.length > 0 ||
      result.codeFindings.some((f) => f.severity === 'block') ||
      (result.judge?.findings.some((f) => f.severity === 'block') ?? false);
    result.status = blocking ? 'block' : 'pass';
    return finish(result, started);
  }
}

function finish(result: RunResult, started: number): RunResult {
  result.ms = Date.now() - started;
  if (result.status !== 'skipped') result.reviewPath = writeReview(result);
  writeFileSync(join(result.runDir, 'run.json'), JSON.stringify(result, null, 2));
  return result;
}

async function comparePairs(bShots: Shot[], aShots: Shot[], runDir: string, result: RunResult): Promise<ShotPair[]> {
  const byId = new Map(bShots.map((s) => [s.id, s]));
  const pairs: ShotPair[] = [];
  mkdirSync(join(runDir, 'diff'), { recursive: true });
  for (const a of aShots) {
    const b = byId.get(a.id)!;
    const pair: ShotPair = { id: a.id, route: a.route, viewport: a.viewport, scheme: a.scheme, before: b.file, after: a.file, side: null, diff: null, changedPercent: 0 };
    pairs.push(pair);
    const where = `${a.url} (${a.viewport}, ${a.scheme})`;

    if (a.loadError && b.loadError) {
      result.notChecked.push(`${a.id}: the page did not load before or after the change (${a.loadError}).`);
      continue;
    }
    if (a.loadError) {
      result.hardFailures.push({ shot: a.id, problem: `${where} stopped loading: ${a.loadError}`, fix: 'Fix the error so the page loads again.' });
      continue;
    }
    if (b.loadError) {
      result.notChecked.push(`${a.id}: the page did not load before the change, so there is nothing to compare against (${b.loadError}).`);
      continue;
    }
    const newErrors = a.consoleErrors.filter((e) => !b.consoleErrors.includes(e));
    for (const e of unique(newErrors).slice(0, 3)) {
      result.hardFailures.push({ shot: a.id, problem: `New console error on ${where}: ${e}`, fix: 'Fix the error this change introduced.' });
    }
    const newFailed = a.failedRequests.filter((r) => !b.failedRequests.includes(r));
    for (const r of unique(newFailed).slice(0, 3)) {
      result.hardFailures.push({ shot: a.id, problem: `New failed request on ${where}: ${r}`, fix: 'Make the request succeed or stop making it.' });
    }
    if (a.overflowX > 1 && b.overflowX <= 1) {
      result.hardFailures.push({ shot: a.id, problem: `${where} now scrolls sideways by ${a.overflowX}px.`, fix: 'Make the new content fit the screen width (wrap, shrink, or scroll inside its own box).' });
    }
    if (!a.file || !b.file) continue;
    const d = await diffPair(b.file, a.file, join(runDir, 'diff', a.id));
    pair.side = d.sideBySide;
    pair.diff = d.diffImage;
    pair.changedPercent = d.ratio * 100;
  }
  return pairs;
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function listComponents(root: string, cfg: Config): string[] {
  if (!cfg.componentsDir) return [];
  const dir = join(root, cfg.componentsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(tsx|jsx)$/.test(f))
    .map((f) => `${cfg.componentsDir}/${basename(f, extname(f))}`);
}
