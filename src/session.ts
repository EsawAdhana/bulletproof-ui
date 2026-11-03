// One record per agent session: the snapshot taken when it started and every
// path it edited. Edits go to an append-only log because an agent can run
// several edit tools at once and each fires its own hook process.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { Repo } from './repo.ts';

export const Session = z.object({
  id: z.string(),
  snapshot: z.string(),
  startedAt: z.string(),
  /** Blocks used since the developer's last message. */
  rounds: z.number().default(0),
  /** Content hash of the edited files when the last check passed; an unchanged set is not re-checked. */
  passedFingerprint: z.string().nullable().default(null),
  runs: z.array(z.string()).default([]),
});
export type Session = z.infer<typeof Session>;

function dir(repo: Repo): string {
  const d = join(repo.stateDir, 'sessions');
  mkdirSync(d, { recursive: true });
  return d;
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

export function loadSession(repo: Repo, id: string): Session | null {
  const file = join(dir(repo), `${safeId(id)}.json`);
  return existsSync(file) ? Session.parse(JSON.parse(readFileSync(file, 'utf8'))) : null;
}

export function saveSession(repo: Repo, s: Session): void {
  writeFileSync(join(dir(repo), `${safeId(s.id)}.json`), JSON.stringify(s, null, 2));
}

/** Records an edited path. Paths outside the repo are ignored; returns the repo-relative path or null. */
export function recordEdit(repo: Repo, id: string, filePath: string, cwd: string): string | null {
  const abs = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const rel = relative(repo.root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  appendFileSync(join(dir(repo), `${safeId(id)}.edits`), rel + '\n');
  return rel;
}

export function editedFiles(repo: Repo, id: string): string[] {
  const file = join(dir(repo), `${safeId(id)}.edits`);
  if (!existsSync(file)) return [];
  return [...new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean))].sort();
}
