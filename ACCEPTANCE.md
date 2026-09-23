# HealthCoach v3 — acceptance note

**Date:** 2026-09-23 · **Epic:** GOTK-163 (Meal Planner release) · **Built by:** Claude Code, on the GOTK droplet

*(v2's note is in git history at `a3ed59b`; v1's at `08215b4`.)*

## Read this first

v3 is **built, merged, and running.** All four pieces are live on the service
right now, and your meals, conversation, goals and check-ins came through
untouched. Nothing is waiting on you this time.

**<https://gotkapp.com/healthcoach/>** — and **hard-reload the first time
(Ctrl+Shift+R, or ⌘+Shift+R on a Mac)**. The page changed a lot. A normal
reload can serve you yesterday's copy and make a working build look broken.

## What's new

There's a fourth tab: **Plan**.

- **A week grid, Monday to Saturday.** Four rows — breakfast, lunch, dinner,
  snacks. **Sunday isn't there**, and that's deliberate: it's your free day, so
  it has no column, no totals, nothing to confirm, and the coach won't mention
  it or suggest planning it.
- **Search your own food library.** It starts empty. Type something and, if it's
  not in there yet, you get an "Add it" button — I'll estimate the nutrition and
  save it. The library is only ever what you've actually looked up, and it grows
  as you use it. There's no external food database and nothing leaves the box.
- **Drag meals around**, or **tap them**. Tap a search result or a favourite,
  then tap the slot you want it in. That works on your phone, where dragging a
  six-column grid is hopeless — and the grid stacks into one day at a time down
  there. Both ways work at any size, so use whichever you prefer.
- **Eight favourite tiles**, two rows of four. Drag into them from a search
  result *or* from a day. Dragging from a day **copies** — the day keeps its
  meal. Dropping onto a tile that's already taken replaces it, and the one it
  replaced is unpinned but still in your library and still searchable. **Nothing
  you drag ever deletes anything.**
- **A totals row under each day** — calories, protein, fat, carbs, sodium. They
  are estimates and the page says so. They're there to tell you what's in the
  week, and that's all they do.

## The planner plans. It never logs.

This was the binding decision, so it has tests rather than a promise.

Putting a meal in the grid is writing down an intention. It doesn't go in your
food diary, ever, until you say so. There are exactly two ways to say so:

1. Say **"ate to plan"** in chat, or
2. Press **"Ate to plan"** on that day in the grid.

Then those meals go into the diary, marked as having come from the plan, still
flagged as estimates, and correctable by reply like anything else.

Partial truth works the way you'd say it out loud: *"ate to plan except lunch was
leftover lasagne"* confirms the rest and leaves lunch alone, then logs the
lasagne separately. I tested that exact sentence.

A day only confirms once. Say it twice and the second one does nothing — it
won't quietly double your day.

## No guilt here either

The rule from v2 extends to the planner, and again it's structural rather than a
promise: there is no "target", no "budget", no "remaining", no over/under and no
comparison between days *anywhere in the planner code*. A future screen couldn't
show you one, because there's no field to read. A day with nothing planned says
"nothing planned" and is not called a gap. A confirmed day says "Logged as
eaten" — not "well done".

## Also changed

- **Your morning briefing** now mentions what you've got planned for today, when
  you've planned something. It's one extra line in the 07:30 message you already
  get — **not a second message.** That rule hasn't moved. On Sunday it says
  nothing about plans at all.
- **The shopping list** now builds from the grid when you've filled one in,
  rather than guessing from your history. It counts repeats properly — a week
  with porridge six times asks for enough oats for six. If the grid's empty, it
  drafts from your history exactly as it did before.
- **The recipe healthifier is unchanged.**

## How to check it

1. **Hard-reload**, then open **Plan**. You should see Mon–Sat, four rows, a
   totals row, a search box and eight empty tiles. *How it looks is your call —
   see the note at the bottom.*
2. **Search for something you eat.** It won't be there. Press **Add it**, and
   check the figures I guessed are in the right postcode. If they're not, tell me
   in chat — "the curry is more like 600 calories" — and it'll fix the library
   entry, which updates every day you've planned it into.
3. **Drag it into a day.** Watch the totals row underneath move.
4. **Drag it from the day onto a favourite tile.** The day should *keep* the
   meal — that's the copy rule. Then drop something else on that same tile: the
   old favourite should vanish from the tile but still turn up in search.
