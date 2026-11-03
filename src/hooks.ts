// Claude Code hook handlers. Each hook is a separate process that reads the
// agent's JSON on stdin and answers on stdout. A Bulletproof bug must never
// stop the developer's agent, so every failure ends in "not checked", not a crash.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCheck, type RunResult } from './check.ts';
import { loadConfig } from './config.ts';
import { findRepo, git, type Repo } from './repo.ts';
import { editedFiles, loadSession, recordEdit, saveSession, type Session } from './session.ts';
import { changedSince, fingerprint, takeSnapshot } from './snapshot.ts';

export interface HookInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  hook_event_name?: string;
  source?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: { file_path?: string; notebook_path?: string; command?: string };
  stop_hook_active?: boolean;
}

export type HookOutput = Record<string, unknown> | null;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export async function handleHook(event: string, input: HookInput): Promise<HookOutput> {
  if (process.env.BULLETPROOF_JUDGE) return null;
  const repo = findRepo(input.cwd);
  if (!repo) return null;
  switch (event) {
    case 'session-start':
      return sessionStart(repo, input);
    case 'user-prompt-submit':
      return userPromptSubmit(repo, input);
    case 'pre-tool-use':
      return preToolUse(repo, input);
    case 'post-tool-use':
      return postToolUse(repo, input);
    case 'stop':
      return stop(repo, input);
    default:
      throw new Error(`Unknown hook event: ${event}`);
  }
}

function startSession(repo: Repo, id: string): Session {
  const s: Session = { id, snapshot: takeSnapshot(repo, id), startedAt: new Date().toISOString(), rounds: 0, passedFingerprint: null, runs: [] };
  saveSession(repo, s);
  return s;
}

function sessionStart(repo: Repo, input: HookInput): HookOutput {
  // Resuming or compacting keeps the original snapshot; the "before" is still the start of the session.
  if (!loadSession(repo, input.session_id)) startSession(repo, input.session_id);
  return null;
}

function userPromptSubmit(repo: Repo, input: HookInput): HookOutput {
  // Fallback for hooks installed mid-session: the first prompt takes the snapshot.
  const s = loadSession(repo, input.session_id) ?? startSession(repo, input.session_id);
  // A new message from the developer gives the agent a fresh set of rounds.
  if (s.rounds) saveSession(repo, { ...s, rounds: 0 });
  return null;
}

// Agents also edit through the shell (sed, python, codegen). Before each shell
// command, note the content of every dirty file; after it, whatever changed in
// between belongs to this session. Another window saving during that same command
// would be credited too, which is the safer mistake: it gets checked, not skipped.
function preToolUse(repo: Repo, input: HookInput): HookOutput {
  if (input.tool_name !== 'Bash' || !input.tool_use_id) return null;
  if (!loadSession(repo, input.session_id)) startSession(repo, input.session_id);
  writeFileSync(shellMarkPath(repo, input), JSON.stringify(dirtyState(repo)));
  return null;
}

