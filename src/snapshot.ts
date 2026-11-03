// The "before" picture of a session and the two copies of the app built from it.
//
// takeSnapshot commits the working tree (tracked + untracked, minus ignored) through
// a throwaway index, so the developer's files, real index and stash are untouched.
// `git stash create` was the first idea and it skips untracked files.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, matchesGlob } from 'node:path';
import { git, SNAPSHOT_IDENTITY, tryGit, type Repo } from './repo.ts';

const execFileAsync = promisify(execFile);

export function takeSnapshot(repo: Repo, sessionId: string): string {
  const tmpIndex = join(repo.stateDir, `index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, ...SNAPSHOT_IDENTITY, GIT_INDEX_FILE: tmpIndex };
  try {
    // Starting from a copy of the real index keeps git's stat cache, so only changed files get hashed.
    const realIndex = join(repo.gitDir, 'index');
    if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
    const head = tryGit(repo.root, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (head && !existsSync(realIndex)) git(repo.root, ['read-tree', head], env);
    git(repo.root, ['add', '-A', '--', '.'], env);
    const tree = git(repo.root, ['write-tree'], env);
    const commit = git(repo.root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `bulletproof snapshot ${sessionId}`], env);
    // A ref keeps the commit from being garbage-collected while the session lives.
    git(repo.root, ['update-ref', `refs/bulletproof/${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`, commit]);
    return commit;
  } finally {
    if (existsSync(tmpIndex)) unlinkSync(tmpIndex);
  }
}

/** Files whose working-tree content differs from the snapshot (added, changed or deleted). */
export function changedSince(repo: Repo, snapshot: string, files: string[]): string[] {
  return files.filter((f) => blobAt(repo, snapshot, f) !== workingBlob(repo, f));
}

function blobAt(repo: Repo, commit: string, file: string): string | null {
  return tryGit(repo.root, ['rev-parse', '--verify', '-q', `${commit}:${file}`]);
}

function workingBlob(repo: Repo, file: string): string | null {
  const abs = join(repo.root, file);
  return existsSync(abs) ? git(repo.root, ['hash-object', '--', file]) : null;
}

/** Stable hash of the current content of these files, for "nothing changed since the last pass". */
export function fingerprint(repo: Repo, files: string[]): string {
  const h = createHash('sha256');
  for (const f of files) {
    const abs = join(repo.root, f);
    h.update(f + '\0' + (existsSync(abs) ? readFileSync(abs) : '<deleted>') + '\0');
  }
  return h.digest('hex');
}

/** Unified diff of the session's files, snapshot -> working tree. New files diff against nothing. */
export function sessionDiff(repo: Repo, snapshot: string, files: string[]): string {
  const parts: string[] = [];
  for (const f of files) {
    const inSnapshot = blobAt(repo, snapshot, f) !== null;
    const exists = existsSync(join(repo.root, f));
    const args = inSnapshot
      ? ['diff', '--no-color', '-U3', snapshot, '--', f]
      : exists
        ? ['diff', '--no-color', '-U3', '--no-index', '--', '/dev/null', f]
        : null;
    if (!args) continue;
    try {
      parts.push(execFileSync('git', args, { cwd: repo.root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    } catch (e: any) {
      // --no-index exits 1 when the files differ, which is the expected case.
      if (e.status === 1 && typeof e.stdout === 'string') parts.push(e.stdout);
      else throw e;
    }
  }
  return parts.join('');
}

/**
 * Writes a runnable copy of the app at `dest`: the snapshot's files, the ignored
 * files the app needs (node_modules, .env*), then `overlay` files taken from the
 * working tree. Before = no overlay; after = the session's files only, so other
 * windows' edits never land in either copy.
 */
export async function materialize(repo: Repo, snapshot: string, dest: string, copyIgnored: string[], overlay: string[] = []): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const tar = execFileSync('git', ['archive', '--format=tar', snapshot], { cwd: repo.root, maxBuffer: 2 * 1024 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dest], { input: tar, maxBuffer: 64 * 1024 * 1024 });

  const clones: Promise<void>[] = [];
  for (const entry of readdirSync(repo.root)) {
    if (entry === '.git' || !copyIgnored.some((p) => matchesGlob(entry, p))) continue;
    if (existsSync(join(dest, entry))) continue;
    clones.push(cloneTree(join(repo.root, entry), join(dest, entry)));
  }
  await Promise.all(clones);

  for (const f of overlay) {
    const src = join(repo.root, f);
    const out = join(dest, f);
    if (existsSync(src)) {
      mkdirSync(dirname(out), { recursive: true });
      copyFileSync(src, out);
    } else {
      rmSync(out, { force: true });
    }
  }
}

/** Copy-on-write clone where the filesystem supports it (APFS, btrfs, xfs), plain copy otherwise. */
async function cloneTree(src: string, dest: string): Promise<void> {
  const flags = process.platform === 'darwin' ? ['-cR'] : ['-R', '--reflink=auto'];
  try {
    await execFileAsync('cp', [...flags, src, dest]);
  } catch {
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  }
}
