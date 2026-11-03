import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepo } from '../src/repo.ts';
import { editedFiles, recordEdit } from '../src/session.ts';
import { changedSince, materialize, sessionDiff, takeSnapshot } from '../src/snapshot.ts';
import { makeRepo, sh, write } from './helpers.ts';

describe('takeSnapshot', () => {
  it('captures untracked and staged files without touching the index, the files or the stash', () => {
    const root = makeRepo({ 'a.txt': 'one\n' });
    write(root, { 'a.txt': 'two\n', 'new.txt': 'untracked\n', 'staged.txt': 'staged\n' });
    sh(root, 'git', ['add', '--', 'staged.txt']);
    sh(root, 'git', ['stash', 'list']);
    const repo = findRepo(root)!;
    const statusBefore = sh(root, 'git', ['status', '--porcelain=v2']);
    const indexBefore = readFileSync(join(repo.gitDir, 'index'));

    const snap = takeSnapshot(repo, 'sess-1');

    expect(sh(root, 'git', ['status', '--porcelain=v2'])).toBe(statusBefore);
    expect(readFileSync(join(repo.gitDir, 'index')).equals(indexBefore)).toBe(true);
    expect(sh(root, 'git', ['stash', 'list'])).toBe('');
    expect(sh(root, 'git', ['show', `${snap}:a.txt`])).toBe('two');
    expect(sh(root, 'git', ['show', `${snap}:new.txt`])).toBe('untracked');
    expect(sh(root, 'git', ['show', `${snap}:staged.txt`])).toBe('staged');
  });

  it('skips ignored files', () => {
    const root = makeRepo({ '.gitignore': '.env.local\n', 'a.txt': 'x\n' });
    write(root, { '.env.local': 'SECRET=1\n' });
    const snap = takeSnapshot(findRepo(root)!, 's');
    expect(sh(root, 'git', ['ls-tree', '--name-only', snap])).not.toContain('.env.local');
  });

  it('works in a repo with no commits yet', () => {
    const root = makeRepo({ 'a.txt': 'x\n' });
    rmSync(join(root, '.git'), { recursive: true });
    sh(root, 'git', ['init', '-q']);
    const snap = takeSnapshot(findRepo(root)!, 's');
    expect(sh(root, 'git', ['show', `${snap}:a.txt`])).toBe('x');
  });
});

describe('before/after copies', () => {
  it("puts only the session's edits in the after copy, never another window's", async () => {
    const root = makeRepo({ '.gitignore': 'node_modules\n.env*\n', 'mine.tsx': 'v1\n', 'theirs.tsx': 'v1\n', 'gone.tsx': 'here\n' });
    write(root, { 'node_modules/pkg/index.js': 'module.exports = 1\n', '.env.local': 'A=1\n' });
    const repo = findRepo(root)!;
    const snap = takeSnapshot(repo, 's');
    write(root, { 'mine.tsx': 'v2\n', 'theirs.tsx': 'other window\n' });
    rmSync(join(root, 'gone.tsx'));
    recordEdit(repo, 's', join(root, 'mine.tsx'), root);
    recordEdit(repo, 's', 'gone.tsx', root);
    const files = changedSince(repo, snap, editedFiles(repo, 's'));
    expect(files).toEqual(['gone.tsx', 'mine.tsx']);

    const out = join(tmpdir(), `bp-copies-${Date.now()}`);
    await materialize(repo, snap, join(out, 'before'), ['node_modules', '.env*']);
    await materialize(repo, snap, join(out, 'after'), ['node_modules', '.env*'], files);
    expect(readFileSync(join(out, 'before', 'mine.tsx'), 'utf8')).toBe('v1\n');
    expect(readFileSync(join(out, 'after', 'mine.tsx'), 'utf8')).toBe('v2\n');
    expect(readFileSync(join(out, 'after', 'theirs.tsx'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(out, 'before', 'gone.tsx'))).toBe(true);
    expect(existsSync(join(out, 'after', 'gone.tsx'))).toBe(false);
    expect(existsSync(join(out, 'after', 'node_modules', 'pkg', 'index.js'))).toBe(true);
    expect(readFileSync(join(out, 'after', '.env.local'), 'utf8')).toBe('A=1\n');
    rmSync(out, { recursive: true, force: true });
  });

  it('does not count a file edited and then put back as changed', () => {
    const root = makeRepo({ 'a.tsx': 'same\n' });
    const repo = findRepo(root)!;
    const snap = takeSnapshot(repo, 's');
    writeFileSync(join(root, 'a.tsx'), 'different\n');
    writeFileSync(join(root, 'a.tsx'), 'same\n');
    expect(changedSince(repo, snap, ['a.tsx'])).toEqual([]);
  });

  it('diffs new files against nothing', () => {
    const root = makeRepo({ 'a.tsx': 'x\n' });
    const repo = findRepo(root)!;
    const snap = takeSnapshot(repo, 's');
    write(root, { 'b.tsx': '<div className="text-[14px]" />\n' });
    const diff = sessionDiff(repo, snap, ['b.tsx']);
    expect(diff).toContain('+<div className="text-[14px]" />');
  });

  it('ignores edits to paths outside the repo', () => {
    const root = makeRepo({ 'a.tsx': 'x\n' });
    const repo = findRepo(root)!;
    expect(recordEdit(repo, 's', '/etc/hosts', root)).toBeNull();
    expect(recordEdit(repo, 's', '../elsewhere.tsx', root)).toBeNull();
    expect(editedFiles(repo, 's')).toEqual([]);
  });
});
