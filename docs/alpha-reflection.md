# Bulletproof alpha: reflection on building with AI tools

## What worked

I wrote a detailed tech spec before building anything. It had the hook format for each agent, the judge contract, the review server endpoints, and pinned versions for every library. When I told Claude to start building, it didn't need to ask me anything about architecture, and every version I'd pinned (Playwright 1.64, pixelmatch 8, Zod 4, Vitest 5, TypeScript 7) existed on npm. I think writing the spec really helped make this go smoothly.

The judge is better than I expected. On the fixture app, I gave it a sloppy change (a "Details" link jammed next to a button, a one-off 13px font). It came back with three specific problems in 13 seconds for about $0.06: the link crowding the button, the tiny low-contrast tap target in dark mode, and a not-asked-for font size change. On Stanford Root, it also caught something I would have caught myself. The help button now overlapped a heading on the phone, and it said that came from the page shifting down, not from the change itself.

The full loop also works with a real agent. On the fixture app, I asked a headless Claude session for a quick "New" pill badge. Bulletproof blocked it three times for real layout problems (the title wrapping, then the pill dropping to its own line, then crowding the units line), Claude fixed each one, and the fourth check passed. Every check took about 30 seconds.

## What failed

Almost none of the real bugs were caught by the typecheck or by reading the code. They showed up only when it ran: macOS's /var vs /private/var symlink made route detection find zero pages, sharp crops before it composites so the diff images crashed, the claude CLI rejected the $schema line Zod adds, and an open stdin made the judge wait. There was also an intermittent 404 that came from two dev servers racing for the same port. The rule of "run it end to end the way a user would" mattered most here.

The biggest failure was one the tests didn't catch. When I dogfooded on Stanford Root, the agent made every edit with python heredocs in Bash instead of the Edit tool. Bulletproof only recorded Edit/Write, so it saw no edits and let a real UI change pass without checking anything, which is the problem Bulletproof is supposed to catch. It only showed up because I tested on my real setup and not just the fixture. Bulletproof now checks the files before and after every Bash command and records whatever changed, and that has its own tests.

With that fixed, Stanford Root turned up two more problems the fixture app couldn't. First, Bulletproof blocked a change to the feedback dialog because Stanford Root's evaluations API returned a 500 once on the course page. This was not related to the change, the live data was just a bit flaky. Second, the dialog is on every page, so the check had to take 48 screenshots one at a time (6 pages, 4 viewport/theme combos, before and after), and it ran out of time on about half of them. It labeled those "not checked" instead of passing them, which is technically intended, but not super useful if there are many, many skips. A failure now has to happen again on a second load before it counts, and each page is shot at every viewport and theme at once.

Another demo encountered some false alarms. I asked the agent for a "Full" pill on Stanford Root's course cards, and Bulletproof blocked it three rounds in a row for things that weren't wrong. It read JavaScript's `!hasOpenSeat(...)` as Tailwind's `!important`, and it blamed a `text-[15px]` that was already in the file just because the agent re-wrapped that line. The agent's final message correctly explained why both were wrong, and it didn't make the unrelated change. Both cases are tests now, and the same change passes in 38 seconds with just one fair question from the judge (the pill is too faint in light mode).

The e2e tests found another bypass. Phone emulation zooms out to fit wide content, so a page that scrolls sideways reported zero overflow. Bulletproof now compares against the device width.

## Surprises

Even after Bulletproof had checked every viewport, the agent still told me "I haven't rendered it, so how it looks is unverified". The pass message goes to me, not to the agent, so it never knows it was verified. Probably needs to be fixed.

Cost and speed were not where I expected. The model is the cheap, fast part (about 13 seconds and 4 to 6 cents). Most of the 109 seconds on Stanford Root goes to copying the app (about 21s) and starting two dev servers (about 55s), which is probably something to look into.

## What I'd do differently

I'd dogfood on my real app on day one instead of after the fixture worked, since that's where the worst bug was hiding. I'd also start the replay set of my past UI complaints earlier. Right now, I can say the judge seems right, but I can't put a number on it yet in terms of effectiveness/cost.
