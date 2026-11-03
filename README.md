# Bulletproof

Coding agents say "done" on UI changes without looking at the result the way a
user would: on a phone, in dark mode, next to the rest of the app. Bulletproof
hooks into the agent's "done". It screenshots every page the change touches,
before and after, checks the new code against the app's own components and
theme, and asks a judge whether the developer would accept the change. If not,
the agent gets the problems back and keeps working, up to 3 rounds. If so, it
finishes with a link to a review page. Anything Bulletproof could not check is
listed as "not checked", never as passed.

Alpha: Claude Code on Next.js apps. Cursor, Codex, signed-in pages and a
learned taste profile come in the final release.

## Try it

Requires Node 24, git, and the agent CLI you already use (`claude`).

```bash
git clone https://github.com/EsawAdhana/bulletproof-ui && cd bulletproof-ui && npm install
node src/cli.ts init --repo /path/to/your/next-app
```

`init` adds the hooks to that repo's `.claude/settings.local.json` (never
committed) and downloads a headless Chromium. Then use Claude Code in that repo
as usual. To check the working tree by hand instead:

```bash
node src/cli.ts check --repo /path/to/your/next-app --base HEAD --request "what you asked for"
```

## What it checks

| Check | How | Blocks? |
|---|---|---|
| One-off sizes and colors (`text-[14px]`, `#2563eb`), inline styles, `!important` | Plain code check on the added lines | Yes |
| Plain `<button>`, `<input>`... where the app has its own component | Plain code check against `components/ui` | Yes |
| Console errors, failed requests, pages that stop loading | Real browser, new in "after" only | Yes |
| Pages that scroll sideways on a phone | Real browser | Yes |
| Looks wrong, doesn't match the app, not what was asked | Judge on before/after screenshots | When confident |
| Judgment calls | Judge | No, shown as questions |

Screenshots are taken at phone and desktop width, light and dark, with the clock
frozen, from two copies of the app: "before" (the session's start) and "after"
(the start plus only this session's edits, so other windows' work is never
blamed).

## Config

Optional, in `bulletproof.config.json` at the repo root or in
`.git/bulletproof/config.json` (what `init` writes):

```json
{
  "routes": { "/[code]": "/CS106A" },
  "mask": [".live-seat-count"],
  "maxRoutes": 6
}
```

See `src/config.ts` for every option.

## Develop

See [AGENTS.md](AGENTS.md). `npm run check` runs the typecheck and all tests.
