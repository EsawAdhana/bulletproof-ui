import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleHook, readRequest } from '../src/hooks.ts';
import { findRepo } from '../src/repo.ts';
import { editedFiles, loadSession, saveSession } from '../src/session.ts';
import { makeRepo, ROOT, write } from './helpers.ts';

const CLI = join(ROOT, 'src', 'cli.ts');

function runHook(event: string, input: object, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', event], { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe('hooks', () => {
  it('records every edit when the agent runs many edit tools at once', async () => {
    const root = makeRepo({ 'a.tsx': 'x\n' });
    await handleHook('session-start', { session_id: 'par', cwd: root });
    const files = Array.from({ length: 12 }, (_, i) => `c${i}.tsx`);
    await Promise.all(files.map((f) => runHook('post-tool-use', { session_id: 'par', cwd: root, tool_name: 'Write', tool_input: { file_path: join(root, f) } })));
    expect(editedFiles(findRepo(root)!, 'par')).toEqual([...files].sort());
  });

  it('only records edit tools, and never edits made by other windows', async () => {
    const root = makeRepo({ 'a.tsx': 'x\n' });
    await handleHook('session-start', { session_id: 's', cwd: root });
    write(root, { 'other-window.tsx': 'not mine\n' });
    await handleHook('post-tool-use', { session_id: 's', cwd: root, tool_name: 'Read', tool_input: { file_path: join(root, 'a.tsx') } });
    await handleHook('post-tool-use', { session_id: 's', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'a.tsx') } });
    expect(editedFiles(findRepo(root)!, 's')).toEqual(['a.tsx']);
  });

  it('takes the snapshot on the first prompt when hooks were installed mid-session', async () => {
    const root = makeRepo({ 'a.tsx': 'x\n' });
    await handleHook('user-prompt-submit', { session_id: 'late', cwd: root });
    expect(loadSession(findRepo(root)!, 'late')?.snapshot).toMatch(/^[0-9a-f]{40}$/);
  });

  it('keeps the original snapshot when a session resumes', async () => {
    const root = makeRepo({ 'a.tsx': 'x\n' });
    const repo = findRepo(root)!;
    await handleHook('session-start', { session_id: 'r', cwd: root });
    const first = loadSession(repo, 'r')!.snapshot;
    write(root, { 'a.tsx': 'changed\n' });
    await handleHook('session-start', { session_id: 'r', cwd: root, source: 'resume' });
    expect(loadSession(repo, 'r')!.snapshot).toBe(first);
  });

  it('resets the rounds when the developer sends a new message', async () => {
    const root = makeRepo({ 'a.tsx': 'x\n' });
    const repo = findRepo(root)!;
    await handleHook('session-start', { session_id: 'q', cwd: root });
    saveSession(repo, { ...loadSession(repo, 'q')!, rounds: 3 });
    await handleHook('user-prompt-submit', { session_id: 'q', cwd: root });
    expect(loadSession(repo, 'q')!.rounds).toBe(0);
  });

  it('lets the agent finish when nothing it edited changed', async () => {
    const root = makeRepo({ 'a.tsx': 'x\n' });
    await handleHook('session-start', { session_id: 'n', cwd: root });
    await handleHook('post-tool-use', { session_id: 'n', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'a.tsx') } });
    expect(await handleHook('stop', { session_id: 'n', cwd: root })).toBeNull();
  });

  it('skips non-UI changes without starting anything', async () => {
    const root = makeRepo({ 'lib/math.ts': 'export const one = 1;\n' });
    await handleHook('session-start', { session_id: 'u', cwd: root });
    write(root, { 'lib/math.ts': 'export const one = 2;\n' });
    await handleHook('post-tool-use', { session_id: 'u', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'lib/math.ts') } });
    const t = Date.now();
    expect(await handleHook('stop', { session_id: 'u', cwd: root })).toBeNull();
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("does nothing inside the judge's own session", async () => {
    const root = makeRepo({ 'a.tsx': 'x\n' });
    const { stdout } = await runHook('session-start', { session_id: 'j', cwd: root }, { BULLETPROOF_JUDGE: '1' });
    expect(stdout).toBe('');
    expect(loadSession(findRepo(root)!, 'j')).toBeNull();
  });

  it('does nothing outside a git repo', async () => {
    expect(await handleHook('stop', { session_id: 'x', cwd: '/' })).toBeNull();
  });

  it('turns its own crash into "not checked" instead of breaking the agent', async () => {
    const { code, stdout } = await runHook('stop', { not: 'valid' });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).systemMessage).toMatch(/not checked/);
  });
});

describe('readRequest', () => {
  it("keeps the developer's own words and drops tool results, meta and command noise", () => {
    const root = makeRepo({ 'a.txt': 'x\n' });
    const t = join(root, 't.jsonl');
    writeFileSync(
      t,
      [
        { type: 'user', message: { content: 'Make the header sticky.' } },
        { type: 'user', isMeta: true, message: { content: 'meta' } },
        { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } },
        { type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'file' }] } },
        { type: 'user', message: { content: [{ type: 'text', text: 'Also make it blue on mobile.' }] } },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n'),
    );
    const r = readRequest(t);
    expect(r).toContain('Earlier message:\nMake the header sticky.');
    expect(r).toContain('Latest message:\nAlso make it blue on mobile.');
    expect(r).not.toContain('meta');
    expect(r).not.toContain('/clear');
  });
});
