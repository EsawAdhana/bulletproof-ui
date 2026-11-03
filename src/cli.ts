#!/usr/bin/env node
// bulletproof-ui init | check | hook <event>
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runCheck } from './check.ts';
import { configPaths, loadConfig } from './config.ts';
import { handleHook, type HookInput } from './hooks.ts';
import { findRepo, git, tryGit } from './repo.ts';

const CLI = fileURLToPath(import.meta.url);
const PKG_ROOT = resolve(dirname(CLI), '..');

const HOOK_EVENTS = {
  SessionStart: { event: 'session-start' },
  UserPromptSubmit: { event: 'user-prompt-submit' },
  PostToolUse: { event: 'post-tool-use', matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
  Stop: { event: 'stop', timeout: 600 },
} as const;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'hook':
      return hook(rest[0]);
    case 'init':
      return init(rest);
    case 'check':
      return check(rest);
    default:
      process.stdout.write(`Usage:
  bulletproof-ui init [--repo <path>]       install the Claude Code hooks for one repo (not committed)
  bulletproof-ui check [--base <ref>]       check the working tree's UI changes against <ref> by hand
  bulletproof-ui hook <event>               called by the agent's hooks
`);
      return cmd ? 2 : 0;
  }
}

async function hook(event: string | undefined): Promise<number> {
  let input: HookInput | null = null;
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
    const out = await handleHook(event ?? '', input);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (e: any) {
    // Never break the agent. Say plainly that nothing was checked.
    if (event === 'stop') process.stdout.write(JSON.stringify({ systemMessage: `Bulletproof could not check this change (not checked): ${String(e?.message ?? e).split('\n')[0]}` }));
    else process.stderr.write(`bulletproof: ${String(e?.message ?? e)}\n`);
  }
  return 0;
}

function init(args: string[]): number {
  const { values } = parseArgs({ args, options: { repo: { type: 'string' } } });
  const repo = findRepo(resolve(values.repo ?? process.cwd()));
  if (!repo) throw new Error('Not inside a git repository.');

  const settingsFile = join(repo.root, '.claude', 'settings.local.json');
  mkdirSync(dirname(settingsFile), { recursive: true });
  const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {};
  settings.hooks ??= {};
  const command = (event: string) => `node "${CLI}" hook ${event}`;
  for (const [name, spec] of Object.entries(HOOK_EVENTS)) {
    const kept = (settings.hooks[name] ?? []).filter((g: any) => !(g.hooks ?? []).some((h: any) => String(h.command).includes(' hook ') && String(h.command).includes('cli.ts')));
    const entry: any = { hooks: [{ type: 'command', command: command(spec.event), ...('timeout' in spec ? { timeout: spec.timeout } : {}) }] };
    if ('matcher' in spec) entry.matcher = spec.matcher;
    settings.hooks[name] = [...kept, entry];
  }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

  // Keep the hook file out of commits even if the repo doesn't ignore it.
  if (tryGit(repo.root, ['check-ignore', '-q', settingsFile]) === null) {
    // stateDir is <git-common-dir>/bulletproof, so its parent is the common dir.
    const exclude = join(dirname(repo.stateDir), 'info', 'exclude');
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, '\n.claude/settings.local.json\n');
  }

  const cfgFile = configPaths(repo).find((p) => existsSync(p));
  if (!cfgFile) {
    const cfg = loadConfig(repo);
    writeFileSync(join(repo.stateDir, 'config.json'), JSON.stringify({ componentsDir: cfg.componentsDir, routes: {}, mask: [] }, null, 2) + '\n');
  }

  execFileSync(process.execPath, [join(PKG_ROOT, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], { stdio: 'inherit' });
  process.stdout.write(`Bulletproof hooks installed in ${settingsFile}
Config: ${cfgFile ?? join(repo.stateDir, 'config.json')}
Add a sample URL for each dynamic route under "routes", e.g. {"/[code]": "/CS106A"}.
`);
  return 0;
}

async function check(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { repo: { type: 'string' }, base: { type: 'string', default: 'HEAD' }, request: { type: 'string', default: '' }, keep: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } },
  });
  const repo = findRepo(resolve(values.repo ?? process.cwd()));
  if (!repo) throw new Error('Not inside a git repository.');
  const base = git(repo.root, ['rev-parse', '--verify', values.base!]);
  const tracked = git(repo.root, ['diff', '--name-only', base]).split('\n').filter(Boolean);
  const untracked = git(repo.root, ['ls-files', '-o', '--exclude-standard']).split('\n').filter(Boolean);
  const files = [...new Set([...tracked, ...untracked])];
  const r = await runCheck({ repo, cfg: loadConfig(repo), snapshot: base, files, request: values.request!, keepCopies: values.keep });
  if (values.json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  } else {
    process.stdout.write(`${r.status.toUpperCase()} in ${Math.round(r.ms / 1000)}s: ${r.uiFiles.length} UI file(s), ${r.routes.length} page(s), ${r.shots.length} screenshot pair(s)\n`);
    for (const f of r.hardFailures) process.stdout.write(`  hard failure: ${f.problem}\n`);
    for (const f of r.codeFindings) process.stdout.write(`  code (${f.severity}): ${f.file}:${f.line} ${f.problem}\n`);
    for (const f of r.judge?.findings ?? []) process.stdout.write(`  judge (${f.severity}): [${f.shot}] ${f.problem}\n`);
    if (r.judge?.error) process.stdout.write(`  judge error: ${r.judge.error}\n`);
    for (const n of r.notChecked) process.stdout.write(`  not checked: ${n}\n`);
    process.stdout.write(`  timings: ${JSON.stringify(r.timings)}\n`);
    if (r.reviewPath) process.stdout.write(`  review: ${pathToFileURL(r.reviewPath).href}\n`);
  }
  return r.status === 'block' ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`bulletproof: ${e?.message ?? e}\n`);
    process.exit(2);
  },
);
