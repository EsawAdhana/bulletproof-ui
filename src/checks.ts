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

export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let file = '';
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? '' : p.replace(/^b\//, '');
    } else if (raw.startsWith('@@')) {
      const m = /\+(\d+)/.exec(raw);
      line = m ? Number(m[1]) : 0;
    } else if (raw.startsWith('+') && file) {
      out.push({ file, line, text: raw.slice(1) });
      line++;
    } else if (raw.startsWith(' ')) {
      line++;
    }
  }
  return out;
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
const IMPORTANT_TW = /(?:^|[\s"'`{])(?:[a-z0-9]+:)*![a-z][\w-]*/;
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

export function fastChecks(lines: AddedLine[], root: string, cfg: Config): CodeFinding[] {
  const primitives = availablePrimitives(root, cfg);
  const findings: CodeFinding[] = [];
  const push = (l: AddedLine, f: Omit<CodeFinding, 'file' | 'line' | 'text'>) =>
    findings.push({ ...f, file: l.file, line: l.line, text: l.text.trim().slice(0, 200) });

  for (const l of lines) {
    if (!isUiFile(l.file, cfg)) continue;
    const isTheme = cfg.themeFiles.some((p) => matchesGlob(l.file, p));
    const isPrimitive = !!cfg.componentsDir && l.file.startsWith(cfg.componentsDir + '/');
    const isCss = /\.(s?css)$/.test(l.file);
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

    if (isCss ? IMPORTANT_CSS.test(code) : IMPORTANT_TW.test(code) || IMPORTANT_CSS.test(code)) {
      push(l, {
        rule: 'important',
        severity: 'block',
        problem: 'Forces a style with !important, which hides the real conflict.',
        fix: 'Remove the override and fix the class or component that conflicts.',
      });
    }
    if (isPrimitive) continue;

    for (const m of code.matchAll(ARBITRARY)) {
      push(l, {
        rule: 'one-off-value',
        severity: 'block',
        problem: `\`${m[0]}\` is a one-off value instead of one from the theme.`,
        fix: 'Use the nearest theme class (for example text-sm instead of text-[14px]) or add the value to the theme.',
      });
    }
    const hexes = [...code.matchAll(HEX)].filter((m) => !code.includes(`-[${m[0]}`));
    if (hexes.length || (COLOR_FN.test(code) && !ARBITRARY.test(code))) {
      ARBITRARY.lastIndex = 0;
      push(l, {
        rule: 'hard-coded-color',
        severity: 'block',
        problem: `Hard-coded color${hexes.length ? ` ${hexes.map((m) => m[0]).join(', ')}` : ''}.`,
        fix: 'Use a theme color class or CSS variable so it follows light and dark mode.',
      });
    }
    if (!isCss && INLINE_STYLE.test(code)) {
      push(l, {
        rule: 'inline-style',
        severity: 'block',
        problem: 'Inline style with a fixed value.',
        fix: 'Use theme classes. Inline styles are for values computed at runtime only.',
      });
    }
    if (!isCss) {
      for (const [el, importPath] of primitives) {
        if (new RegExp(`<${el}(?=[\\s>/])`).test(code)) {
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
