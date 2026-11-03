// Plain-code checks on the lines the session added. No model involved: new UI
// code must use the app's theme values and its own components.
import { existsSync, readdirSync } from 'node:fs';
import { basename, extname, join, matchesGlob } from 'node:path';
import type { Config } from './config.ts';

export interface AddedLine {
  file: string;
  line: number;
  text: string;
}

export interface CodeFinding {
  rule: string;
  /** block: deterministic and wrong. warn: passed to the judge as context. */
  severity: 'block' | 'warn';
  file: string;
  line: number;
  text: string;
  problem: string;
  fix: string;
}

/** Walks a unified diff. Header lines are only read outside hunks, so a removed "-- comment" is not taken for a "--- a/file" header. */
function walkDiff(diff: string, onLine: (kind: '+' | '-', file: string, line: number, text: string) => void): void {
  let file = '';
  let line = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff ')) {
      inHunk = false;
    } else if (!inHunk && raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? '' : p.replace(/^b\//, '');
    } else if (!inHunk && raw.startsWith('--- ')) {
      // The old name; the new one on the +++ line is what we key on.
    } else if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      line = m ? Number(m[1]) : 0;
      inHunk = true;
    } else if (inHunk && raw.startsWith('+') && file) {
      onLine('+', file, line, raw.slice(1));
      line++;
    } else if (inHunk && raw.startsWith('-') && file) {
      onLine('-', file, line, raw.slice(1));
    } else if (inHunk && raw.startsWith(' ')) {
      line++;
    }
  }
}

export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  walkDiff(diff, (kind, file, line, text) => kind === '+' && out.push({ file, line, text }));
  return out;
}

/** Removed lines per file, so code that was only moved or re-wrapped is not blamed as new. */
export function removedText(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  walkDiff(diff, (kind, file, _line, text) => kind === '-' && out.set(file, (out.get(file) ?? '') + text + '\n'));
  return out;
}

/** True when index falls inside a quoted string or template literal on this line. */
function insideString(code: string, index: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < index; i++) {
    const c = code[i];
    if (c === '\\') {
      i++;
    } else if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    }
  }
  return quote !== null;
}

export function isUiFile(file: string, cfg: Config): boolean {
  if (!cfg.uiExtensions.includes(extname(file))) return false;
  return !cfg.uiExclude.some((p) => matchesGlob(file, p));
}

