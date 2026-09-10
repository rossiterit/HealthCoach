# HealthCoach

One app, coaches as modules, over a shared health store. **v1 ships DietCoach.**

Build package (decisions, acceptance script, ship path):
<https://rossiter.atlassian.net/wiki/spaces/GOTK/pages/164560898> — epic GOTK-151.

## What it is

A private chat page where the owner describes what they ate in plain language. The
coach interviews them once to establish goals, logs meals as they are mentioned,
echoes back what it recorded so a misread is visible and correctable by reply, and
sends exactly one check-in a day over Telegram.

FitnessCoach is deferred, but the store already carries the `workouts`, `weight`
and `energy` tables it will need, so it can be added without a migration. Glorian
is the eventual front door; the chat page is a client of the same internal API
Glorian will use, so nothing has to be rebuilt when it arrives.

## Layout

```
server.js            HTTP service: the chat page (F1) and the internal API (F7)
lib/config.js        non-secret settings; env overrides for throwaway instances
lib/secrets.js       the only module that reads credential files
lib/store.js         the shared health store (F6) — atomic JSON, restart-safe
lib/nutrition.js     canonical nutrition shape + provenance stamping
lib/claude.js        the single door to the Claude API
lib/dietcoach.js     the DietCoach module (F2/F3/F4) — prompt, tools, tool loop
lib/telegram.js      outbound Telegram, delegating to the existing GOTK wiring
lib/checkin.js       the one daily check-in (F5) and its hard cap
bin/checkin.js       operator handle: run, rehearse, or force the check-in
public/index.html    the chat page — Paper & Ink, single self-contained document
test/run.js          the offline suite
deploy/              systemd unit and nginx location block (need root to install)
```

## Running it

```sh
npm install
npm start                 # listens on 127.0.0.1:8789
npm test                  # offline suite; boots a throwaway instance on 8899
node bin/checkin.js --dry-run   # rehearse the daily check-in, send nothing
```

Every setting has an env override, so a test instance never touches the live
port or the live store:

```sh
HEALTHCOACH_PORT=8899 HEALTHCOACH_DATA_DIR=/tmp/hc HEALTHCOACH_CHECKIN_ENABLED=0 npm start
```

## Internal API (F7)

All routes answer at both `/api/...` and `/healthcoach/api/...`, so the service
behaves the same through the nginx location block or hit directly on its port.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | liveness, counts, whether onboarding has happened |
| `POST` | `/api/chat` | one conversational turn → `{reply, logged[], corrected[]}` |
| `GET` | `/api/goals` | the goals document |
| `GET` | `/api/meals?date=&limit=` | logged meals |
| `GET` | `/api/summary?date=` | one day's totals |
| `GET` | `/api/history?limit=` | conversation, for rehydrating the page |
| `POST` | `/api/checkin/run` | run the check-in (`{force}`, `{dryRun}`) |

## Security posture

- The service binds **127.0.0.1 only**. Public access is through nginx, which
  terminates TLS and enforces the single-user Basic auth gate. The app does no
  authentication of its own — anything already on the loopback interface is
  inside the box, which is also what makes the internal API reachable for
  Glorian later without opening the public gate.
- Secrets live in owner-only (`0600`) files outside the repo. `config.json`
  carries their **paths**, never their values. `lib/secrets.js` is the only
  module that reads them; it never caches, logs, or returns them anywhere they
  could surface, and redacts them out of any error string.
- The coach has three tools — `log_meal`, `correct_meal`, `save_goals` — and all
  three write to its own store. There is no tool for reading or writing files,
  running commands, calling other services, or editing its own prompt. That
  absence is structural, not a setting. Adding a fourth is an owner change-control
  decision.
- Kill switch: `systemctl stop healthcoach` is a full halt. Only the owner restarts.

## Nutrition figures are estimates

Decision 10 of the build package named SnapCalorie's `/analysis` endpoint as the
nutrition engine, with an explicit fallback to Claude's estimate flagged as an
estimate. **The owner descoped SnapCalorie on 2026-09-10**, so v1 runs entirely
on that fallback: every figure is the model's estimate, stamped `source:
"claude-estimate"`, `estimate: true`, and badged as *estimated* in the UI.

The payload shape and the provenance stamp exist precisely so a real engine can
be introduced later without a schema migration, and so rows logged today stay
honest about where their numbers came from. See GOTK-156, which remains open.
