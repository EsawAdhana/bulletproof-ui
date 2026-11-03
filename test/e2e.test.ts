// End to end on the fixture Next.js app: real dev servers, real browser, fake judge.
// Slow (about 20s per case), so these run one at a time.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCheck, type RunResult } from '../src/check.ts';
import { loadConfig, type Config } from '../src/config.ts';
import { findRepo } from '../src/repo.ts';
import { takeSnapshot } from '../src/snapshot.ts';
import { edit, makeFixtureRepo, ROOT, write } from './helpers.ts';

const FAKE_JUDGE = ['node', join(ROOT, 'test', 'fake-judge.mjs')];
const made: string[] = [];
afterAll(() => made.forEach((r) => rmSync(r, { recursive: true, force: true })), 120_000);

async function scenario(change: (root: string) => void, opts: { files?: string[]; judge?: string; cfg?: Partial<Config> } = {}): Promise<RunResult> {
  const root = makeFixtureRepo();
  made.push(root);
  const repo = findRepo(root)!;
  const snapshot = takeSnapshot(repo, 'e2e');
  change(root);
  process.env.FAKE_JUDGE = opts.judge ?? 'pass';
  const cfg = loadConfig(repo, { judge: { enabled: true, command: FAKE_JUDGE, model: 'x', timeoutMs: 30_000 }, viewports: [{ name: 'phone', width: 390, height: 844 }], ...opts.cfg });
  return runCheck({ repo, cfg, snapshot, files: opts.files ?? ['components/course-card.tsx'], request: 'test' });
}

const CARD = 'components/course-card.tsx';
const UNITS = '<p className="mt-1 text-sm text-muted">{units} units</p>';

describe('end to end', () => {
  it('passes a clean change once the judge has looked at every changed screenshot', async () => {
    const r = await scenario((root) => edit(root, CARD, UNITS, `${UNITS}\n      <p className="mt-1 text-sm text-muted">Letter grade</p>`));
    expect(r.status).toBe('pass');
    expect(r.shots.filter((s) => s.side)).toHaveLength(2);
    expect(r.judge?.reviewed).toHaveLength(2);
    expect(r.notChecked).toEqual([]);
  }, 180_000);

  it('blocks on what the judge is confident about', async () => {
    const r = await scenario((root) => edit(root, CARD, UNITS, `${UNITS}\n      <p className="mt-1 text-sm text-muted">Letter grade</p>`), { judge: 'block' });
    expect(r.status).toBe('block');
    expect(r.judge?.findings[0].severity).toBe('block');
  }, 180_000);

  it('blocks a page that now scrolls sideways on a phone', async () => {
    const r = await scenario((root) => edit(root, CARD, UNITS, `${UNITS}\n      <p className="whitespace-nowrap text-sm">${'Prerequisites: CS 106B, CS 107, Math 51 '.repeat(4)}</p>`));
    expect(r.status).toBe('block');
    expect(r.hardFailures.some((f) => f.problem.includes('scrolls sideways'))).toBe(true);
  }, 180_000);

  it('blocks a new error thrown in the browser', async () => {
    const r = await scenario(
      (root) => {
        write(root, { 'components/boom.tsx': "'use client';\nimport { useEffect } from 'react';\nexport function Boom() {\n  useEffect(() => {\n    throw new Error('boom from the new widget');\n  }, []);\n  return null;\n}\n" });
        edit(root, CARD, "import { Button } from '@/components/ui/button';", "import { Button } from '@/components/ui/button';\nimport { Boom } from '@/components/boom';");
        edit(root, CARD, UNITS, `${UNITS}\n      <Boom />`);
      },
      { files: [CARD, 'components/boom.tsx'] },
    );
    expect(r.status).toBe('block');
    expect(r.hardFailures.map((f) => f.problem).join('\n')).toContain('boom from the new widget');
  }, 180_000);

  it('does not block on a request that fails once and then works (live data is flaky)', async () => {
    const flaky = 'app/api/seats/route.ts';
    const widget = 'components/seats.tsx';
    const r = await scenario(
      (root) => {
        // Fails on the first call the server sees, then succeeds, like Stanford Root's evaluations API did once.
        write(root, {
          [flaky]: "let calls = 0;\nexport async function GET() {\n  calls++;\n  return calls === 1 ? new Response('busy', { status: 500 }) : Response.json({ seats: 12 });\n}\n",
          [widget]: "'use client';\nimport { useEffect, useState } from 'react';\nexport function Seats() {\n  const [n, setN] = useState<number | null>(null);\n  useEffect(() => {\n    fetch('/api/seats').then((r) => (r.ok ? r.json() : null)).then((d) => setN(d?.seats ?? null));\n  }, []);\n  return <p className=\"mt-1 text-sm text-muted\">{n === null ? 'Seats loading' : `${n} seats left`}</p>;\n}\n",
        });
        edit(root, CARD, "import { Button } from '@/components/ui/button';", "import { Button } from '@/components/ui/button';\nimport { Seats } from '@/components/seats';");
        edit(root, CARD, UNITS, `${UNITS}\n      <Seats />`);
      },
      { files: [CARD, flaky, widget], cfg: { schemes: ['light'] } },
    );
    expect(r.hardFailures).toEqual([]);
  }, 180_000);

  it("ignores another window's edits: they are neither checked nor blamed", async () => {
    const r = await scenario((root) => {
      edit(root, CARD, UNITS, `${UNITS}\n      <p className="mt-1 text-sm text-muted">Letter grade</p>`);
      edit(root, 'app/about/page.tsx', 'text-2xl', 'text-[31px]');
    });
    expect(r.codeFindings).toEqual([]);
    expect(r.changed).toEqual([CARD]);
    expect(r.status).toBe('pass');
  }, 180_000);

  it('never passes a screenshot the judge did not open', async () => {
    const r = await scenario((root) => edit(root, CARD, UNITS, `${UNITS}\n      <p className="mt-1 text-sm text-muted">Letter grade</p>`), { judge: 'skip' });
    expect(r.notChecked.filter((n) => n.includes('judge did not open'))).toHaveLength(2);
  }, 180_000);

  it('lists everything as not checked when the judge crashes', async () => {
    const r = await scenario((root) => edit(root, CARD, UNITS, `${UNITS}\n      <p className="mt-1 text-sm text-muted">Letter grade</p>`), { judge: 'crash' });
    expect(r.judge?.error).toMatch(/Judge failed/);
    expect(r.notChecked.filter((n) => n.includes('judge failed'))).toHaveLength(2);
  }, 180_000);

  it('says nothing was checked when the dev server cannot start at all', async () => {
    const r = await scenario((root) => edit(root, CARD, UNITS, `${UNITS}\n      <p>x</p>`), { cfg: { devCommand: ['node', '-e', 'process.exit(1)'], devReadyTimeoutMs: 10_000 } });
    expect(r.shots).toEqual([]);
    expect(r.notChecked.join('\n')).toMatch(/did not start even before this change/);
  }, 180_000);

  it('blocks when the change itself stops the app from rendering', async () => {
    const r = await scenario((root) => writeFileSync(join(root, CARD), 'export function CourseCard( {\n'));
    expect(r.status).toBe('block');
    expect(r.hardFailures.length).toBeGreaterThan(0);
  }, 180_000);
});
