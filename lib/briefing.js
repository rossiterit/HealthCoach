'use strict';
/**
 * briefing.js — the one daily touch (F1, GOTK-158).
 *
 * Replaces v1's evening check-in. This is a CHANGE-CONTROL change to a standing
 * rule, recorded in the v2 build package as Decision 1: the daily touch moves to
 * the morning and becomes the day's briefing. What has NOT changed, and is
 * re-affirmed rather than relaxed, is that there is exactly ONE outbound message
 * per day. The 20:00 send is retired, not supplemented — evening reflection now
 * lives on the page for whenever the owner opens it.
 *
 * THE CAP, carried over from v1 unchanged and for the same reason. The day's
 * slot is claimed BEFORE the message is sent, not after. If it were the other
 * way round, a crash between "Telegram accepted it" and "we wrote it down"
 * would leave no record and the next run would send a second briefing. Claiming
 * first makes the failure mode a missed briefing rather than a duplicate one —
 * the right way round when the standing rule is never to nag. The store is the
 * cap, not the scheduler, so it holds however the run is triggered and survives
 * a restart.
 *
 * CONTENT, in the order Decision 2 fixes:
 *   1. today's stretch routine, one line
 *   2. ONE workout suggestion, from the menu, already chosen by workouts.js
 *   3. yesterday's food, one line
 * then, occasionally and never more than one of each:
 *   - the weight trend, at most weekly (F5) — tracked on the briefing row rather
 *     than by weekday, so "at most weekly" stays true even if a day is missed
 *   - on Sunday, one line of what movement actually happened that week (F4)
 * and at most ONE question.
 *
 * The storage field is still `checkins` — v1 data lives there and a rename would
 * mean a migration for no behavioural gain.
 */
const { localDate } = require('./store');
const claude = require('./claude');
const coach = require('./coach');
const dietcoach = require('./dietcoach');
const nutrition = require('./nutrition');
const stretch = require('./stretch');
const workouts = require('./workouts');
const weight = require('./weight');
const telegram = require('./telegram');

/** The timezone the SEND time is measured in — explicit this release. */
function zone(cfg) {
  return (cfg.briefing && cfg.briefing.timezone) || cfg.timezone;
}

/** Configured send time as {hour, minute}. Accepts "07:30". */
function sendTime(cfg) {
  const raw = String((cfg.briefing && cfg.briefing.time) || '07:30');
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return { hour: 7, minute: 30 };
  return { hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) };
}

/** Local wall-clock {hour, minute} in the briefing timezone. */
function localClock(cfg, now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone(cfg),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { hour: get('hour'), minute: get('minute') };
}

/**
 * True if the configured send time has arrived and today's briefing has not gone
 * out. The store is still the real cap; this only decides when to wake up.
 */
function isDue(store, cfg, now = new Date()) {
  if (!cfg.briefing.enabled) return false;
  const date = localDate(now, zone(cfg));
  if (store.checkinOnDate(date)) return false;
  const { hour, minute } = localClock(cfg, now);
  const t = sendTime(cfg);
  return hour > t.hour || (hour === t.hour && minute >= t.minute);
}

/** Has the weight trend been mentioned in a briefing within the last 7 days? */
function weightMentionedRecently(store, cfg, now) {
  const cutoff = new Date(now.getTime() - 7 * 86400000);
  return store.data.checkins.some((c) => c.includedWeight && new Date(c.sentAt || c.date) >= cutoff);
}

/**
 * Assemble the facts for today's briefing. Pure and exported so the ordering and
 * the inclusion rules can be tested without a model call.
 */
function assemble(store, cfg, now = new Date()) {
  const tz = zone(cfg);
  const today = localDate(now, tz);
  const yesterday = localDate(new Date(now.getTime() - 86400000), tz);

  const meals = store.mealsOnDate(yesterday, tz);
  const foodLine = meals.length
    ? `${meals.map((m) => m.description).join('; ')} — ${
        dietcoach.fmtNutrition(nutrition.total(meals.map((m) => ({ nutrition: m.nutrition })))) || 'no figures'
      }, estimated.`
    : 'Nothing logged yesterday.';

  const pick = workouts.suggest(store, cfg, now);
  const dow = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'long' }).format(now);

  const includeWeight =
    store.data.weight.length > 0 && !weightMentionedRecently(store, cfg, now);
  const includeWeek = dow === 'Sunday';

  return {
    date: today,
    yesterday,
    dayOfWeek: dow,
    stretchLine: stretch.briefingLine(),
    suggestion: pick,
    foodLine,
    weightLine: includeWeight ? weight.line(store, cfg, 7, now) : null,
    weekLine: includeWeek ? workouts.summaryLine(store, cfg, 7, now) : null,
    includedWeight: includeWeight,
  };
}

