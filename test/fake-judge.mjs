#!/usr/bin/env node
// Stands in for the agent CLI in tests. Reads the screenshot ids out of the
// prompt and answers like `claude -p --output-format json --json-schema` would.
//   FAKE_JUDGE=pass   (default) looked at everything, no findings
//   FAKE_JUDGE=block  one confident problem on the first screenshot
//   FAKE_JUDGE=skip   claims to have reviewed nothing
//   FAKE_JUDGE=crash  exits non-zero with no output
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] ?? '';
const ids = [...prompt.matchAll(/^- id: (\S+) \(/gm)].map((m) => m[1]);
const mode = process.env.FAKE_JUDGE ?? 'pass';

if (mode === 'crash') {
  process.stderr.write('fake judge crashed\n');
  process.exit(1);
}
const findings = mode === 'block' && ids.length ? [{ shot: ids[0], severity: 'block', problem: 'The new element overlaps the title.', fix: 'Give it its own line.' }] : [];
const structured_output = { reviewed: mode === 'skip' ? [] : ids, findings, summary: `fake judge (${mode})` };
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, result: JSON.stringify(structured_output), structured_output }));
