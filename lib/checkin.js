'use strict';
/**
 * checkin.js — the one daily check-in (F5).
 *
 * "One daily check-in. Never more, per the no-nagging rule." That sentence is
 * the whole design brief, and it drives the one non-obvious decision here:
 *
 *   The day's slot is claimed BEFORE the message is sent, not after.
 *
 * If we recorded the send afterwards, a crash or a timeout between "Telegram
 * accepted it" and "we wrote it down" would leave no record, and the next run
 * would send a second check-in. Claiming first makes the failure mode a missed
 * check-in instead of a duplicate one — which is the right way round when the
 * standing rule is never to nag. A failed send is reported, and left for
 * tomorrow rather than retried today.
 *
 * The store is the cap, not the scheduler. That means the cap holds however the
 * run is triggered — timer, manual API call, or a second scheduler someone adds
 * later — and it survives a restart.
 */
const { localDate } = require('./store');
const claude = require('./claude');
const coach = require('./coach');
const dietcoach = require('./dietcoach');
const nutrition = require('./nutrition');
const telegram = require('./telegram');

/**
 * Run today's check-in if it has not gone out yet.
 *
 * @param {Store} store
 * @param {object} cfg
 * @param {{force?: boolean, dryRun?: boolean}} opts
 *   force  — bypass the once-a-day cap (operator escape hatch; still recorded)
 *   dryRun — compose and return the text, send nothing, claim no slot
 * @returns {Promise<object>} {status, date, text?, messageId?, error?}
 */
async function run(store, cfg, opts = {}) {
  const date = localDate(new Date(), cfg.timezone);

  if (!cfg.checkin.enabled && !opts.force) {
    return { status: 'disabled', date };
  }

  const existing = store.checkinOnDate(date);
  if (existing && !opts.force) {
    return { status: 'already-sent', date, sentAt: existing.sentAt };
  }

  const text = await module.exports.compose(store, cfg);
  if (!text || !text.trim()) {
    return { status: 'error', date, error: 'The coach returned an empty check-in; nothing sent.' };
  }

  const body = `${text.trim()}\n\n${cfg.publicUrl}`;

  if (opts.dryRun) {
    return { status: 'dry-run', date, text: body };
  }

  // Claim the day first — see the note at the top of this file.
  const row = store.addCheckin(date, body, false);

  try {
    const messageId = await telegram.send(cfg, body, 'notable');
    row.ok = true;
    row.messageId = messageId;
    await store.save();
    return { status: 'sent', date, text: body, messageId };
  } catch (e) {
    row.ok = false;
    row.error = e.message;
    await store.save();
    return { status: 'error', date, text: body, error: e.message };
  }
}

/**
 * True if the configured local check-in hour has arrived and today's has not
 * gone out. The timer calls this every hour; the store is still the real cap.
 */
function isDue(store, cfg, now = new Date()) {
  if (!cfg.checkin.enabled) return false;
  const date = localDate(now, cfg.timezone);
  if (store.checkinOnDate(date)) return false;
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: cfg.timezone,
      hour: '2-digit',
      hour12: false,
    }).format(now)
  );
  return hour >= cfg.checkin.hourLocal;
}

/**
 * Compose the check-in. No tools are passed, so this call cannot write to the
 * store — a scheduled message must never have side effects the owner did not ask
 * for. Exported on module.exports so run() calls it through the export and tests
 * can substitute it without a live model.
 */
async function compose(store, cfg) {
  const now = new Date();
  const yesterday = localDate(new Date(now.getTime() - 24 * 3600 * 1000), cfg.timezone);
  const meals = store.mealsOnDate(yesterday, cfg.timezone);

  const record = meals.length
    ? meals
        .map((m) => `  - ${m.mealType}: ${m.description} — ${dietcoach.fmtNutrition(m.nutrition) || 'no figures'}`)
        .join('\n')
    : '  (nothing logged)';

  const sum = meals.length
    ? dietcoach.fmtNutrition(nutrition.total(meals.map((m) => ({ nutrition: m.nutrition }))))
    : '';

  const instruction = `
WRITE THE DAILY CHECK-IN.
This is your one unprompted message of the day, delivered by Telegram. It is not a chat turn — they are not in the app, and they may not reply.

Yesterday was ${yesterday}. Their log for that day:
${record}
${sum ? `Day total (estimated): ${sum}` : ''}

Write two or three short sentences, maximum. Reference something real and specific from that log — if there is nothing logged, say so lightly and without any hint of reproach, and do not imply they have failed at anything. End with exactly one question worth answering.

No greeting boilerplate, no sign-off, no emoji, no bullet points. Plain sentences. Write only the message itself.`;

  const system = coach.buildSystem(store, cfg, instruction);
  const res = await claude.complete(cfg, {
    system,
    messages: [{ role: 'user', content: 'Write today\u2019s check-in.' }],
  });
  return claude.textOf(res);
}

module.exports = { run, isDue, compose };
