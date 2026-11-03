// The review page: one static HTML file per run, next to its screenshots.
// The alpha writes a file; the local review server with yes/no answers is the final milestone.
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RunResult } from './check.ts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** Escapes, then shows `backticked` spans as code. */
const prose = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

export function writeReview(r: RunResult): string {
  const rel = (p: string | null) => (p ? esc(relative(r.runDir, p)) : '');
  const blocks = [
    ...r.hardFailures.map((f) => ({ kind: 'Hard failure', where: f.shot ?? 'app', problem: f.problem, fix: f.fix })),
    ...r.codeFindings.filter((f) => f.severity === 'block').map((f) => ({ kind: 'Code', where: `${f.file}:${f.line}`, problem: f.problem, fix: f.fix })),
    ...(r.judge?.findings ?? []).filter((f) => f.severity === 'block').map((f) => ({ kind: 'Judge', where: f.shot, problem: f.problem, fix: f.fix })),
  ];
  const unsure = [
    ...(r.judge?.findings ?? []).filter((f) => f.severity === 'unsure').map((f) => ({ where: f.shot, problem: f.problem, fix: f.fix })),
    ...r.codeFindings.filter((f) => f.severity === 'warn').map((f) => ({ where: `${f.file}:${f.line}`, problem: f.problem, fix: f.fix })),
  ];
  const verdict = r.status === 'block' ? 'Sent back to the agent' : r.notChecked.length ? 'Passed what it checked' : 'Passed';
  const item = (f: { kind?: string; where: string; problem: string; fix: string }) =>
    `<li><span class="where">${f.kind ? `${esc(f.kind)} · ` : ''}${esc(f.where)}</span><p>${prose(f.problem)}</p><p class="fix">Fix: ${prose(f.fix)}</p></li>`;
  const when = new Date(r.startedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const changedShots = r.shots.filter((s) => s.side);
  const sameShots = r.shots.filter((s) => s.before && s.after && !s.side);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bulletproof review</title>
<style>
:root { --bg:#fafaf9; --fg:#1c1917; --muted:#78716c; --line:#e7e5e4; --card:#fff; --bad:#b91c1c; --ok:#15803d; --warn:#a16207; }
@media (prefers-color-scheme: dark) { :root { --bg:#0c0a09; --fg:#f5f5f4; --muted:#a8a29e; --line:#292524; --card:#1c1917; --bad:#f87171; --ok:#4ade80; --warn:#facc15; } }
* { box-sizing: border-box; } body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 ui-sans-serif, system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 32px 0 8px; } .muted { color: var(--muted); }
.verdict { display:inline-block; padding: 2px 10px; border-radius: 999px; font-weight: 600; font-size: 13px; border:1px solid currentColor; }
.block { color: var(--bad); } .pass { color: var(--ok); }
ul { list-style: none; padding: 0; margin: 0; } li { background: var(--card); border:1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin: 8px 0; }
li p { margin: 2px 0; } .where { font: 12px ui-monospace, monospace; color: var(--muted); } .fix { color: var(--muted); }
.shot { background: var(--card); border:1px solid var(--line); border-radius: 8px; padding: 12px; margin: 12px 0; }
.shot img { max-width: 100%; display:block; border:1px solid var(--line); } .pair { display:grid; grid-template-columns: 1fr 1fr; gap: 8px; }
code { font: 13px ui-monospace, monospace; }
.side { display: inline-block; max-width: 100%; }
.labels { font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 4px; }
@media (max-width: 600px) { .pair:not(.labels) { grid-template-columns: 1fr; } }
</style></head><body><main>
<h1>Bulletproof review</h1>
<p><span class="verdict ${r.status === 'block' ? 'block' : 'pass'}">${verdict}</span> <span class="muted">${esc(when)} ·${(r.ms / 1000).toFixed(0)}s · ${r.routes.length} page(s) · ${r.shots.length} screenshot pair(s)${r.judge?.costUsd != null ? ` · judge $${r.judge.costUsd.toFixed(3)}` : ''}</span></p>
${r.request ? `<p class="muted">Request: ${esc(r.request.slice(0, 600))}</p>` : ''}
<p class="muted">Files: ${r.changed.map((f) => `<code>${esc(f)}</code>`).join(', ')}</p>

<h2>Problems (${blocks.length})</h2>
${blocks.length ? `<ul>${blocks.map(item).join('')}</ul>` : '<p class="muted">None.</p>'}

<h2>Questions for you (${unsure.length})</h2>
${unsure.length ? `<ul>${unsure.map(item).join('')}</ul>` : '<p class="muted">None.</p>'}

<h2>Not checked (${r.notChecked.length})</h2>
${r.notChecked.length ? `<ul>${r.notChecked.map((n) => `<li><p>${esc(n)}</p></li>`).join('')}</ul>` : '<p class="muted">Everything affected was checked.</p>'}

${r.judge?.summary ? `<h2>Judge's summary</h2><p>${esc(r.judge.summary)}</p>` : ''}
${r.judge?.error ? `<h2>Judge error</h2><p class="block">${esc(r.judge.error)}</p>` : ''}

<h2>Changed screenshots (${changedShots.length})</h2>
${changedShots
  .map(
    (s) =>
      `<div class="shot"><p class="where">${esc(s.id)} · ${s.changedPercent.toFixed(2)}% changed · changes outlined in red</p><div class="side"><div class="pair labels"><span>Before</span><span>After</span></div><img src="${rel(s.side)}" alt="Before and after, ${esc(s.id)}"></div></div>`,
  )
  .join('') || '<p class="muted">No screenshot changed.</p>'}

<h2>Unchanged screenshots (${sameShots.length})</h2>
${sameShots.map((s) => `<div class="shot"><p class="where">${esc(s.id)}</p><div class="pair labels"><span>Before</span><span>After</span></div><div class="pair"><img src="${rel(s.before)}" alt="Before"><img src="${rel(s.after)}" alt="After"></div></div>`).join('') || '<p class="muted">None.</p>'}
</main></body></html>`;
  const file = join(r.runDir, 'review.html');
  writeFileSync(file, html);
  return file;
}
