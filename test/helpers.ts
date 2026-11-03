import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = join(ROOT, 'fixtures', 'next-app');

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

export function write(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

/** A throwaway git repo with one commit holding `files`. */
export function makeRepo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bp-test-')));
  write(root, files);
  sh(root, 'git', ['init', '-q', '-b', 'main']);
  sh(root, 'git', ['add', '--', ...Object.keys(files)]);
  sh(root, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  return root;
}

/** The fixture Next.js app as a fresh repo, node_modules cloned in (not committed). */
export function makeFixtureRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bp-fixture-')));
  const tracked = sh(FIXTURE, 'git', ['ls-files', '-co', '--exclude-standard', '.']).split('\n').filter((f) => f && !f.startsWith('node_modules'));
  for (const f of tracked) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    execFileSync('cp', [join(FIXTURE, f), join(root, f)]);
  }
  write(root, { '.gitignore': 'node_modules\n.next\nnext-env.d.ts\n' });
  execFileSync('cp', [process.platform === 'darwin' ? '-cR' : '-R', join(FIXTURE, 'node_modules'), join(root, 'node_modules')]);
  sh(root, 'git', ['init', '-q', '-b', 'main']);
  sh(root, 'git', ['add', '--', '.gitignore', ...tracked]);
  sh(root, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base']);
  return root;
}

/** Replaces exactly one occurrence, so a scenario fails loudly if the fixture drifts. */
export function edit(root: string, rel: string, find: string, replace: string): void {
  const file = join(root, rel);
  const body = execFileSync('cat', [file], { encoding: 'utf8' });
  if (body.split(find).length !== 2) throw new Error(`Expected exactly one "${find}" in ${rel}`);
  writeFileSync(file, body.replace(find, replace));
}
