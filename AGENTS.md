# Bulletproof

Bulletproof keeps a coding agent working until its UI change is one the developer
would ship. When the agent says "done", it screenshots every page the change
touches, before and after, runs plain code checks and a judge model, and sends
problems back to the agent (up to 3 rounds). The design is in the tech spec; this
file is how to work on the code.

## How a check flows

1. **Session start** (`src/snapshot.ts` `takeSnapshot`): commit the working tree
   through a temporary index. Never touch the developer's files, index or stash.
2. **Edits** (`src/session.ts`, `src/hooks.ts`): each path the agent edits, with
   an edit tool or through Bash, is appended to the session's `.edits` log. Only these files go into the "after" copy, so other windows'
   edits are never checked or blamed.
3. **Stop** (`src/check.ts` `runCheck`):
   - `src/checks.ts`: plain code checks on added lines (one-off values, hard-coded
     colors, inline styles, plain elements the app wraps, `!important`).
   - `src/snapshot.ts` `materialize`: build `before/` and `after/` copies in the
     temp dir, cloning `node_modules` and `.env*` copy-on-write.
   - `src/routes.ts`: follow imports back to app-router pages.
   - `src/devserver.ts` + `src/capture.ts`: one dev server per copy; Playwright
     screenshots at each viewport and color scheme, clock frozen.
   - `src/pixeldiff.ts`: changed regions plus a before | after image per pair.
   - `src/judge.ts`: the developer's own agent CLI, headless and read-only.
4. **Gate** (`src/hooks.ts` `stop`): block with the findings, or allow with the
   review page link (`src/review.ts`).

State lives in `<git-common-dir>/bulletproof/` (sessions, runs, config), never in
the working tree.

## Rules that must not break

- **Never pass what was not checked.** Anything skipped, timed out, failed to
  load, over a limit, or not opened by the judge goes into `notChecked` with the
  reason. A new code path that can skip work must add to `notChecked`.
- **Never break the agent.** A Bulletproof crash in a hook prints a "not checked"
  message and exits 0.
- **Never touch the developer's tree.** No writes outside the state dir and the
  temp copies. Snapshot commits live under `refs/bulletproof/`.
- The judge runs with `BULLETPROOF_JUDGE=1`; every hook exits early on it.

## Hook formats

Claude Code (alpha): `bulletproof-ui hook <session-start|user-prompt-submit|pre-tool-use|post-tool-use|stop>`
reads the hook JSON on stdin. Bash commands are bracketed by pre/post-tool-use so
edits made through the shell are recorded too (agents often edit with sed or python). Stop answers `{"decision":"block","reason":...}` or
`{"systemMessage":...}`. Cursor and Codex adapters are the final milestone.

## Run and test

```bash
npm install
npm run check          # typecheck + all tests (the e2e tests take ~3 minutes)
npx vitest run test/checks.test.ts   # one file
node src/cli.ts check --repo <app> --base HEAD   # check a working tree by hand
node src/cli.ts init --repo <app>                # install the hooks in a repo
```

`fixtures/next-app` is a small Next.js app with known good and bad changes in
`test/e2e.test.ts`; run `npm install` inside it once. `test/fake-judge.mjs`
stands in for the agent CLI so tests are deterministic and free.

A new bypass (a way a bad change gets through) gets a failing test before the fix.

## Code style

- TypeScript run directly by Node 24 (type stripping): erasable syntax only, `.ts`
  extensions in imports, no enums or parameter properties.
- Zod schemas are the contracts between parts.
- Messages shown to developers or agents are plain sentences: what is wrong, then
  how to fix it.

## Do not touch

- `fixtures/next-app/node_modules`, `package-lock.json` files by hand.
- Anything under a real app's `.git/` except `bulletproof/` and `refs/bulletproof/`.
