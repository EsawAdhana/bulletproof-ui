// Builds a demo video from one real Claude Code session that Bulletproof checked.
// Everything shown comes from the session's transcript and Bulletproof's run
// records; waiting is compressed, and the video says so.
//
//   node demo/build-reel.ts --repo <app repo> --session <session id> --transcript <file.jsonl> --out <dir>
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { RunResult } from '../src/check.ts';
import { findRepo } from '../src/repo.ts';
import { loadSession } from '../src/session.ts';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    session: { type: 'string' },
    transcript: { type: 'string' },
    out: { type: 'string', default: 'demo/out' },
    title: { type: 'string', default: 'Bulletproof on Stanford Root' },
  },
});
const repo = findRepo(resolve(values.repo!))!;
const session = loadSession(repo, values.session!)!;
const out = resolve(values.out!);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });

// ---- What happened, from the transcript ----
interface Step {
  at: string;
  kind: 'prompt' | 'tool' | 'block' | 'final';
  text: string;
}
const steps: Step[] = [];
for (const line of readFileSync(values.transcript!, 'utf8').split('\n')) {
  if (!line) continue;
  const d = JSON.parse(line);
  const content = d.message?.content;
  if (d.type === 'user' && typeof content === 'string' && !d.isMeta) {
    if (content.includes('Bulletproof checked your UI change')) steps.push({ at: d.timestamp, kind: 'block', text: content });
    else if (!content.startsWith('<')) steps.push({ at: d.timestamp, kind: 'prompt', text: content });
  }
  if (d.type === 'user' && Array.isArray(content)) {
    for (const c of content) if (c.type === 'text' && String(c.text).includes('Bulletproof checked your UI change')) steps.push({ at: d.timestamp, kind: 'block', text: c.text });
  }
  if (d.type === 'attachment' && JSON.stringify(d).includes('Bulletproof checked your UI change')) {
    steps.push({ at: d.timestamp, kind: 'block', text: '' });
  }
  if (d.type === 'assistant' && Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'tool_use') steps.push({ at: d.timestamp, kind: 'tool', text: describeTool(c.name, c.input) });
      if (c.type === 'text' && c.text.trim()) steps.push({ at: d.timestamp, kind: 'final', text: c.text.trim() });
    }
  }
}