function shellMarkPath(repo: Repo, input: HookInput): string {
  const dir = join(repo.stateDir, 'sessions');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${input.session_id.replace(/[^A-Za-z0-9_-]/g, '_')}.shell-${input.tool_use_id!.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

/** Content hash of every file git sees as changed, added or deleted right now. */
export function dirtyState(repo: Repo): Record<string, string> {
  const out: Record<string, string> = {};
  const status = git(repo.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const paths: string[] = [];
  const entries = status.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    paths.push(e.slice(3));
    if (e[0] === 'R' || e[0] === 'C') i++; // the next entry is the rename's source
  }
  const existing = paths.filter((p) => existsSync(join(repo.root, p)));
  const hashes = existing.length ? git(repo.root, ['hash-object', '--', ...existing]).split('\n') : [];
  existing.forEach((p, i) => (out[p] = hashes[i]));
  for (const p of paths) if (!(p in out)) out[p] = 'deleted';
  return out;
}

function shellEdits(repo: Repo, input: HookInput): string[] {
  const mark = shellMarkPath(repo, input);
  if (!existsSync(mark)) return [];
  const before: Record<string, string> = JSON.parse(readFileSync(mark, 'utf8'));
  rmSync(mark, { force: true });
  const after = dirtyState(repo);
  const touched = new Set<string>();
  for (const p of new Set([...Object.keys(before), ...Object.keys(after)])) {
    // A file that went from dirty back to clean is in "before" only; it changed too.
    if (before[p] !== after[p]) touched.add(p);
  }
  return [...touched];
}

function postToolUse(repo: Repo, input: HookInput): HookOutput {
  if (input.tool_name === 'Bash') {
    for (const p of shellEdits(repo, input)) recordEdit(repo, input.session_id, p, repo.root);
    return null;
  }
  if (!input.tool_name || !EDIT_TOOLS.has(input.tool_name)) return null;
  const path = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!path) return null;
  if (!loadSession(repo, input.session_id)) startSession(repo, input.session_id);
  recordEdit(repo, input.session_id, path, input.cwd);
  return null;
}

async function stop(repo: Repo, input: HookInput): Promise<HookOutput> {
  const session = loadSession(repo, input.session_id);
  if (!session) return null;
  const files = editedFiles(repo, session.id);
  const changed = changedSince(repo, session.snapshot, files);
  if (!changed.length) return null;
  const print = fingerprint(repo, changed);
  if (print === session.passedFingerprint) return null;

  const cfg = loadConfig(repo);
  const result = await runCheck({ repo, cfg, snapshot: session.snapshot, files: changed, request: readRequest(input.transcript_path) });
  session.runs.push(result.id);
  if (result.status === 'skipped') {
    saveSession(repo, session);
    return null;
  }
  if (result.status === 'block' && session.rounds < cfg.maxRounds) {
    session.rounds += 1;
    saveSession(repo, session);
    return { decision: 'block', reason: blockMessage(result, session.rounds, cfg.maxRounds) };
  }
  if (result.status === 'pass') session.passedFingerprint = print;
  saveSession(repo, session);
  return { systemMessage: finalMessage(result, result.status === 'block') };
}

/** The developer's own words from this session, newest last. */
export function readRequest(transcriptPath: string | undefined): string {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  const prompts: string[] = [];
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== 'user' || d.isMeta || d.toolUseResult) continue;
    const c = d.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') : '';
    if (text.trim() && !text.trimStart().startsWith('<') && !text.includes('Bulletproof checked')) prompts.push(text.trim());
  }
  const recent = prompts.slice(-3);
  return recent.map((p, i) => (i === recent.length - 1 ? `Latest message:\n${p}` : `Earlier message:\n${p}`)).join('\n\n');
}

export function blockMessage(r: RunResult, round: number, max: number): string {
  const lines = [`Bulletproof checked your UI change and found problems the developer would send back (round ${round} of ${max}). Fix each one, then finish again.`, ''];
  for (const f of r.hardFailures) lines.push(`- ${f.problem} Fix: ${f.fix}`);
  for (const f of r.codeFindings.filter((x) => x.severity === 'block')) lines.push(`- ${f.file}:${f.line} ${f.problem} Fix: ${f.fix}`);
  for (const f of r.judge?.findings.filter((x) => x.severity === 'block') ?? []) lines.push(`- [${f.shot}] ${f.problem} Fix: ${f.fix}`);
  lines.push('', `Screenshots: ${r.runDir}/diff (side-by-side before | after, changes outlined in red).`);
  if (r.reviewPath) lines.push(`Review page: ${pathToFileURL(r.reviewPath).href}`);
  return lines.join('\n');
}

export function finalMessage(r: RunResult, outOfRounds: boolean): string {
  const shots = r.shots.filter((s) => s.after).length;
  const head = outOfRounds
    ? `Bulletproof: problems remain after ${r.routes.length ? 'the last round' : 'checking'}; not blocking again.`
    : `Bulletproof checked ${r.routes.length} page(s), ${shots} screenshot pair(s), in ${Math.round(r.ms / 1000)}s.`;
  const lines = [head];
  const unsure = r.judge?.findings.filter((f) => f.severity === 'unsure') ?? [];
  if (unsure.length) lines.push(`${unsure.length} question(s) for you on the review page.`);
  if (r.notChecked.length) lines.push(`Not checked: ${r.notChecked.slice(0, 4).join(' | ')}${r.notChecked.length > 4 ? ` (+${r.notChecked.length - 4} more)` : ''}`);
  if (r.reviewPath) lines.push(`Review: ${pathToFileURL(r.reviewPath).href}`);
  return lines.join('\n');
}