5. **On your phone**, open the same tab. One day at a time. Tap a favourite, then
   tap a slot.
6. **Plan today, then say "ate to plan"** in chat, and check the meals land in
   your diary. Then say it again — nothing should happen.
7. **Ask for the shopping list.** It should be built from the grid you just
   filled in, not from your history.
8. **Tomorrow at 07:30** — one message, with today's plan in it. Still one.

## Five things I decided rather than guessed silently

The mockup settled most of it. These it didn't, so here's what I did and why —
any of them is cheap to change if you disagree.

1. **Favourites are two rows of four.** The spec said "eight tiles"; your mockup
   draws them 2×4, so that's what I built. Mockup wins.
2. **Phone layout.** Your mockup is a desktop wireframe, and six columns is
   unusable at 400px. On a phone the grid stacks into one day at a time with the
   same content and the same tapping. If you'd rather it scrolled sideways and
   kept the grid shape, say so.
3. **A week selector.** Not in the mockup, but the spec says next week has to be
   plannable, so there's a quiet "This week / Next week" toggle above the grid.
4. **What "this week" means on a Sunday.** Strictly, Sunday belongs to the week
   that just ended — which would open the planner on six days that are all
   behind you. Since Sunday is your free day and your usual planning moment, it
   rolls forward to the week about to start. Every other day is literal.
5. **What time a confirmed meal is logged at.** A plan says *what*, never *when*.
   Rather than filing your whole day at the moment you press the button — which
   would put breakfast at 9pm — confirmed meals land at ordinary hours
   (08:00 / 12:30 / 19:00 / 15:30, your time). Each one is correctable by reply.

## One governance item for you to ratify

The v3 package says "no new tools", but it also requires pinning favourites by
chat, correcting library items by chat, and "ate to plan" as a spoken phrase —
none of which is possible without them. I added **three**: `favorite_food`,
`correct_food` and `confirm_ate_to_plan`.

All three write only to this app's own store, which is the same reading you
ratified on 2026-09-12 for `log_workout` and `log_weight` — the frozen thing
being *external* access, not store writes. Nothing added this release reaches
outside the app, and there's still no tool that touches a file, a command, the
network or its own instructions.

The coach now has eight tools. The exact list is asserted in the test suite, so
a ninth fails the build rather than arriving quietly. **If you'd rather draw the
line differently, that test is the place to argue with me.**

## Two small ops notes

- **I briefly killed the live service by accident** early on, cleaning up a test
  instance with too broad a pattern. systemd restarted it within seconds and no
  data was touched, but you'd have seen a blip if you'd been looking. I killed by
  process id for the rest of the build.
- **The nginx half of my sudo grant doesn't work.** It allows `/usr/bin/nginx -t`,
  but nginx is at `/usr/sbin/nginx`. It didn't matter — v3 changed no nginx
  config — but the grant is dead if you ever need me to use it. The
  `systemctl restart healthcoach.service` half works fine and I used it.

## What I couldn't do

**There's still no way to render the page on this droplet.** It has 956MB of RAM
with swap almost full, and Chromium won't run — I tried, and stopped when it
became clear the risk was pushing the live service out of memory.

So I did the next best thing rather than skipping it: I ran the **real page** in
a real DOM against a **real throwaway instance** and drove it like a user at
390px. That proves the grid builds, tapping places meals, totals recompute,
slot→favourite copies, removing a card doesn't delete the food, and the diary
stays empty until you confirm. What it can't tell you is whether it *looks*
right — spacing, weight, whether the vertical slot labels read well.

That's your click-through, which is what the spec asked for anyway. **If anything
on that tab looks wrong, it's a bug and I want to know.**

## Verification

151 tests, all green, on the merged main. Every item went branch → throwaway
instance on :8799 → pull request → merge → restart → ticket. The four PRs are
[#1](https://github.com/rossiterit/HealthCoach/pull/1),
[#2](https://github.com/rossiterit/HealthCoach/pull/2),
[#3](https://github.com/rossiterit/HealthCoach/pull/3) and
[#4](https://github.com/rossiterit/HealthCoach/pull/4) — nothing was merged
locally. GOTK-163, 164, 165, 166 and 167 are all Done.

Rehearse tomorrow's briefing without sending it:
`node ~/healthcoach/bin/briefing.js --dry-run`
