# Bulletproof alpha: reflection on building with AI tools

I built the alpha almost entirely with Claude Code, and the thing it builds is a gate for Claude Code. So I got to see AI tools from both sides this milestone: as the tool writing the code, and as the agent being checked.

## What worked

The tech spec turned out to be the best prompt I wrote all quarter. It already had the hook format for each agent, the judge contract, the review server endpoints, and pinned versions for every library. When I said "Yes, start building", Claude had enough to go on without asking me anything about architecture, and every version I'd pinned in the spec (Playwright 1.64, pixelmatch 8, Zod 4, Vitest 5, TypeScript 7) actually existed on npm. I think writing the spec for the staff and for the agent at the same time is why it worked. The AGENTS.md in the repo is basically the spec's "agent readiness" section made real.

The judge is better than I expected. On the fixture app, I gave it a sloppy change (a "Details" link jammed next to a button, a one-off 13px font). It came back with three specific problems in 13 seconds for about $0.06: the link crowding the button, the tiny low-contrast tap target in dark mode, and a font size change nobody asked for. On Stanford Root it also made a call I would have made myself. It noticed the fixed help button now overlapped a heading on the phone and said that came from the page shifting down, not from the change.

The full loop also works with a real agent. On the fixture app, I asked a headless Claude session for a quick "New" pill badge. Bulletproof blocked it three times for real layout problems (the title wrapping, then the pill dropping to its own line, then crowding the units line), Claude fixed each one, and the fourth check passed. Every check took about 30 seconds.

## What failed

Almost none of the real bugs were caught by the typecheck or by reading the code. They showed up only when the thing actually ran: macOS's /var vs /private/var symlink made route detection find zero pages, sharp crops before it composites so the diff images crashed, the claude CLI rejected the $schema line Zod adds, and an open stdin made the judge wait. There was also an intermittent 404 that came from two dev servers racing for the same port. My rule of "run it end to end the way a user would" mattered way more than any code review here.

The biggest failure was one the tests didn't catch. When I dogfooded on Stanford Root, the agent made every edit with python heredocs in Bash instead of the Edit tool. Bulletproof only recorded Edit/Write, so it saw no edits and let a real UI change pass without checking anything. That's exactly the "says done without checking" problem the project exists to fix, happening inside the fix. It only showed up because I tested on my real setup and not just the fixture. Bulletproof now brackets every Bash command and credits whatever files changed to the session, and that has its own tests.

With that fixed, the real app showed two more problems the fixture never could. First, Bulletproof blocked a change to the feedback dialog because Stanford Root's evaluations API returned a 500 once on the course page. That had nothing to do with the change, it's just live data being flaky. Second, the dialog is on every page, so the check had to shoot 6 pages × 4 viewport/theme combos × 2 copies one at a time, and it ran out of time on about half of them. It labeled those "not checked" instead of passing them, which is what I wanted, but a check that skips half the app isn't useful. A failure now has to happen again on a second load before it counts, and each page is shot at every viewport and theme at once.

The e2e tests found another bypass. Phone emulation zooms out to fit wide content, so a page that scrolls sideways reported zero overflow. Bulletproof now compares against the device width.

## Surprises

The agent being checked still told me "I haven't rendered it, so how it looks is unverified", even after Bulletproof had checked it on every viewport. The pass message goes to me, not to the agent, so it never knows it was verified. I probably want to change that.

My own guardrails got in the way. A hook in my global setup blocks `git add -A`, and it stopped Claude while it was setting up a throwaway test repo. It was annoying in the moment, but it's the same idea as Bulletproof: a hook that steers the agent better than any instruction does.

Cost and speed were not where I expected. The model is the cheap, fast part (about 13 seconds and 4 to 6 cents). Most of the 109 seconds on Stanford Root goes to copying the app (about 21s) and starting two dev servers (about 55s). That's where the next round of speed work goes.

I also lost my early planning files. idea.md and the proposal drafts were deleted from the project folder at some point and the old transcripts got cleaned up, so the only surviving copies were the PDFs on Gradescope. Next time the planning docs go in the repo from day one.

## What I'd do differently

I'd dogfood on my real app on day one instead of after the fixture worked, since that's where the worst bug was hiding. I'd also start the replay set of my past UI complaints earlier. Right now I can say the judge seems right, but I can't put a number on it yet.
