// The judge: a fresh, read-only, headless session of the developer's own agent
// CLI that looks at the changed screenshots and says what a picky developer
// would send back. It is never the agent that did the work.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CodeFinding } from './checks.ts';
import type { Config } from './config.ts';

export const JudgeFinding = z.object({
  shot: z.string().describe('Screenshot id the problem is in, or "code" for a problem only visible in the diff.'),
  severity: z.enum(['block', 'unsure']),
  problem: z.string(),
  fix: z.string(),
});
export type JudgeFinding = z.infer<typeof JudgeFinding>;

export const JudgeOutput = z.object({
  reviewed: z.array(z.string()).describe('Ids of every screenshot actually opened and looked at.'),
  findings: z.array(JudgeFinding),
  summary: z.string(),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;

export interface JudgeShot {
  id: string;
  route: string;
  viewport: string;
  scheme: string;
  /** before | after crop with changes outlined in red. */
  image: string;
  changedPercent: number;
}

export interface JudgeInput {
  request: string;
  diff: string;
  codeFindings: CodeFinding[];
  shots: JudgeShot[];
  components: string[];
  themeFiles: string[];
  taste: string;
}

export interface JudgeResult {
  output: JudgeOutput | null;
  error: string | null;
  costUsd: number | null;
  ms: number;
}

const MAX_DIFF = 40_000;

export function buildPrompt(input: JudgeInput): string {
  const diff = input.diff.length > MAX_DIFF ? input.diff.slice(0, MAX_DIFF) + '\n[diff truncated]' : input.diff;
  return `You are reviewing a UI change a coding agent just made, before the developer sees it. Decide whether the developer would accept it or send it back.

## What the developer asked for
${input.request || '(The request was not available. Judge the change on its own.)'}

## How to judge
1. Open every screenshot listed below with the Read tool. Each one is the page BEFORE (left) and AFTER (right) the change, cropped around the changed areas, which are outlined in red.
2. Anything the developer asked for is expected to change. Anything else that looks different is a problem.
3. New work must look like the rest of the app: same spacing, type sizes, colors, radius and components as the surrounding UI. Compare against the BEFORE side and the app's existing components.
4. Look for what a user would hit: text cut off or overlapping, things too small to tap on a phone, low contrast (especially in dark mode), broken alignment, layout that only works at one width.
5. Use "block" only when you are confident the developer would send it back. Use "unsure" when it is a judgment call they should make. Do not report things that are fine.
6. Each finding names the screenshot id, the problem in one plain sentence, and the fix in one plain sentence.

## Screenshots that changed
${input.shots.map((s) => `- id: ${s.id} (page ${s.route}, ${s.viewport}, ${s.scheme} mode, ${s.changedPercent.toFixed(2)}% of pixels changed): ${s.image}`).join('\n')}

## Code problems already found by plain checks (already reported; do not repeat them)
${input.codeFindings.length ? input.codeFindings.map((f) => `- ${f.file}:${f.line} ${f.problem}`).join('\n') : '(none)'}

## The app's own components
${input.components.length ? input.components.join(', ') : '(none found)'}
Theme files: ${input.themeFiles.join(', ') || '(none found)'}

## The developer's saved taste rules
${input.taste || '(none yet)'}

## The diff
\`\`\`diff
${diff}
\`\`\`

List in "reviewed" the id of every screenshot you actually opened.`;
}

export async function runJudge(input: JudgeInput, cfg: Config, runDir: string): Promise<JudgeResult> {
  const started = Date.now();
  const prompt = buildPrompt(input);
  writeFileSync(join(runDir, 'judge-prompt.md'), prompt);
  // The CLI's validator doesn't know the draft 2020-12 meta-schema URL, so leave it out.
  const { $schema: _, ...schemaBody } = z.toJSONSchema(JudgeOutput) as Record<string, unknown>;
  const schema = JSON.stringify(schemaBody);
  const [cmd, ...lead] = cfg.judge.command;
  const args = [
    ...lead,
    '-p',
    prompt,
    '--output-format',
    'json',
    '--json-schema',
    schema,
    '--tools',
    'Read',
    '--allowedTools',
    'Read',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--add-dir',
    runDir,
    '--model',
    cfg.judge.model,
  ];
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: runDir,
        // The flag makes Bulletproof's own hooks skip the judge's session.
        env: { ...process.env, BULLETPROOF_JUDGE: '1' },
        timeout: cfg.judge.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const ms = Date.now() - started;
        writeFileSync(join(runDir, 'judge-raw.json'), stdout || '');
        if (err && !stdout) {
          const why = err.killed ? `timed out after ${Math.round(cfg.judge.timeoutMs / 1000)}s` : (stderr || err.message).trim().split('\n').slice(-3).join(' ');
          return resolve({ output: null, error: `Judge failed: ${why}`, costUsd: null, ms });
        }
        try {
          const raw = JSON.parse(stdout);
          const parsed = JudgeOutput.safeParse(raw.structured_output ?? safeJson(raw.result));
          if (!parsed.success) return resolve({ output: null, error: `Judge returned an unexpected shape: ${raw.result ?? stdout.slice(0, 300)}`, costUsd: raw.total_cost_usd ?? null, ms });
          resolve({ output: parsed.data, error: null, costUsd: raw.total_cost_usd ?? null, ms });
        } catch {
          resolve({ output: null, error: `Judge output was not JSON: ${stdout.slice(0, 300)}`, costUsd: null, ms });
        }
      },
    );
    // The prompt is an argument; an open stdin makes the CLI wait for more input.
    child.stdin?.end();
  });
}

function safeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Taste rules the developer saved. The alpha only reads them; writing them is the final milestone. */
export function readTaste(stateDir: string, root: string): string {
  return [join(root, '.bulletproof', 'taste.md'), join(stateDir, 'taste.md')]
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p, 'utf8').trim())
    .join('\n\n');
}