// Arbitrary Tailwind values that stand in for a theme value: sizes, spacing and colors.
// Layout expressions like grid-cols-[1fr_auto] or w-[calc(...)] are left alone.
const ARBITRARY = /(?<![\w-])(?:[a-z0-9]+:)*!?-?[a-z][a-z0-9-]*-\[(?:-?\d*\.?\d+(?:px|rem|em|pt|vh|vw|%)?|#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch)\([^\]]*\))\]/g;
const HEX = /(?<![\w&/#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const COLOR_FN = /\b(?:rgb|rgba|hsl|hsla|oklch)\(\s*\d/;
const INLINE_STYLE = /style=\{\{[^}]*?:\s*(?:['"`][^'"`$]*['"`]|-?\d)/;
const IMPORTANT_CSS = /!important/;
// Tailwind's important prefix (!text-red-500, md:!p-0). Only counted inside a string,
// because the same shape outside one is JavaScript's "not" (!hasOpenSeat(...)).
const IMPORTANT_TW = /(?<=^|[\s"'`])(?:[a-z0-9-]+:)*!-?[a-z][\w-]*/g;
const SUPPRESS = /eslint-disable|@ts-ignore|@ts-expect-error|stylelint-disable|biome-ignore/;

/** Plain HTML elements the app already wraps, keyed by the primitive's file name. */
const PRIMITIVES: Record<string, string[]> = {
  button: ['button'],
  input: ['input'],
  select: ['select'],
  textarea: ['textarea'],
  dialog: ['dialog'],
  checkbox: ['input type="checkbox"'],
};

export function availablePrimitives(root: string, cfg: Config): Map<string, string> {
  const found = new Map<string, string>(); // element -> import path
  if (!cfg.componentsDir) return found;
  const dir = join(root, cfg.componentsDir);
  if (!existsSync(dir)) return found;
  for (const f of readdirSync(dir)) {
    const name = basename(f, extname(f));
    for (const el of PRIMITIVES[name] ?? []) {
      found.set(el.split(' ')[0], `${cfg.componentsDir}/${name}`);
    }
  }
  return found;
}

export function fastChecks(lines: AddedLine[], root: string, cfg: Config, removed: Map<string, string> = new Map()): CodeFinding[] {
  const primitives = availablePrimitives(root, cfg);
  const findings: CodeFinding[] = [];
  const push = (l: AddedLine, f: Omit<CodeFinding, 'file' | 'line' | 'text'>) =>
    findings.push({ ...f, file: l.file, line: l.line, text: l.text.trim().slice(0, 200) });

  for (const l of lines) {
    if (!isUiFile(l.file, cfg)) continue;
    const isTheme = cfg.themeFiles.some((p) => matchesGlob(l.file, p));
    const isPrimitive = !!cfg.componentsDir && l.file.startsWith(cfg.componentsDir + '/');
    const isCss = /\.(s?css)$/.test(l.file);
    // A snippet that was also on a removed line of the same file was moved, not added.
    const wasThere = (snippet: string) => removed.get(l.file)?.includes(snippet) ?? false;
    const code = l.text;

    if (SUPPRESS.test(code)) {
      push(l, {
        rule: 'suppression',
        severity: 'warn',
        problem: 'Adds a comment that silences a check.',
        fix: 'Fix the cause instead of silencing it, or explain why the check is wrong here.',
      });
    }
    if (isTheme) continue;

    const twImportant = isCss ? [] : [...code.matchAll(IMPORTANT_TW)].filter((m) => insideString(code, m.index) && !wasThere(m[0]));
    const cssImportant = IMPORTANT_CSS.test(code) && !wasThere('!important');
    if (twImportant.length || cssImportant) {
      push(l, {
        rule: 'important',
        severity: 'block',
        problem: 'Forces a style with !important, which hides the real conflict.',
        fix: 'Remove the override and fix the class or component that conflicts.',
      });
    }
    if (isPrimitive) continue;

    for (const m of code.matchAll(ARBITRARY)) {
      if (wasThere(m[0])) continue;
      push(l, {
        rule: 'one-off-value',
        severity: 'block',
        problem: `\`${m[0]}\` is a one-off value instead of one from the theme.`,
        fix: 'Use the nearest theme class (for example text-sm instead of text-[14px]) or add the value to the theme.',
      });
    }
    const hexes = [...code.matchAll(HEX)].filter((m) => !code.includes(`-[${m[0]}`) && !wasThere(m[0]));
    const colorFn = COLOR_FN.exec(code);
    ARBITRARY.lastIndex = 0;
    if (hexes.length || (colorFn && !ARBITRARY.test(code) && !wasThere(colorFn[0]))) {
      ARBITRARY.lastIndex = 0;
      push(l, {
        rule: 'hard-coded-color',
        severity: 'block',
        problem: `Hard-coded color${hexes.length ? ` ${hexes.map((m) => m[0]).join(', ')}` : ''}.`,
        fix: 'Use a theme color class or CSS variable so it follows light and dark mode.',
      });
    }
    const inline = isCss ? null : INLINE_STYLE.exec(code);
    if (inline && !wasThere(inline[0])) {
      push(l, {
        rule: 'inline-style',
        severity: 'block',
        problem: 'Inline style with a fixed value.',
        fix: 'Use theme classes. Inline styles are for values computed at runtime only.',
      });
    }
    if (!isCss) {
      for (const [el, importPath] of primitives) {
        const tag = new RegExp(`<${el}(?=[\\s>/])[^>]*`).exec(code);
        if (tag && !wasThere(tag[0])) {
          push(l, {
            rule: 'plain-element',
            severity: 'block',
            problem: `Plain <${el}> where the app has its own component.`,
            fix: `Use the component from ${importPath}.`,
          });
        }
      }
    }
  }
  return findings;
}
