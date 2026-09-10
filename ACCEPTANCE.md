# HealthCoach v1 — acceptance note

**Date:** 2026-09-10 · **Epic:** GOTK-151 · **Built by:** Claude Code, on the GOTK droplet

## Read this first

The app is **built and tested but not shipped**. Nothing is running, nothing is
reachable, and no ticket has been flipped to Done — because three things are in
the way that only you can clear. They are listed at the bottom.

GOTK-152/153/154/155 are **In Progress**. GOTK-156 is **To Do** (you descoped it).

## What changed

Everything is new, in `~/healthcoach`. Nothing existing was touched — the Keep
(`:8788`), the MCP server (`:8787`) and uatbot are all still running untouched,
and the new app's port `:8789` is currently free because nothing is installed.

Five pieces, one per ticket, each on its own branch merged to `main`:

| Ticket | What it is |
|---|---|
| GOTK-152 | The service, the shared health store, and the internal API |
| GOTK-154 | DietCoach — the onboarding interview, meal logging, coaching replies |
| GOTK-153 | The chat page, Paper & Ink, behind an nginx Basic gate |
| GOTK-155 | The one-a-day Telegram check-in |
| GOTK-156 | **Not built.** SnapCalorie, descoped by you |

The store already has `workouts`, `weight` and `energy` tables sitting empty, so
FitnessCoach can be added later without anyone having to migrate your data.

## How to check each item, once it's running

The URL will be **<https://gotkapp.com/healthcoach/>** — and **hard-reload it the
first time (Ctrl+Shift+R)**, because a normal reload can serve you a stale page
and make a good build look broken.

1. **The page loads and asks for a password.** Paper & Ink styling — warm paper,
   dark header, serif headings. *This one is yours to judge; I could not render
   it and a test cannot see layout.*
2. **The first thing you say starts an interview.** It should ask about what you
   want and how you eat now, not launch into advice. Then `systemctl restart
   healthcoach` and reload — your goals should still be there.
3. **Describe a meal in plain language.** It should log it and show you a card
   with the items and the numbers, badged *estimated*. Then reply "that was a
   small one" — the card should change, not a second one appear.
4. **The check-in arrives once, at 20:00.** Brief, mentions something you
   actually ate yesterday, asks one question, links back to the page. It should
   never arrive twice.
5. **Restart the service.** History, goals and logs all intact.

To rehearse the check-in copy without sending anything:
`node ~/healthcoach/bin/checkin.js --dry-run`

## What I could and couldn't verify

**Verified:** 34/34 offline tests on `main` — the store survives restarts, a
correction revises a row rather than duplicating it, the check-in cannot fire
twice, secrets are scrubbed from error strings, the service binds loopback only,
and the API answers correctly. Telegram delivery is verified live: Telegram
returned `message_id 503` for a real message to your chat.

**Not verified:** anything the coach actually *says* — the interview, how it
reads a meal, its tone, the check-in copy. That needs the API, and the API is
blocked (below). Also the look of the page: Chrome will not complete a render on
this host, so there is no screenshot. That one was always your click-through.

## The nutrition numbers are estimates

You descoped SnapCalorie, so every figure is the model's own estimate. That is
the fallback the build package already specified, not something invented to
paper over the gap — but it means the numbers are a guide, not a measurement,
and the app says so on every card. GOTK-156 stays open if you want to revisit it.

## Three blockers — all need you

1. **I have no root.** `sudo` on this box grants me exactly one unrelated
   command, so I cannot install the service, add the nginx block, or create the
   password file. The unit and the nginx config are written and waiting in
   `deploy/`. You said you'd grant scoped sudo; it isn't in place yet.
2. **The Anthropic account has no credit.** Every model call returns a billing
   error, which is why the coach is unverified. Worth knowing separately: this
   is also breaking your existing GOTK heartbeat, Sunday digest, and dashboard
   AI features — they use the same key.
3. **The GitHub token can't create repositories,** and there's no deploy key for
   a `healthcoach` repo, so the code is committed locally but has nowhere to
   push. The history is clean and will push as-is once the repo exists.

Clear (1) and (2) and the app can go live and be checked properly. (3) only
affects backup and review, not whether it runs.
