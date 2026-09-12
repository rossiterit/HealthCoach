# HealthCoach v2 — acceptance note

**Date:** 2026-09-12 · **Epic:** GOTK-157 (FitnessCoach release) · **Built by:** Claude Code, on the GOTK droplet

*(v1's acceptance note is in git history at `08215b4` if you need it.)*

## Read this first

v2 is **written, tested and merged to main — but not running yet.** The service
on the droplet is still v1. One `systemctl restart healthcoach` makes it real,
and I don't have that privilege. Nothing is marked Done until it's actually live.

**A restart right now is safe.** v1 already sent tonight's 20:00 check-in, so
nothing will double-send. Your first morning briefing lands tomorrow at 07:30
Denver, and that's the last you'll hear from it each day.

## What changed

Everything is new behaviour in the app you already have. Your data is untouched —
the meals, goals and conversation from v1 are all still there, and the workouts,
weight and energy tables that v1 left empty are now the ones v2 fills.

- **A stretch routine.** Ten minutes for hips and pelvis, eight movements, on its
  own tab. The coach can talk you through any of it and explain why each one is
  in there. It's general mobility, not physiotherapy — if you tell it something
  *hurts* rather than feels tight, it will send you to a physio rather than
  invent a workaround. I tested that specifically.
- **A workout menu — never a calendar.** Each morning it offers one thing from
  your actual outlets: Koko, home weights, the stationary bike, the commuter
  bike, the dogs. Nothing is ever scheduled onto a date and nothing is owed.
- **Walking the dogs counts.** Every time, logged exactly like an hour at Koko.
  Not "at least you walked the dogs" — it moved, so you moved.
- **Weight, in pounds.** Say "I'm at 212" and it records it flatly. The Trend tab
  shows 7 and 30 day shape. No verdicts, no target unless you ask for one, and
  the line is plain ink — nothing turns green when you lose and red when you gain.
- **The daily message moves to the morning.** 07:30 Denver, containing the
  stretch, one workout suggestion, and yesterday's food in a line. The 20:00
  check-in is gone. Still exactly one message a day, and that rule hasn't moved.
- **Weekly meal plans.** Ask any time, or take the card that appears on the page
  on Sundays. Built from what you've actually been eating, with a shopping list.
  Paste any recipe and it'll hand back a healthier version you can cook straight
  from, and tell you what it changed.

## No streaks. Anywhere.

This was the binding rule, so it got tests rather than a promise. The coach is
forbidden from streaks, chains, consecutive-day counts and counting missed days,
and the test suite scans the page, the routine and the prompts for that language.
The ledger doesn't even store a field a streak could be built from.

It also can't justify a suggestion by how long it's been — "you haven't been on
the bike in nine days" is the same thing in a friendlier voice, so the code
physically can't produce that sentence.

I tried to make it shame me. Asked *"how many days have I missed?"*, it said:

> That's not a number I keep, and I wouldn't want to — days off aren't a thing
> this app tracks against you. Today stands on its own.

## How to check it, once it's restarted

**<https://gotkapp.com/healthcoach/>** — and **hard-reload the first time
(Ctrl+Shift+R)**. The page changed, and a normal reload can serve you the old one
and make a good build look broken.

1. **Three tabs** — Chat, Stretch, Trend. Chat is where you land.
2. **Stretch tab** — the routine reads clearly and you'd actually follow it.
   Try the short and desk variants. *Your call; I couldn't render it.*
3. **Say "I walked the dogs."** It should land as done. If it reads as
   less-than in any way, that's a bug and I want to know.
4. **Say "I'm at 212."** Flat acknowledgement. Then check the Trend tab.
   *Your call on how the line looks.*
5. **Ask for a meal plan.** It should be built from food you actually eat.
   Then paste a recipe and see what it does with it.
6. **Tomorrow at 07:30** — one message, stretch + one suggestion + yesterday's
   food. Nothing at 20:00.
7. **Anywhere you see a streak, a chain, or a count of missed days** — that's a
   failure of the whole release, not a detail.

Rehearse the briefing without sending: `node ~/healthcoach/bin/briefing.js --dry-run`

## Three things I asked you rather than guessed

- **Weight in pounds** (your call) — the reserved field was `kg` and had never
  been written to, so renaming it cost no data.
- **Tabs in the toolbar** (your call) for where the stretch and trend live.
- **The governance line.** The spec says "no new tools", but logging workouts and
  weight conversationally needs them. You ratified that only *external* access is
  frozen and store-writing tools are fine. The coach now has five tools, all
  writing only to its own store, and a test fails if a sixth ever appears.

## What's blocked

1. **I can't restart the service** — `sudo` still grants me one unrelated
   command. This is the only thing standing between you and v2.
2. **The GitHub token can't open pull requests.** All five branches are pushed
   and reviewable on GitHub; I merged them locally and pushed main.
3. **No renderer on this host** — Chrome won't complete a page render here, so
   there's no screenshot of the stretch page or the trend. Both were your
   click-through anyway.

Fix (1) and everything above is checkable in about five minutes.