function describeTool(name: string, input: any): string {
  const rel = (p: string) => String(p ?? '').replace(/^.*Stanford Root-bulletproof\//, '');
  if (name === 'Read') return `Read ${rel(input.file_path)}`;
  if (name === 'Edit' || name === 'MultiEdit') return `Edit ${rel(input.file_path)}`;
  if (name === 'Write') return `Write ${rel(input.file_path)}`;
  if (name === 'Grep') return `Search "${String(input.pattern).slice(0, 40)}"`;
  if (name === 'Glob') return `Find ${input.pattern}`;
  if (name === 'Bash') return `$ ${String(input.command).replace(/cd "[^"]+" && /, '').split('\n')[0].slice(0, 90)}`;
  return name;
}

// ---- What Bulletproof did, from its run records ----
const runs: RunResult[] = session.runs.map((id) => JSON.parse(readFileSync(join(repo.stateDir, 'runs', id, 'run.json'), 'utf8')));
const asset = (file: string | null, name: string) => {
  if (!file || !existsSync(file)) return null;
  copyFileSync(file, join(out, 'assets', name));
  return `assets/${name}`;
};

// Group tool calls into rounds: work before the first check, then work after each block.
const blocks = runs.map((r) => r.startedAt);
const rounds: Step[][] = [[]];
let r = 0;
for (const s of steps.filter((x) => x.kind === 'tool')) {
  while (r < blocks.length && s.at > blocks[r]) {
    r++;
    rounds.push([]);
  }
  rounds[r].push(s);
}
const prompt = steps.find((s) => s.kind === 'prompt')?.text ?? '';
const finalText = [...steps].reverse().find((s) => s.kind === 'final')?.text ?? '';

// Screenshot of the last review page, rendered headless.
async function shootReview(browser: Awaited<ReturnType<typeof chromium.launch>>): Promise<string | null> {
  const last = runs[runs.length - 1];
  if (!last?.reviewPath) return null;
  const page = await browser.newPage({ viewport: { width: 1100, height: 1300 }, colorScheme: 'dark' });
  await page.goto(pathToFileURL(last.reviewPath).href);
  const file = join(out, 'assets', 'review.png');
  await page.screenshot({ path: file });
  await page.close();
  return 'assets/review.png';
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const secs = (ms: number) => `${Math.round(ms / 1000)}s`;

function findingLines(run: RunResult): string[] {
  return [
    ...run.hardFailures.map((f) => f.problem),
    ...run.codeFindings.filter((f) => f.severity === 'block').map((f) => `${f.file}:${f.line} ${f.problem}`),
    ...(run.judge?.findings ?? []).filter((f) => f.severity === 'block').map((f) => `[${f.shot}] ${f.problem}`),
  ];
}

async function main() {
  const browser = await chromium.launch();
  const review = await shootReview(browser);
  const totalMs = runs.reduce((a, x) => a + x.ms, 0);
  const judgeCost = runs.reduce((a, x) => a + (x.judge?.costUsd ?? 0), 0);
  const scenes: { html: string; ms: number }[] = [];
  const scene = (html: string, ms: number) => scenes.push({ html, ms });

  scene(
    `<div class="center"><p class="kicker">CS146S alpha · Nov 2026</p><h1>${esc(values.title!)}</h1>
     <p class="sub">A coding agent says "done". Bulletproof screenshots every page it touched, before and after,<br>and sends it back until the change is one you'd ship.</p>
     <p class="note">A real Claude Code session, recorded ${new Date(runs[0]?.startedAt ?? Date.now()).toLocaleDateString('en-US', { dateStyle: 'medium' })}. Waiting is sped up.</p></div>`,
    6000,
  );
  scene(`<div class="center"><p class="kicker">The request</p><p class="prompt">"${esc(prompt)}"</p></div>`, 5000);

  runs.forEach((run, i) => {
    const work = rounds[i] ?? [];
    scene(
      `<div class="col"><p class="kicker">${i === 0 ? 'The agent works' : `Round ${i}: the agent fixes what came back`}</p>
       <div class="term">${work.slice(-12).map((s) => `<div class="tline">${esc(s.text)}</div>`).join('') || '<div class="tline dim">(no tool calls)</div>'}</div>
       <p class="sub small">${work.length} tool call${work.length === 1 ? '' : 's'}${work.length > 12 ? ', last 12 shown' : ''}. Then the agent says it's done.</p></div>`,
      Math.min(9000, 3500 + work.length * 250),
    );
    const changed = run.shots.filter((s) => s.side).sort((a, b) => b.changedPercent - a.changedPercent);
    scene(
      `<div class="col"><p class="kicker">Stop hook · Bulletproof checks</p>
       <div class="steps">
        <div><b>${run.changed.length}</b> file${run.changed.length === 1 ? '' : 's'} the agent changed</div>
        <div><b>${run.codeFindings.length}</b> plain code finding${run.codeFindings.length === 1 ? '' : 's'}</div>
        <div><b>${run.routes.length}</b> affected page${run.routes.length === 1 ? '' : 's'}: ${esc(run.routes.map((x) => x.url).join(', ') || 'none')}</div>
        <div><b>${run.shots.length}</b> before/after pairs · phone + desktop · light + dark</div>
        <div><b>${changed.length}</b> changed · judge reviewed ${run.judge?.reviewed.length ?? 0}</div>
        <div class="dim">took ${secs(run.ms)} (copies ${secs(run.timings.copies ?? 0)}, dev servers ${secs(run.timings.devServers ?? 0)}, screenshots ${secs(run.timings.screenshots ?? 0)}, judge ${secs(run.timings.judge ?? 0)})</div>
       </div></div>`,
      6000,
    );
    const top = changed[0];
    const img = top ? asset(top.side, `run${i}-${basename(top.side!)}`) : null;
    if (run.status === 'block') {
      const lines = findingLines(run);
      scene(
        `<div class="split"><div><p class="kicker bad">Sent back · round ${i + 1}</p>
          <ul class="finds">${lines.slice(0, 5).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
          ${lines.length > 5 ? `<p class="dim small">+${lines.length - 5} more</p>` : ''}</div>
          ${img ? `<figure><div class="labels"><span>Before</span><span>After</span></div><img src="${img}"><figcaption>${esc(top!.id)} · changes outlined in red</figcaption></figure>` : ''}</div>`,
        11000,
      );
    } else {
      const unsure = (run.judge?.findings ?? []).filter((f) => f.severity === 'unsure');
      scene(
        `<div class="split"><div><p class="kicker good">Passed</p>
          <p class="sub">Checked ${run.routes.length} page${run.routes.length === 1 ? '' : 's'}, ${run.shots.length} screenshot pairs.</p>
          ${unsure.length ? `<p class="sub small">Question left for the developer:</p><ul class="finds">${unsure.slice(0, 2).map((u) => `<li>${esc(u.problem)}</li>`).join('')}</ul>` : ''}
          ${run.notChecked.length ? `<p class="dim small">Listed as not checked: ${run.notChecked.length} (e.g. ${esc(run.notChecked[0].slice(0, 90))})</p>` : ''}</div>
          ${img ? `<figure><div class="labels"><span>Before</span><span>After</span></div><img src="${img}"><figcaption>${esc(top!.id)}</figcaption></figure>` : ''}</div>`,
        10000,
      );
    }
  });

  if (review) scene(`<div class="col"><p class="kicker">The review page</p><img class="review" src="${review}"></div>`, 7000);
  if (finalText) scene(`<div class="col"><p class="kicker">The agent's last message</p><div class="term msg">${esc(finalText.slice(0, 900))}</div></div>`, 9000);
  scene(
    `<div class="center"><h1>${runs.filter((x) => x.status === 'block').length} round${runs.filter((x) => x.status === 'block').length === 1 ? '' : 's'} sent back, then ${runs[runs.length - 1]?.status === 'pass' ? 'passed' : 'stopped'}</h1>
     <p class="sub">${runs.length} checks · ${secs(totalMs)} of checking · judge $${judgeCost.toFixed(2)}</p>
     <p class="note">github.com/EsawAdhana/bulletproof-ui</p></div>`,
    6000,
  );

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; } html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #0c0a09; color: #f5f5f4; font: 22px/1.45 -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif; }
  .scene { position: absolute; inset: 0; padding: 56px 72px; opacity: 0; transition: opacity 600ms ease; display: flex; }
  .scene.on { opacity: 1; }
  .center { margin: auto; text-align: center; max-width: 1000px; }
  .col { width: 100%; display: flex; flex-direction: column; }
  .split { width: 100%; display: grid; grid-template-columns: 0.9fr 1.1fr; gap: 40px; align-items: start; }
  h1 { font-size: 52px; line-height: 1.1; margin: 0 0 20px; letter-spacing: -0.02em; }
  .kicker { font-size: 15px; letter-spacing: 0.12em; text-transform: uppercase; color: #a8a29e; margin: 0 0 18px; font-weight: 600; }
  .kicker.bad { color: #f87171; } .kicker.good { color: #4ade80; }
  .sub { color: #d6d3d1; margin: 0 0 14px; } .small { font-size: 17px; } .note { color: #78716c; font-size: 16px; margin-top: 28px; } .dim { color: #78716c; }
  .prompt { font-size: 34px; line-height: 1.35; margin: 0; }
  .term { background: #1c1917; border: 1px solid #292524; border-radius: 10px; padding: 18px 22px; font: 17px/1.6 ui-monospace, "SF Mono", Menlo, monospace; color: #e7e5e4; margin-bottom: 16px; }
  .tline { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0; animation: in 300ms ease forwards; }
  ${Array.from({ length: 12 }, (_, i) => `.tline:nth-child(${i + 1}) { animation-delay: ${200 + i * 280}ms; }`).join('\n')}
  .msg { white-space: pre-wrap; font-size: 16px; }
  .steps div { font-size: 22px; padding: 10px 0; border-bottom: 1px solid #292524; opacity: 0; animation: in 300ms ease forwards; }
  ${Array.from({ length: 6 }, (_, i) => `.steps div:nth-child(${i + 1}) { animation-delay: ${300 + i * 650}ms; }`).join('\n')}
  .steps b { color: #fff; font-size: 26px; margin-right: 6px; }
  .finds { margin: 0; padding: 0; list-style: none; } .finds li { background: #1c1917; border-left: 3px solid #f87171; padding: 10px 14px; margin: 0 0 10px; font-size: 17px; line-height: 1.4; border-radius: 4px; }
  figure { margin: 0; } figure img { max-width: 100%; max-height: 520px; display: block; border: 1px solid #292524; border-radius: 6px; } figcaption { color: #78716c; font-size: 14px; margin-top: 8px; font-family: ui-monospace, monospace; }
  .labels { display: grid; grid-template-columns: 1fr 1fr; font-size: 13px; font-weight: 600; color: #a8a29e; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
  img.review { max-height: 560px; align-self: flex-start; border: 1px solid #292524; border-radius: 6px; }
  @keyframes in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  </style></head><body>
  ${scenes.map((s, i) => `<section class="scene" id="s${i}">${s.html}</section>`).join('\n')}
  <script>
    const durations = ${JSON.stringify(scenes.map((s) => s.ms))};
    let i = 0;
    function show() {
      document.querySelectorAll('.scene').forEach((el, j) => el.classList.toggle('on', j === i));
      // Restart the staggered animations in the scene that just appeared.
      document.querySelectorAll('#s' + i + ' .tline, #s' + i + ' .steps div').forEach((el) => { el.style.animation = 'none'; el.offsetHeight; el.style.animation = ''; });
      setTimeout(() => { i++; if (i < durations.length) show(); else window.reelDone = true; }, durations[i]);
    }
    window.addEventListener('load', () => setTimeout(show, 300));
  </script></body></html>`;
  writeFileSync(join(out, 'reel.html'), html);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: join(out, 'raw'), size: { width: 1280, height: 720 } } });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(out, 'reel.html')).href);
  await page.waitForFunction(() => (window as any).reelDone === true, null, { timeout: scenes.reduce((a, s) => a + s.ms, 0) + 30_000, polling: 500 });
  await page.waitForTimeout(800);
  await ctx.close();
  await browser.close();

  const raw = readdirSync(join(out, 'raw')).find((f) => f.endsWith('.webm'))!;
  renameSync(join(out, 'raw', raw), join(out, 'reel.webm'));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(out, 'reel.webm'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', join(out, 'bulletproof-alpha-demo.mp4')]);
  process.stdout.write(`${join(out, 'bulletproof-alpha-demo.mp4')}\n${scenes.length} scenes, ${Math.round(scenes.reduce((a, s) => a + s.ms, 0) / 1000)}s\n`);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exit(1);
});
