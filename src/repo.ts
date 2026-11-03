// Git plumbing shared by every part. All paths that leave this file are absolute
// unless the name says "rel".
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Repo {
  root: string;
  gitDir: string;
  /** Shared by every worktree of the repo; Bulletproof keeps its state here so nothing shows up in git status. */
  stateDir: string;
}

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

export function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    return git(cwd, args, env);
  } catch {
    return null;
  }
}

export function findRepo(cwd: string): Repo | null {
  const out = tryGit(cwd, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (!out) return null;
  const [root, gitDir, commonDir] = out.split('\n');
  const stateDir = join(resolve(cwd, commonDir), 'bulletproof');
  mkdirSync(stateDir, { recursive: true });
  return { root, gitDir: resolve(cwd, gitDir), stateDir };
}

/** Commit identity for snapshot commits, so they work on machines with no user.name set. */
export const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'bulletproof',
  GIT_AUTHOR_EMAIL: 'bulletproof@localhost',
  GIT_COMMITTER_NAME: 'bulletproof',
  GIT_COMMITTER_EMAIL: 'bulletproof@localhost',
};