/**
 * Write the briefing. No tools are passed, so a scheduled message cannot write
 * to the store — a message the owner did not ask for must not have side effects.
 */
async function compose(store, cfg, now = new Date()) {
  const f = assemble(store, cfg, now);

  const extras = [
    f.weightLine ? `- Weight, worth a mention today (you have not raised it in a week): ${f.weightLine}` : null,
    f.weekLine ? `- It is Sunday, so one line on what movement actually happened: ${f.weekLine}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const instruction = `
WRITE THE MORNING BRIEFING.
This is your one unprompted message of the day, sent by Telegram at ${
    (cfg.briefing && cfg.briefing.time) || '07:30'
  } their time. They are not in the app and may never reply. It is ${f.dayOfWeek} morning.

Cover these, in this order, and nothing else:

1. TODAY'S STRETCH — ${f.stretchLine}
2. ONE WORKOUT SUGGESTION — ${f.suggestion.outlet.label}. The reason it fits: ${f.suggestion.reason}${
    f.suggestion.tradeDown ? ` If it is not happening, ${f.suggestion.tradeDown.label} counts just the same.` : ''
  }
3. YESTERDAY'S FOOD, ONE LINE — ${f.foodLine}
${extras}

Rules for this message specifically:
- Short. A few lines. They are reading it on a phone before the day starts.
- Offer the workout, do not assign it. Nothing is scheduled and nothing is owed.
- At most ONE question, and only if you actually want the answer. No question at all is fine.
- If nothing was logged yesterday, say so lightly and move on. It is not a failure and must not be framed as one. Do not ask why.
- No greeting boilerplate, no sign-off, no emoji, no headers, no bullet-point list. Write it as a person would text it.
- Never mention streaks, days in a row, days missed, or how long it has been since anything.

Write only the message itself.`;

  const system = coach.buildSystem(store, cfg, instruction);
  const res = await claude.complete(cfg, {
    system,
    messages: [{ role: 'user', content: "Write this morning's briefing." }],
  });
  return { text: claude.textOf(res), facts: f };
}

/**
 * Send today's briefing if it has not gone out yet.
 *
 * @param {{force?: boolean, dryRun?: boolean}} opts
 * @returns {Promise<object>} {status, date, text?, messageId?, error?}
 */
async function run(store, cfg, opts = {}) {
  const date = localDate(new Date(), zone(cfg));

  // A dry run sends nothing and claims nothing, so neither the enabled flag nor
  // the once-a-day cap should stand in its way — rehearsing the copy on a
  // disabled instance is exactly what `--dry-run` is for.
  if (!opts.dryRun) {
    if (!cfg.briefing.enabled && !opts.force) return { status: 'disabled', date };
    const existing = store.checkinOnDate(date);
    if (existing && !opts.force) return { status: 'already-sent', date, sentAt: existing.sentAt };
  }

  const { text, facts } = await module.exports.compose(store, cfg);
  if (!text || !text.trim()) {
    return { status: 'error', date, error: 'The coach returned an empty briefing; nothing sent.' };
  }

  const body = `${text.trim()}\n\n${cfg.publicUrl}`;
  if (opts.dryRun) return { status: 'dry-run', date, text: body, facts };

  // Claim the day first — see the note at the top of this file.
  const row = store.addCheckin(date, body, false);
  row.includedWeight = facts.includedWeight;

  try {
    const messageId = await telegram.send(cfg, body, 'notable');
    row.ok = true;
    row.messageId = messageId;
    await store.save();
    return { status: 'sent', date, text: body, messageId, facts };
  } catch (e) {
    row.ok = false;
    row.error = e.message;
    await store.save();
    return { status: 'error', date, text: body, error: e.message };
  }
}

module.exports = { run, isDue, compose, assemble, sendTime, zone, localClock };
