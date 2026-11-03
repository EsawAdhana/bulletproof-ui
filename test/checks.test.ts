import { describe, expect, it } from 'vitest';
import { addedLines, fastChecks, removedText } from '../src/checks.ts';
import { Config } from '../src/config.ts';
import { makeRepo } from './helpers.ts';

const root = makeRepo({ 'components/ui/button.tsx': 'export function Button() {}\n', 'components/ui/input.tsx': 'export function Input() {}\n' });
const cfg = Config.parse({ componentsDir: 'components/ui' });

function rules(code: string, file = 'components/card.tsx'): string[] {
  return fastChecks([{ file, line: 1, text: code }], root, cfg).map((f) => `${f.rule}:${f.severity}`);
}

describe('fast checks catch', () => {
  it.each([
    ['one-off text size', '<p className="text-[14px]">', 'one-off-value:block'],
    ['one-off spacing', '<div className="mt-[7px] px-4">', 'one-off-value:block'],
    ['arbitrary color', '<div className="bg-[#1a2b3c]">', 'one-off-value:block'],
    ['responsive one-off', '<div className="md:w-[37rem]">', 'one-off-value:block'],
    ['hex in a style', '<div style={{ color: "#2563eb" }}>', 'hard-coded-color:block'],
    ['rgb literal', 'const c = "rgb(12, 34, 56)"', 'hard-coded-color:block'],
    ['inline fixed style', '<div style={{ marginTop: 12 }}>', 'inline-style:block'],
    ['plain button', '<button onClick={go}>Go</button>', 'plain-element:block'],
    ['plain input', '<input type="text" />', 'plain-element:block'],
    ['tailwind important', '<p className="!text-red-500">', 'important:block'],
    ['css important', '.card { color: red !important; }', 'important:block'],
  ])('%s', (_name, code, rule) => {
    const file = code.startsWith('.card') ? 'components/card.css' : 'components/card.tsx';
    expect(rules(code, file)).toContain(rule);
  });

  it('still flags a problem hidden behind a lint-disable comment', () => {
    const r = rules('<button className="text-[13px]" /> {/* eslint-disable-line */}');
    expect(r).toContain('suppression:warn');
    expect(r).toContain('plain-element:block');
    expect(r).toContain('one-off-value:block');
  });
});

describe('fast checks leave alone', () => {
  it.each([
    ['theme classes', '<p className="mt-2 text-sm text-muted">'],
    ["the app's Button", '<Button variant="ghost">Go</Button>'],
    ['a CSS variable value', '<div className="bg-[var(--brand)]">'],
    ['layout expressions', '<div className="grid grid-cols-[1fr_auto] w-[calc(100%-2rem)]">'],
    ['a style computed at runtime', '<div style={{ width: `${pct}%` }}>'],
    ['an anchor link', '<a href="#details">'],
  ])('%s', (_name, code) => {
    expect(rules(code)).toEqual([]);
  });

  it('lets the primitives themselves use plain elements', () => {
    expect(rules('<button className="h-10" />', 'components/ui/button.tsx')).toEqual([]);
  });

  it('lets theme files define raw colors', () => {
    expect(rules('--brand: #8c1515;', 'app/globals.css')).toEqual([]);
  });

  it('skips tests and non-UI files', () => {
    expect(rules('<button style={{ color: "#fff" }} />', 'components/card.test.tsx')).toEqual([]);
    expect(rules('const c = "#ffffff"', 'lib/colors.ts')).toEqual([]);
  });
});

describe('addedLines', () => {
  it('numbers added lines from the hunk header', () => {
    const diff = ['--- a/x.tsx', '+++ b/x.tsx', '@@ -1,3 +10,4 @@', ' keep', '-gone', '+new one', '+new two', ' keep'].join('\n');
    expect(addedLines(diff)).toEqual([
      { file: 'x.tsx', line: 11, text: 'new one' },
      { file: 'x.tsx', line: 12, text: 'new two' },
    ]);
  });
});

describe('false alarms found dogfooding on Stanford Root', () => {
  it.each([
    ['a negated call', "if (!selectedTerms.includes('any')) {"],
    ['a negation in JSX', '{!hasOpenSeat(course) && <Pill />}'],
    ['a negation after &&', 'const show = ready && !loading'],
    ['an exclamation in copy', '<p>Seats are going fast!</p>'],
  ])('does not read %s as !important', (_name, code) => {
    expect(rules(code)).toEqual([]);
  });

  it.each([
    ['a className', '<p className="!text-red-500">'],
    ['a responsive variant in cn()', "<div className={cn('md:!p-0', x)}>"],
    ['a template string', '<div className={`hover:!bg-brand ${x}`}>'],
  ])('still catches Tailwind important in %s', (_name, code) => {
    expect(rules(code)).toContain('important:block');
  });

  it('does not blame a moved or re-wrapped line for a value that was already there', () => {
    const diff = [
      '--- a/components/card.tsx',
      '+++ b/components/card.tsx',
      '@@ -10,1 +10,4 @@',
      '-      <span className="text-[15px] font-bold">{code}</span>',
      '+      <span className="flex items-center gap-2">',
      '+        <span className="text-[15px] font-bold">{code}</span>',
      '+        <span className="text-[11px]">Full</span>',
      '+      </span>',
    ].join('\n');
    const found = fastChecks(addedLines(diff), root, cfg, removedText(diff)).map((f) => f.problem);
    expect(found).toEqual(['`text-[11px]` is a one-off value instead of one from the theme.']);
  });

  it('does not mistake a removed line that starts with dashes for a file header', () => {
    const diff = ['--- a/x.css', '+++ b/x.css', '@@ -1,2 +1,2 @@', '--- old comment', '+.a { color: red !important; }'].join('\n');
    expect(removedText(diff).get('x.css')).toBe('-- old comment\n');
    expect(addedLines(diff)).toHaveLength(1);
  });
});
